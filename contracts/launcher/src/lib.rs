//! The launcher. It has no keys, and it deploys one token, embedded here, so a coin's code is known
//! before it exists. One call makes the coin, mints the sale supply straight into the market and the
//! dev's share straight into a plan, all in one transaction. There is no moment when the dev holds
//! their bag loose, and no way to list a coin without a plan.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

/// `contracts/token` built by `npm run build`; `npm run verify` checks it is that build.
const TOKEN: &[u8] = include_bytes!("../token.wasm");
/// Every coin is a billion tokens with six decimals, 80% on sale and 20% in the plan.
const SUPPLY: u128 = 1_000_000_000_000_000;
const SALE: u128 = SUPPLY / 5 * 4;
const GAS_INIT: Gas = Gas::from_tgas(100);
const GAS_DONE: Gas = Gas::from_tgas(10);
/// The coin's account pays for its code and state itself; a little over for its own storage.
const STATE_BYTES: u128 = 4_000;
/// Toward the plan's storage, on top of the plan's budget.
const PLAN_STORAGE: NearToken = NearToken::from_millinear(15);
/// Toward the pool's storage. The market sends back what it doesn't use.
const POOL_STORAGE: NearToken = NearToken::from_millinear(5);
const MIN_BUDGET: NearToken = NearToken::from_millinear(20);

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
    pub sealed: Option<Value>,
    pub loosen_allowed: bool,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Launcher {
    market: AccountId,
    plans: AccountId,
    next: u64,
}

fn coin_cost() -> u128 {
    env::storage_byte_cost().as_yoctonear() * (TOKEN.len() as u128 + STATE_BYTES)
}

#[near]
impl Launcher {
    #[init]
    pub fn new(market: AccountId, plans: AccountId) -> Self {
        Self { market, plans, next: 0 }
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
        // the plan contract checks the same things, but by then the coin is half made
        require!(terms.cap.0 > 0 && terms.cap.0 <= bag, "the cap must be above zero and no more than the dev's share");
        require!(terms.min_cap.0 > 0 && terms.min_cap.0 <= terms.cap.0, "the cap's floor must be above zero and no more than the cap");
        require!(terms.period_secs.0 > 0 && terms.notice_secs.0 > 0, "periods and notice must be longer than zero");
        require!(terms.penalty_bps > 0 && terms.penalty_bps <= 5_000, "a Busted must tighten the cap, by at most half");
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
            "market": self.market, "plans": self.plans, "terms": terms, "plan_deposit": U128(plan_deposit), "pool_deposit": U128(POOL_STORAGE.as_yoctonear()),
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
            env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "chok-launcher", "version": "1.0.0", "event": "launched", "data": [{ "coin": coin }] })));
            return true;
        }
        let _ = Promise::new(payer).transfer(NearToken::from_yoctonear(paid.0));
        false
    }

    pub fn market(&self) -> AccountId {
        self.market.clone()
    }

    pub fn plans(&self) -> AccountId {
        self.plans.clone()
    }

    pub fn launched(&self) -> u64 {
        self.next
    }

    /// The sha256 of the token every coin here runs, in hex.
    pub fn token_hash(&self) -> String {
        env::sha256(TOKEN).iter().map(|b| format!("{b:02x}")).collect()
    }
}
