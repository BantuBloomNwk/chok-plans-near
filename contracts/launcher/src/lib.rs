//! The launcher. It has no keys, and it deploys one token, embedded here, so a coin's code is known
//! before it exists. One call makes the coin, mints the sale supply straight into the market and the
//! dev's share straight into a plan, all in one transaction. There is no moment when the dev holds
//! their bag loose, and no way to list a coin without a plan.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

/// `contracts/token` built by `npm run build`; `npm run verify` checks it is that build.
const TOKEN: &[u8] = include_bytes!("../token.wasm");
/// Every coin is a billion tokens with six decimals, 80% on sale and 20% in the plan.
const SUPPLY: u128 = 1_000_000_000_000_000;
const SALE: u128 = SUPPLY / 5 * 4;
const GAS_INIT: Gas = Gas::from_tgas(110);
const GAS_DONE: Gas = Gas::from_tgas(10);
/// The coin's account pays for its code and state itself; a little over for its own storage.
const STATE_BYTES: u128 = 4_000;
/// Toward the plan's storage, on top of the plan's budget.
const PLAN_STORAGE: NearToken = NearToken::from_millinear(15);
/// Toward the pool's storage. The market sends back what it doesn't use.
const POOL_STORAGE: NearToken = NearToken::from_millinear(5);
const MIN_BUDGET: NearToken = NearToken::from_millinear(20);
const MAX_SECS: u64 = 315_360_000;

/// A sealed plan's judge, checked here so a launch can't get half way and stop.
#[derive(Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Sealed {
    pub commitment: String,
    pub judge_url: String,
    pub judge_hash: String,
    pub outlayer: AccountId,
    pub secrets_owner: AccountId,
    pub secrets_profile: String,
}

/// The plan's terms, the same shape the plan contract takes.
#[derive(Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Terms {
    pub holder: AccountId,
    pub cap: U128,
    pub min_cap: U128,
    pub period_secs: U64,
    pub start_in_secs: U64,
    pub notice_secs: U64,
    pub penalty_bps: u16,
    pub sealed: Option<Sealed>,
    pub loosen_allowed: bool,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Launcher {
    market: AccountId,
    plans: AccountId,
    outlayer: AccountId,
    next: u64,
}

fn coin_cost() -> u128 {
    env::storage_byte_cost().as_yoctonear() * (TOKEN.len() as u128 + STATE_BYTES)
}

#[near]
impl Launcher {
    #[init]
    pub fn new(market: AccountId, plans: AccountId, outlayer: AccountId) -> Self {
        Self { market, plans, outlayer, next: 0 }
    }

    /// What a launch takes: the coin's own storage, its plan's and its pool's, and the plan's first
    /// budget. Attach at least this; anything more goes to the plan's budget.
    pub fn launch_cost(&self) -> U128 {
        U128(coin_cost() + PLAN_STORAGE.as_yoctonear() + POOL_STORAGE.as_yoctonear() + MIN_BUDGET.as_yoctonear())
    }

    /// Make a coin with its plan. `dev` gets the releases and the 1% fee; it is whoever calls, unless
    /// they name someone else and pay for them. Returns the coin's account.
    #[payable]
    pub fn launch(&mut self, name: String, symbol: String, terms: Terms, dev: Option<AccountId>) -> AccountId {
        let name = name.trim().to_string();
        require!(!name.is_empty() && name.len() <= 32, "a name of up to 32 characters");
        require!((2..=8).contains(&symbol.len()) && symbol.chars().all(|c| c.is_ascii_alphanumeric()), "a ticker of 2 to 8 letters or numbers");
        let bag = SUPPLY - SALE;
        // What every launch must promise. The plan contract would take anything; these limits are what
        // make "the dev's bag is in a plan" mean something. A tenth of the bag at most per period, a
        // period and a notice of at least a minute, and a floor of at least a twentieth of the cap.
        require!(terms.cap.0 > 0 && terms.cap.0 <= bag / 10, "the cap can be at most a tenth of the dev's share per period");
        require!(terms.min_cap.0 >= terms.cap.0 / 20 && terms.min_cap.0 > 0 && terms.min_cap.0 <= terms.cap.0, "the cap's floor must be between a twentieth of the cap and the cap");
        require!(terms.period_secs.0 >= 60 && terms.notice_secs.0 >= 60, "periods and notice must be at least a minute");
        require!(terms.period_secs.0 <= MAX_SECS && terms.notice_secs.0 <= MAX_SECS && terms.start_in_secs.0 <= MAX_SECS, "periods, notice and start can be at most ten years");
        require!(terms.penalty_bps > 0 && terms.penalty_bps <= 5_000, "a Busted must tighten the cap, by at most half");
        if let Some(sealed) = &terms.sealed {
            require!(sealed.outlayer == self.outlayer, "a sealed plan can only be judged through OutLayer");
            require!(sealed.commitment.len() <= 128 && sealed.judge_hash.len() <= 128 && sealed.secrets_profile.len() <= 128 && sealed.judge_url.len() <= 256, "a sealed plan's text fields are too long");
        }
        let payer = env::predecessor_account_id();
        let dev = dev.unwrap_or_else(|| payer.clone());
        let paid = env::attached_deposit().as_yoctonear();
        let cost = self.launch_cost().0;
        require!(paid >= cost, format!("attach at least {cost} yoctoNEAR"));
        let plan_deposit = PLAN_STORAGE.as_yoctonear() + (paid - coin_cost() - PLAN_STORAGE.as_yoctonear() - POOL_STORAGE.as_yoctonear());
        let n = self.next;
        self.next += 1;
        let coin: AccountId = format!("{}-{}.{}", symbol.to_lowercase(), n, env::current_account_id()).parse().unwrap_or_else(|_| env::panic_str("that makes an account name NEAR refuses"));
        let args = json!({
            "name": name, "symbol": symbol.to_uppercase(), "total_supply": U128(SUPPLY), "sale": U128(SALE), "dev": dev,
            "market": self.market, "plans": self.plans, "terms": terms, "plan_deposit": U128(plan_deposit), "pool_deposit": U128(POOL_STORAGE.as_yoctonear()), "launcher": env::current_account_id(),
        });
        let _ = Promise::new(coin.clone())
            .create_account()
            .transfer(NearToken::from_yoctonear(paid))
            .deploy_contract(TOKEN.to_vec())
            .function_call("launch".to_string(), args.to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_INIT)
            .then(Promise::new(env::current_account_id()).function_call("on_made".to_string(), json!({ "coin": coin, "payer": payer, "paid": U128(paid) }).to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_DONE));
        coin
    }

