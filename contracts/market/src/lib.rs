//! CHOK market, on NEAR. Every coin the launcher makes gets a bonding curve here: anyone can buy
//! it with NEAR and sell it back for NEAR, at a price set by a constant-product curve over the
//! coin's sale supply plus a virtual reserve on each side. There is no order book and no one to
//! trust with the money: the NEAR paid in stays in the coin's own pool until someone sells.
//!
//! A coin lists only as part of its launch: the launcher makes the coin, mints the sale supply here
//! and the dev's share into a plan, all in one transaction. So the dev's bag reaches this market only
//! when the plan lets it out. Every trade is kept on chain, so the chart and the tape need nobody's
//! server.
//!
//! Prices are worked in micro-NEAR (10^-6 NEAR) so the curve's products fit in a u128; any dust
//! that rounds away stays in the pool.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue};

/// One micro-NEAR in yocto.
const MICRO: u128 = 1_000_000_000_000_000_000;
/// The virtual NEAR side of every curve, in micro-NEAR: 3 NEAR.
const VIRTUAL_NEAR_M: u128 = 3_000_000;
/// The virtual token side is this share of the sale supply, so selling out raises 12 NEAR.
const VIRTUAL_TOKEN_DIV: u128 = 4;
const FEE_BPS: u128 = 100;
/// Held back from each trade to store its record; the worst case for the longest account names.
/// What the record really takes is measured, and the rest goes back to the trader.
const TRADE_STORAGE: NearToken = NearToken::from_micronear(2_500);
/// Registers a buyer on the coin so the tokens can reach them.
const TOKEN_STORAGE: NearToken = NearToken::from_micronear(1_250);
const GAS_STORAGE: Gas = Gas::from_tgas(10);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);
const MIN_BUY: NearToken = NearToken::from_micronear(7_500);
const GAS_CHECK: Gas = Gas::from_tgas(5);
const GAS_ROUTE: Gas = Gas::from_tgas(60);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Pools,
    Trades,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Pool {
    pub creator: AccountId,
    /// The plan holding the dev's share, in the plan contract.
    pub plan: u32,
    pub sale_supply: U128,
    /// tokens still for sale, held by this contract
    pub tokens_left: U128,
    pub virtual_tokens: U128,
    /// NEAR paid in by buyers and not yet paid out to sellers, in yocto
    pub real_near: U128,
    /// the creator's 1%, claimable any time
    pub fees_owed: U128,
    pub volume_near: U128,
    pub trades: u32,
    pub listed_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Trade {
    pub at_ms: U64,
    pub buy: bool,
    pub trader: AccountId,
    /// the NEAR side, in yocto: what went into the pool on a buy, what came out on a sell
    pub near: U128,
    pub tokens: U128,
    /// the price after the trade, in yocto per whole token (10^6 units)
    pub price: U128,
}

#[near(serializers = [json])]
pub struct PoolView {
    pub token: AccountId,
    #[serde(flatten)]
    pub pool: Pool,
    pub price: U128,
    pub sold_bps: u32,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
enum Msg {
    Sell { min_out: U128 },
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Market {
    /// Only coins that are direct sub-accounts of this account may list. It is a contract with no
    /// keys that makes coins from one fixed token, so nothing else can ever live under it.
    launcher: AccountId,
    pools: IterableMap<AccountId, Pool>,
    /// trade n of a coin, under "<coin>#n"; the pool counts them
    trades: LookupMap<String, Trade>,
}

fn x_m(p: &Pool) -> u128 {
    VIRTUAL_NEAR_M + p.real_near.0 / MICRO
}
fn y(p: &Pool) -> u128 {
    p.tokens_left.0 + p.virtual_tokens.0
}
fn price(p: &Pool) -> u128 {
    x_m(p) * MICRO * 1_000_000 / y(p)
}
/// tokens out for this many micro-NEAR in
fn buy_out(p: &Pool, in_m: u128) -> u128 {
    y(p) * in_m / (x_m(p) + in_m)
}
/// micro-NEAR out for this many tokens in
fn sell_out(p: &Pool, tokens: u128) -> u128 {
    x_m(p) * tokens / (y(p) + tokens)
}

#[near]
impl Market {
    #[init]
    pub fn new(launcher: AccountId) -> Self {
        Self { launcher, pools: IterableMap::new(Key::Pools), trades: LookupMap::new(Key::Trades) }
    }

    /// Keeps a trade on chain and returns what storing it really cost.
    fn record(&mut self, token: &AccountId, buy: bool, trader: &AccountId, near: u128, tokens: u128) -> u128 {
        let before = env::storage_usage();
        let pool = self.pools.get_mut(token).unwrap();
        let n = pool.trades;
        pool.trades += 1;
        pool.volume_near = U128(pool.volume_near.0 + near);
        let t = Trade { at_ms: U64(env::block_timestamp_ms()), buy, trader: trader.clone(), near: U128(near), tokens: U128(tokens), price: U128(price(pool)) };
        self.trades.insert(format!("{token}#{n}"), t.clone());
        self.trades.flush();
        log!("EVENT_JSON:{}", json!({ "standard": "chok-market", "version": "1.0.0", "event": "trade", "data": [{ "token": token, "buy": buy, "trader": trader, "near": U128(near), "tokens": U128(tokens), "price": t.price }] }));
        env::storage_byte_cost().as_yoctonear() * (env::storage_usage() - before) as u128
    }

    /// Buy `token` with the attached NEAR. At least `min_out` tokens or nothing happens. At the very
    /// end of the curve you pay only for the tokens that are left, and the rest comes back.
    #[payable]
    pub fn buy(&mut self, token: AccountId, min_out: U128) -> Promise {
        let buyer = env::predecessor_account_id();
        let paid = env::attached_deposit().as_yoctonear();
        let overhead = TRADE_STORAGE.as_yoctonear() + TOKEN_STORAGE.as_yoctonear();
        // under this a buyer's tokens would be worth too little to ever sell back
        require!(paid >= MIN_BUY.as_yoctonear(), "attach at least 0.0075 NEAR");
        let pool = self.pools.get_mut(&token).unwrap_or_else(|| env::panic_str("that coin is not listed"));
        require!(pool.tokens_left.0 > 0, "this coin's curve has sold out");
        let net = paid - overhead;
        let fee = net * FEE_BPS / 10_000;
        let in_m = (net - fee) / MICRO;
        let wanted = buy_out(pool, in_m);
        // past the end of the curve: the exact micro-NEAR for what is left, x * t / (y - t), rounded up
        let (out, into_pool, fee, excess) = if wanted >= pool.tokens_left.0 {
            let t = pool.tokens_left.0;
            let need = (x_m(pool) * t).div_ceil(y(pool) - t).min(in_m);
            let into = need * MICRO;
            let fee = (into * FEE_BPS).div_ceil(10_000 - FEE_BPS);
            (t, into, fee, net.saturating_sub(into + fee))
        } else {
            let into = in_m * MICRO;
            // the fee plus the rounding dust; the curve only counts whole micro-NEAR
            (wanted, into, net - into, 0)
        };
        require!(out > 0, "too small to buy anything");
        require!(out >= min_out.0, "the price moved past your limit");
        pool.fees_owed = U128(pool.fees_owed.0 + fee);
        pool.real_near = U128(pool.real_near.0 + into_pool);
        pool.tokens_left = U128(pool.tokens_left.0 - out);
        // the coin keeps its own register, so ask it whether the buyer is on it yet
        Promise::new(token.clone())
            .function_call("storage_balance_of", json!({ "account_id": buyer }).to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_CHECK)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ROUTE).on_registered_check(token, buyer, U128(out), U128(into_pool), U128(fee), U128(excess)))
    }

    /// A buyer already on the coin's register keeps their registration money.
    #[private]
    pub fn on_registered_check(&mut self, token: AccountId, buyer: AccountId, out: U128, into_pool: U128, fee: U128, excess: U128, #[callback_result] registered: Result<Option<near_sdk::serde_json::Value>, PromiseError>) -> Promise {
        let known = matches!(registered, Ok(Some(_)));
        let send = Promise::new(token.clone()).function_call("ft_transfer", json!({ "receiver_id": buyer, "amount": out }).to_string().into_bytes(), NearToken::from_yoctonear(1), GAS_FT_TRANSFER);
        let chain = if known { send } else {
            Promise::new(token.clone()).function_call("storage_deposit", json!({ "account_id": buyer, "registration_only": true }).to_string().into_bytes(), TOKEN_STORAGE, GAS_STORAGE).then(send)
        };
        let back = excess.0 + if known { TOKEN_STORAGE.as_yoctonear() } else { 0 };
        chain.then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_bought(token, buyer, out, into_pool, fee, U128(back)))
    }

    /// The tokens reached the buyer: record the trade and give back what wasn't needed. They didn't:
    /// the buyer sells them back at the curve as it is now, with no fee. Others may have traded since
    /// the buy, so rewinding by subtraction would break the curve; this way any trade in between costs
    /// the failed buyer and never the pool, and it can never reach another coin's NEAR.
    #[private]
    pub fn on_bought(&mut self, token: AccountId, buyer: AccountId, out: U128, into_pool: U128, fee: U128, back: U128, #[callback_result] sent: Result<(), PromiseError>) -> bool {
        if sent.is_ok() {
            let used = self.record(&token, true, &buyer, into_pool.0, out.0);
            let refund = back.0 + TRADE_STORAGE.as_yoctonear().saturating_sub(used);
            if refund > 0 { let _ = Promise::new(buyer).transfer(NearToken::from_yoctonear(refund)); }
            return true;
        }
        let pool = self.pools.get_mut(&token).unwrap();
        let from_pool = (sell_out(pool, out.0) * MICRO).min(pool.real_near.0).min(into_pool.0);
        let from_fees = fee.0.min(pool.fees_owed.0);
        pool.tokens_left = U128(pool.tokens_left.0 + out.0);
        pool.real_near = U128(pool.real_near.0 - from_pool);
        pool.fees_owed = U128(pool.fees_owed.0 - from_fees);
        let _ = Promise::new(buyer).transfer(NearToken::from_yoctonear(from_pool + from_fees + back.0 + TRADE_STORAGE.as_yoctonear()));
        false
    }

    /// The launch itself, from a coin the launcher just made: the sale supply was minted straight
    /// here, and the coin's plan was made a moment before. No plan, no listing.
    #[payable]
    pub fn list_launched(&mut self, creator: AccountId, sale: U128) -> bool {
        let token = env::predecessor_account_id();
        let suffix = format!(".{}", self.launcher);
        let label = token.as_str().strip_suffix(&suffix).unwrap_or_else(|| env::panic_str("only coins made by the launcher can be listed"));
        require!(!label.is_empty() && !label.contains('.'), "only coins made by the launcher can be listed");
        require!(!self.pools.contains_key(&token), "already listed");
        require!(sale.0 >= 1_000_000, "list at least one whole token");
        require!(env::promise_results_count() == 1, "a coin with no plan cannot list");
        let bytes = env::promise_result_checked(0, 64).unwrap_or_else(|_| env::panic_str("a coin with no plan cannot list"));
        let plan: u32 = serde_json::from_slice(&bytes).unwrap_or_else(|_| env::panic_str("a coin with no plan cannot list"));
        let before = env::storage_usage();
        let pool = Pool { creator: creator.clone(), plan, sale_supply: sale, tokens_left: sale, virtual_tokens: U128(sale.0 / VIRTUAL_TOKEN_DIV), real_near: U128(0), fees_owed: U128(0), volume_near: U128(0), trades: 0, listed_at: U64(env::block_timestamp_ms()) };
        log!("EVENT_JSON:{}", json!({ "standard": "chok-market", "version": "1.0.0", "event": "listed", "data": [{ "token": token, "creator": creator, "plan": plan, "sale_supply": sale, "price": U128(price(&pool)) }] }));
        self.pools.insert(token.clone(), pool);
        self.pools.flush();
        let cost = env::storage_byte_cost().as_yoctonear() * (env::storage_usage() - before) as u128;
        let paid = env::attached_deposit().as_yoctonear();
        require!(paid >= cost, "the launch must pay for its pool's storage");
        if paid > cost { let _ = Promise::new(token).transfer(NearToken::from_yoctonear(paid - cost)); }
        true
    }

    /// Selling arrives as tokens.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let msg: Msg = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("msg must be {\"sell\":{\"min_out\":\"…\"}}"));
        match msg {
            Msg::Sell { min_out } => {
                let pool = self.pools.get_mut(&token).unwrap_or_else(|| env::panic_str("that coin is not listed"));
                let out = (sell_out(pool, amount.0) * MICRO).min(pool.real_near.0);
                let fee = out * FEE_BPS / 10_000;
                let keep = TRADE_STORAGE.as_yoctonear();
                require!(out > fee + keep, "too small to sell");
                let paid = out - fee - keep;
                require!(paid >= min_out.0, "the price moved past your limit");
                pool.real_near = U128(pool.real_near.0 - out);
                pool.tokens_left = U128(pool.tokens_left.0 + amount.0);
                pool.fees_owed = U128(pool.fees_owed.0 + fee);
                let used = self.record(&token, false, &sender_id, out, amount.0);
                let _ = Promise::new(sender_id).transfer(NearToken::from_yoctonear(paid + keep.saturating_sub(used)));
                PromiseOrValue::Value(U128(0))
            }
        }
    }

    /// The creator takes their trading fees.
    pub fn claim_fees(&mut self, token: AccountId) -> Promise {
        let pool = self.pools.get_mut(&token).unwrap_or_else(|| env::panic_str("that coin is not listed"));
        require!(env::predecessor_account_id() == pool.creator, "only the creator");
        let owed = pool.fees_owed.0;
        require!(owed > 0, "nothing to claim");
        pool.fees_owed = U128(0);
        Promise::new(pool.creator.clone()).transfer(NearToken::from_yoctonear(owed))
    }

    pub fn quote_buy(&self, token: AccountId, deposit: U128) -> U128 {
        let pool = self.pools.get(&token).unwrap_or_else(|| env::panic_str("that coin is not listed"));
        let overhead = TRADE_STORAGE.as_yoctonear() + TOKEN_STORAGE.as_yoctonear();
        if deposit.0 <= overhead { return U128(0); }
        let net = deposit.0 - overhead;
        U128(buy_out(pool, (net - net * FEE_BPS / 10_000) / MICRO).min(pool.tokens_left.0))
    }

    pub fn quote_sell(&self, token: AccountId, amount: U128) -> U128 {
        let pool = self.pools.get(&token).unwrap_or_else(|| env::panic_str("that coin is not listed"));
        let out = (sell_out(pool, amount.0) * MICRO).min(pool.real_near.0);
        U128(out.saturating_sub(out * FEE_BPS / 10_000 + TRADE_STORAGE.as_yoctonear()))
    }

    /// What the curve itself would pay for these tokens in yocto, before the cap at the NEAR the
    /// pool holds and before fees. It is how anyone can check whether a pool can pay its sellers.
    pub fn curve_sell(&self, token: AccountId, amount: U128) -> U128 {
        let pool = self.pools.get(&token).unwrap_or_else(|| env::panic_str("that coin is not listed"));
        U128(sell_out(pool, amount.0) * MICRO)
    }

    fn view(token: &AccountId, pool: &Pool) -> PoolView {
        // a dev's released tokens can come back to the pool, so more can be here than it ever sold
        let sold = pool.sale_supply.0.saturating_sub(pool.tokens_left.0);
        PoolView { token: token.clone(), pool: pool.clone(), price: U128(price(pool)), sold_bps: (sold * 10_000 / pool.sale_supply.0) as u32 }
    }

    pub fn get_pool(&self, token: AccountId) -> Option<PoolView> {
        self.pools.get(&token).map(|p| Self::view(&token, p))
    }

    pub fn list_pools(&self, from: Option<u32>, limit: Option<u32>) -> Vec<PoolView> {
        self.pools.iter().skip(from.unwrap_or(0) as usize).take(limit.unwrap_or(50) as usize).map(|(t, p)| Self::view(t, p)).collect()
    }

    pub fn get_trades(&self, token: AccountId, from: Option<u32>, limit: Option<u32>) -> Vec<Trade> {
        let count = self.pools.get(&token).map_or(0, |p| p.trades);
        let from = from.unwrap_or(0);
        (from..count.min(from.saturating_add(limit.unwrap_or(200)))).filter_map(|i| self.trades.get(&format!("{token}#{i}")).cloned()).collect()
    }

    pub fn launcher(&self) -> AccountId {
        self.launcher.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, PromiseResult};

    fn ctx(pred: &str, deposit: u128) {
        testing_env!(VMContextBuilder::new().current_account_id("market.root.testnet".parse().unwrap()).predecessor_account_id(pred.parse().unwrap()).attached_deposit(NearToken::from_yoctonear(deposit)).build());
    }
    const T: u128 = 1_000_000;
    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    fn with_plan(pred: &str, plan: Option<u32>) {
        let ctx = VMContextBuilder::new().current_account_id("market.root.testnet".parse().unwrap()).predecessor_account_id(pred.parse().unwrap()).attached_deposit(NearToken::from_millinear(50)).build();
        let result = match plan { Some(n) => PromiseResult::Successful(n.to_string().into_bytes()), None => PromiseResult::Failed };
        testing_env!(ctx, near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![result]);
    }

    fn listed() -> Market {
        // a fresh chain each time, so one test can compare several runs
        ctx("x.testnet", 0);
        near_sdk::mock::with_mocked_blockchain(|b| { b.take_storage(); });
        let mut m = Market::new("root.testnet".parse().unwrap());
        with_plan("coin.root.testnet", Some(4));
        m.list_launched("dev.root.testnet".parse().unwrap(), U128(800_000_000 * T));
        m
    }

    fn acct(s: &str) -> AccountId { s.parse().unwrap() }
    const COIN: &str = "coin.root.testnet";
    fn k(m: &Market) -> u128 { let p = m.pools.get(&acct(COIN)).unwrap(); x_m(p) * y(p) }

    /// What the pool took and gave for one buy: tokens out, NEAR in, fee.
    fn buy(m: &mut Market, who: &str, near: u128) -> (u128, u128, u128) {
        let before = m.pools.get(&acct(COIN)).unwrap().clone();
        ctx(who, near);
        let _ = m.buy(acct(COIN), U128(0));
        let p = m.pools.get(&acct(COIN)).unwrap();
        (before.tokens_left.0 - p.tokens_left.0, p.real_near.0 - before.real_near.0, p.fees_owed.0 - before.fees_owed.0)
    }

    /// Round 5's drain: H buys, a victim buys, P buys, H sells into P's price while P's buy is in
    /// flight, then P's transfer fails. Returns what H and P made together, and what the victim can
    /// now sell for.
    fn drain(h_in: u128, victim_in: u128, p_in: u128) -> (i128, u128, u128) {
        let mut m = listed();
        let k0 = k(&m);
        let (h_tokens, _, _) = buy(&mut m, "h.testnet", h_in);
        let (v_tokens, _, _) = buy(&mut m, "victim.testnet", victim_in);
        let (p_tokens, p_into, p_fee) = buy(&mut m, "p.testnet", p_in);
        let h_got = m.quote_sell(acct(COIN), U128(h_tokens)).0;
        ctx(COIN, 0);
        m.ft_on_transfer(acct("h.testnet"), U128(h_tokens), r#"{"sell":{"min_out":"0"}}"#.into());
        let before = m.pools.get(&acct(COIN)).unwrap().clone();
        ctx("market.root.testnet", 0);
        m.on_bought(acct(COIN), acct("p.testnet"), U128(p_tokens), U128(p_into), U128(p_fee), U128(0), Err(PromiseError::Failed));
        let after = m.pools.get(&acct(COIN)).unwrap().clone();
        let p_back = (before.real_near.0 - after.real_near.0) + (before.fees_owed.0 - after.fees_owed.0);
        assert!(k(&m) + MICRO * T >= k0, "the curve's product fell: {} from {k0}", k(&m));
        let net = h_got as i128 + p_back as i128 - h_in as i128 - p_into as i128 - p_fee as i128;
        (net, m.quote_sell(acct(COIN), U128(v_tokens)).0, victim_in)
    }

    /// The same trades with no failed buy: H earns what buying before someone else always earns.
    fn fair(h_in: u128, victim_in: u128) -> (i128, u128) {
        let mut m = listed();
        let (h_tokens, _, _) = buy(&mut m, "h.testnet", h_in);
        let (v_tokens, _, _) = buy(&mut m, "victim.testnet", victim_in);
        let h_got = m.quote_sell(acct(COIN), U128(h_tokens)).0;
        ctx(COIN, 0);
        m.ft_on_transfer(acct("h.testnet"), U128(h_tokens), r#"{"sell":{"min_out":"0"}}"#.into());
        (h_got as i128 - h_in as i128, m.quote_sell(acct(COIN), U128(v_tokens)).0)
    }

    #[test]
    fn a_failed_buy_cannot_drain_a_pool() {
        // the scenarios from the review, where the attacker used to take up to 4 NEAR out of the victim.
        // With the failed buy, H and P together must do no better than H alone, and the victim no worse
        for (h, v, p) in [(1, 3, 2), (1, 3, 1), (1, 6, 3), (1, 1, 8)] {
            let (net, victim_can_get, _) = drain(h * NEAR, v * NEAR, p * NEAR);
            let (fair_net, fair_victim) = fair(h * NEAR, v * NEAR);
            let dust = 10 * MICRO as i128;
            assert!(net <= fair_net + dust, "{h}/{v}/{p}: attacker made {net}, buying first is worth {fair_net}");
            assert!(victim_can_get as i128 >= fair_victim as i128 - dust, "{h}/{v}/{p}: victim can get {victim_can_get}, fair is {fair_victim}");
        }
    }

    #[test]
    fn a_failed_buy_with_nothing_in_between_refunds_nearly_everything() {
        let mut m = listed();
        let (t, into, fee) = buy(&mut m, "p.testnet", NEAR);
        ctx("market.root.testnet", 0);
        m.on_bought(acct(COIN), acct("p.testnet"), U128(t), U128(into), U128(fee), U128(0), Err(PromiseError::Failed));
        let p = m.pools.get(&acct(COIN)).unwrap();
        assert_eq!(p.tokens_left, p.sale_supply);
        assert!(p.real_near.0 < MICRO * 2, "the pool kept {}", p.real_near.0);
    }

    #[test]
    #[should_panic(expected = "attach at least 0.0075 NEAR")]
    fn a_buy_too_small_to_ever_sell_is_refused() {
        let mut m = listed();
        ctx("fan.testnet", NearToken::from_micronear(7_499).as_yoctonear());
        let _ = m.buy(acct(COIN), U128(0));
    }

    #[test]
    fn the_smallest_buy_can_be_sold_back() {
        let mut m = listed();
        let (t, _, _) = buy(&mut m, "fan.testnet", MIN_BUY.as_yoctonear());
        assert!(m.quote_sell(acct(COIN), U128(t)).0 > 0);
    }

    #[test]
    fn selling_out_raises_twelve_near() {
        let m = listed();
        let p = m.pools.get(&"coin.root.testnet".parse::<AccountId>().unwrap()).unwrap();
        // x * y = k: after every sale token is gone, y is the virtual quarter and x has grown five times
        let k = x_m(p) * y(p);
        assert_eq!(k / p.virtual_tokens.0, 15_000_000);
    }

    #[test]
    fn buy_then_sell_never_pays_out_more() {
        let mut m = listed();
        let coin: AccountId = "coin.root.testnet".parse().unwrap();
        ctx("fan.testnet", NEAR);
        let _ = m.buy(coin.clone(), U128(0));
        let p = m.pools.get(&coin).unwrap().clone();
        let bought = p.sale_supply.0 - p.tokens_left.0;
        assert!(bought > 0 && p.real_near.0 > 0);
        ctx("coin.root.testnet", 0);
        let back = m.quote_sell(coin.clone(), U128(bought)).0;
        assert!(back < NEAR, "a round trip must lose the fees, got {back}");
        m.ft_on_transfer("fan.testnet".parse().unwrap(), U128(bought), r#"{"sell":{"min_out":"0"}}"#.into());
        let p = m.pools.get(&coin).unwrap().clone();
        assert_eq!(p.tokens_left, p.sale_supply);
        m.record(&coin, true, &"a.testnet".parse().unwrap(), 5, 6);
        m.record(&coin, false, &"b.testnet".parse().unwrap(), 7, 8);
        let t = m.get_trades(coin.clone(), None, None);
        assert_eq!((t.len(), t[1].trader.as_str(), t[2].near.0), (3, "a.testnet", 7));
        assert!(p.real_near.0 <= MICRO, "the pool may keep only rounding dust, kept {}", p.real_near.0);
    }

    #[test]
    #[should_panic(expected = "only coins made by the launcher can be listed")]
    fn outside_coins_cannot_list() {
        let mut m = Market::new("root.testnet".parse().unwrap());
        with_plan("evil.testnet", Some(0));
        m.list_launched("evil.testnet".parse().unwrap(), U128(T));
    }

    #[test]
    #[should_panic(expected = "only coins made by the launcher can be listed")]
    fn nested_accounts_cannot_list() {
        let mut m = Market::new("root.testnet".parse().unwrap());
        with_plan("x.coin.root.testnet", Some(0));
        m.list_launched("dev.testnet".parse().unwrap(), U128(T));
    }

    #[test]
    #[should_panic(expected = "only coins made by the launcher can be listed")]
    fn a_direct_call_stops_at_the_launcher_check() {
        ctx("stranger.testnet", NEAR);
        let mut m = Market::new("root.testnet".parse().unwrap());
        m.list_launched("stranger.testnet".parse().unwrap(), U128(T));
    }

    #[test]
    #[should_panic(expected = "a coin with no plan cannot list")]
    fn no_plan_no_listing() {
        let mut m = Market::new("root.testnet".parse().unwrap());
        with_plan("coin.root.testnet", None);
        m.list_launched("dev.testnet".parse().unwrap(), U128(T));
    }

    #[test]
    #[should_panic(expected = "must be")]
    fn tokens_sent_in_cannot_list_themselves() {
        let mut m = listed();
        ctx("coin.root.testnet", 0);
        m.ft_on_transfer("dev.testnet".parse().unwrap(), U128(T), r#"{"list":{}}"#.into());
    }

    #[test]
    fn a_pool_taking_back_more_than_it_sold_stays_readable() {
        let mut m = listed();
        let coin: AccountId = "coin.root.testnet".parse().unwrap();
        ctx("fan.testnet", NEAR);
        let _ = m.buy(coin.clone(), U128(0));
        let bought = { let p = m.pools.get(&coin).unwrap(); p.sale_supply.0 - p.tokens_left.0 };
        // the dev sells tokens the plan let out, on top of everything the buyer holds
        ctx("coin.root.testnet", 0);
        m.ft_on_transfer("dev.testnet".parse().unwrap(), U128(bought + 5_000_000 * T), r#"{"sell":{"min_out":"0"}}"#.into());
        let v = m.get_pool(coin.clone()).unwrap();
        assert!(v.pool.tokens_left.0 > v.pool.sale_supply.0);
        assert_eq!(v.sold_bps, 0);
        assert_eq!(m.list_pools(None, None).len(), 1);
    }

    #[test]
    fn the_last_buyer_pays_only_for_what_is_left() {
        let mut m = listed();
        let coin: AccountId = "coin.root.testnet".parse().unwrap();
        // the whole curve costs 12 NEAR before fees, so 20 NEAR is too much
        ctx("whale.testnet", 20 * NEAR);
        let _ = m.buy(coin.clone(), U128(0));
        let p = m.pools.get(&coin).unwrap();
        assert_eq!(p.tokens_left.0, 0);
        let took = p.real_near.0 + p.fees_owed.0;
        assert!(p.real_near.0 >= 12 * NEAR && p.real_near.0 < 12 * NEAR + MICRO * 2, "took {}", p.real_near.0);
        assert!(took < 13 * NEAR, "the rest must go back, took {took}");
    }

    #[test]
    #[should_panic(expected = "sold out")]
    fn nothing_left_nothing_to_buy() {
        let mut m = listed();
        let coin: AccountId = "coin.root.testnet".parse().unwrap();
        ctx("whale.testnet", 20 * NEAR);
        let _ = m.buy(coin.clone(), U128(0));
        let _ = m.buy(coin, U128(0));
    }

    #[test]
    fn a_trade_record_fits_what_is_held_back_for_it() {
        let mut m = listed();
        let coin: AccountId = "coin.root.testnet".parse().unwrap();
        let longest: AccountId = format!("{}.testnet", "a".repeat(56)).parse().unwrap();
        let used = m.record(&coin, true, &longest, u128::MAX / 4, u128::MAX / 4);
        assert!(used <= TRADE_STORAGE.as_yoctonear(), "a record took {used}");
    }

    #[test]
    #[should_panic(expected = "the price moved past your limit")]
    fn slippage_limit_holds() {
        let mut m = listed();
        ctx("fan.testnet", NEAR);
        let _ = m.buy("coin.root.testnet".parse().unwrap(), U128(800_000_000 * T));
    }

    #[test]
    #[should_panic(expected = "only the creator")]
    fn only_creator_claims() {
        let mut m = listed();
        ctx("fan.testnet", 0);
        let _ = m.claim_fees("coin.root.testnet".parse().unwrap());
    }
}