    /// If the coin could not be made the money came back to this account, so pass it on.
    #[private]
    pub fn on_made(&mut self, coin: AccountId, payer: AccountId, paid: U128, #[callback_result] made: Result<(), PromiseError>) -> bool {
        if made.is_ok() {
            return true;
        }
        env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "chok-launcher", "version": "1.0.0", "event": "launch_failed", "data": [{ "coin": coin }] })));
        let _ = Promise::new(payer).transfer(NearToken::from_yoctonear(paid.0));
        false
    }

    /// The last step of a launch, called by the coin itself: only now is it true that the coin has a
    /// plan and a pool. Only a coin made here can say so.
    pub fn confirm(&mut self) -> bool {
        let coin = env::predecessor_account_id();
        let suffix = format!(".{}", env::current_account_id());
        let label = coin.as_str().strip_suffix(&suffix).unwrap_or_else(|| env::panic_str("only a coin made here"));
        require!(!label.is_empty() && !label.contains('.'), "only a coin made here");
        let listed = env::promise_results_count() == 1 && env::promise_result_checked(0, 16).is_ok();
        env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "chok-launcher", "version": "1.0.0", "event": if listed { "launched" } else { "launch_failed" }, "data": [{ "coin": coin }] })));
        listed
    }

    pub fn market(&self) -> AccountId {
        self.market.clone()
    }

    pub fn plans(&self) -> AccountId {
        self.plans.clone()
    }

    pub fn outlayer(&self) -> AccountId {
        self.outlayer.clone()
    }

    pub fn launched(&self) -> u64 {
        self.next
    }

    /// The sha256 of the token every coin here runs, in hex.
    pub fn token_hash(&self) -> String {
        env::sha256(TOKEN).iter().map(|b| format!("{b:02x}")).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId { s.parse().unwrap() }
    const M: u128 = 1_000_000_000_000;
    fn terms() -> Terms {
        Terms { holder: acc("dev.testnet"), cap: U128(20 * M), min_cap: U128(2 * M), period_secs: U64(60), start_in_secs: U64(0), notice_secs: U64(120), penalty_bps: 2000, sealed: None, loosen_allowed: false }
    }
    fn launch(t: Terms) -> AccountId {
        let mut l = Launcher::new(acc("market.testnet"), acc("plans.testnet"), acc("outlayer.testnet"));
        testing_env!(VMContextBuilder::new().current_account_id(acc("launcher.testnet")).predecessor_account_id(acc("dev.testnet")).attached_deposit(NearToken::from_near(5)).build());
        l.launch("Danfo Dog".into(), "DANDOG".into(), t, None)
    }

    #[test]
    fn a_fair_launch_goes_through() {
        assert_eq!(launch(terms()).as_str(), "dandog-0.launcher.testnet");
    }
    #[test]
    #[should_panic(expected = "at most a tenth")]
    fn the_whole_bag_as_a_cap_is_refused() {
        launch(Terms { cap: U128(200 * M), min_cap: U128(200 * M), ..terms() });
    }
    #[test]
    #[should_panic(expected = "at least a minute")]
    fn a_one_second_period_is_refused() {
        launch(Terms { period_secs: U64(1), ..terms() });
    }
    #[test]
    #[should_panic(expected = "at least a minute")]
    fn a_one_second_notice_is_refused() {
        launch(Terms { notice_secs: U64(1), ..terms() });
    }
    #[test]
    #[should_panic(expected = "floor must be")]
    fn a_floor_of_nothing_is_refused() {
        launch(Terms { min_cap: U128(1), ..terms() });
    }
    #[test]
    #[should_panic(expected = "at most ten years")]
    fn an_overflowing_period_is_refused_before_the_coin_exists() {
        launch(Terms { period_secs: U64(u64::MAX), ..terms() });
    }
    #[test]
    #[should_panic(expected = "judged through OutLayer")]
    fn a_fake_outlayer_is_refused_before_the_coin_exists() {
        let sealed = Sealed { commitment: "c".into(), judge_url: "u".into(), judge_hash: "h".into(), outlayer: acc("evil.testnet"), secrets_owner: acc("dev.testnet"), secrets_profile: "p".into() };
        launch(Terms { sealed: Some(sealed), ..terms() });
    }
    #[test]
    #[should_panic(expected = "only a coin made here")]
    fn only_a_coin_can_confirm() {
        let mut l = Launcher::new(acc("market.testnet"), acc("plans.testnet"), acc("outlayer.testnet"));
        testing_env!(VMContextBuilder::new().current_account_id(acc("launcher.testnet")).predecessor_account_id(acc("stranger.testnet")).build());
        l.confirm();
    }
}
