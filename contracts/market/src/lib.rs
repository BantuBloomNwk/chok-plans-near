//! CHOK market, on NEAR. Every coin the launcher makes gets a bonding curve here: anyone can buy
//! it with NEAR and sell it back for NEAR, at a price set by a constant-product curve over the
//! coin's sale supply plus a virtual reserve on each side. There is no order book and no one to
//! trust with the money: the NEAR paid in stays in the coin's own pool until someone sells.
//!
//! The dev's own bag is not here. It sits in a CHOK plan, and reaches this market only when the
//! plan lets it out. Every trade is kept on chain, so the chart and the tape need nobody's server.
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
/// Kept back from each trade to pay for storing its record.
const TRADE_STORAGE: NearToken = NearToken::from_micronear(1_000);
/// Registers a buyer on the coin so the tokens can reach them.
const TOKEN_STORAGE: NearToken = NearToken::from_micronear(1_250);
const GAS_STORAGE: Gas = Gas::from_tgas(10);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);

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
    List {},
    Sell { min_out: U128 },
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Market {
    /// only coins that are direct sub-accounts of this account may be listed. It is an account
    /// that exists only to make coins, so nothing else can ever live under it.
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

    fn record(&mut self, token: &AccountId, buy: bool, trader: &AccountId, near: u128, tokens: u128) {
        let pool = self.pools.get_mut(token).unwrap();
        let n = pool.trades;
        pool.trades += 1;
        pool.volume_near = U128(pool.volume_near.0 + near);
        let t = Trade { at_ms: U64(env::block_timestamp_ms()), buy, trader: trader.clone(), near: U128(near), tokens: U128(tokens), price: U128(price(pool)) };
        self.trades.insert(format!("{token}#{n}"), t.clone());
        log!("EVENT_JSON:{}", json!({ "standard": "chok-market", "version": "1.0.0", "event": "trade", "data": [{ "token": token, "buy": buy, "trader": trader, "near": U128(near), "tokens": U128(tokens), "price": t.price }] }));
    }

    /// Buy `token` with the attached NEAR. At least `min_out` tokens or nothing happens.
    #[payable]
    pub fn buy(&mut self, token: AccountId, min_out: U128) -> Promise {
        let buyer = env::predecessor_account_id();
        let paid = env::attached_deposit().as_yoctonear();
        let overhead = TRADE_STORAGE.as_yoctonear() + TOKEN_STORAGE.as_yoctonear();
        require!(paid > overhead + MICRO * 1_000, "attach at least 0.0033 NEAR");
        let pool = self.pools.get_mut(&token).unwrap_or_else(|| env::panic_str("that coin is not listed"));
        let net = paid - overhead;
        let fee = net * FEE_BPS / 10_000;
        let in_m = (net - fee) / MICRO;
        let out = buy_out(pool, in_m).min(pool.tokens_left.0);
        require!(out > 0, "too small to buy anything");
        require!(out >= min_out.0, "the price moved past your limit");
        let into_pool = in_m * MICRO;
        // the creator's fee and the rounding dust; the curve only counts whole micro-NEAR
        pool.fees_owed = U128(pool.fees_owed.0 + fee + (net - fee - into_pool));
        pool.real_near = U128(pool.real_near.0 + into_pool);
        pool.tokens_left = U128(pool.tokens_left.0 - out);
        Promise::new(token.clone())
            .function_call("storage_deposit", json!({ "account_id": buyer, "registration_only": true }).to_string().into_bytes(), TOKEN_STORAGE, GAS_STORAGE)
            .then(Promise::new(token.clone()).function_call("ft_transfer", json!({ "receiver_id": buyer, "amount": U128(out) }).to_string().into_bytes(), NearToken::from_yoctonear(1), GAS_FT_TRANSFER))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_bought(token, buyer, U128(out), U128(into_pool), U128(paid - TRADE_STORAGE.as_yoctonear() - TOKEN_STORAGE.as_yoctonear())))
    }

    /// The tokens reached the buyer: record the trade. They didn't: put the pool back and refund.
    #[private]
    pub fn on_bought(&mut self, token: AccountId, buyer: AccountId, out: U128, into_pool: U128, refund: U128, #[callback_result] sent: Result<(), PromiseError>) -> bool {
        if sent.is_ok() {
            self.record(&token, true, &buyer, into_pool.0, out.0);
            return true;
        }
        // only this pool's own money goes back, so a failed buy can never reach another coin's NEAR
        let pool = self.pools.get_mut(&token).unwrap();
        let from_pool = into_pool.0.min(pool.real_near.0);
        let from_fees = refund.0.saturating_sub(into_pool.0).min(pool.fees_owed.0);
        pool.tokens_left = U128(pool.tokens_left.0 + out.0);
        pool.real_near = U128(pool.real_near.0 - from_pool);
        pool.fees_owed = U128(pool.fees_owed.0 - from_fees);
        Promise::new(buyer).transfer(NearToken::from_yoctonear(from_pool + from_fees));
        false
    }

    /// Listing (from the coin's creator) and selling (from anyone) both arrive as tokens.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let msg: Msg = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("msg must be {\"list\":{}} or {\"sell\":{\"min_out\":\"…\"}}"));
        match msg {
            Msg::List {} => {
                let suffix = format!(".{}", self.launcher);
                let label = token.as_str().strip_suffix(&suffix).unwrap_or_else(|| env::panic_str("only coins made by the launcher can be listed"));
                require!(!label.is_empty() && !label.contains('.'), "only coins made by the launcher can be listed");
                require!(!self.pools.contains_key(&token), "already listed");
                require!(amount.0 >= 1_000_000, "list at least one whole token");
                let pool = Pool { creator: sender_id.clone(), sale_supply: amount, tokens_left: amount, virtual_tokens: U128(amount.0 / VIRTUAL_TOKEN_DIV), real_near: U128(0), fees_owed: U128(0), volume_near: U128(0), trades: 0, listed_at: U64(env::block_timestamp_ms()) };
                log!("EVENT_JSON:{}", json!({ "standard": "chok-market", "version": "1.0.0", "event": "listed", "data": [{ "token": token, "creator": sender_id, "sale_supply": amount, "price": U128(price(&pool)) }] }));
                self.pools.insert(token, pool);
                PromiseOrValue::Value(U128(0))
            }
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
                self.record(&token, false, &sender_id, out, amount.0);
                Promise::new(sender_id).transfer(NearToken::from_yoctonear(paid));
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

    fn view(token: &AccountId, pool: &Pool) -> PoolView {
        let sold = pool.sale_supply.0 - pool.tokens_left.0;
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
    use near_sdk::testing_env;

    fn ctx(pred: &str, deposit: u128) {
        testing_env!(VMContextBuilder::new().current_account_id("market.root.testnet".parse().unwrap()).predecessor_account_id(pred.parse().unwrap()).attached_deposit(NearToken::from_yoctonear(deposit)).build());
    }
    const T: u128 = 1_000_000;
    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    fn listed() -> Market {
        ctx("coin.root.testnet", 0);
        let mut m = Market::new("root.testnet".parse().unwrap());
        m.ft_on_transfer("dev.root.testnet".parse().unwrap(), U128(800_000_000 * T), r#"{"list":{}}"#.into());
        m
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
        ctx("evil.testnet", 0);
        let mut m = Market::new("root.testnet".parse().unwrap());
        m.ft_on_transfer("evil.testnet".parse().unwrap(), U128(T), r#"{"list":{}}"#.into());
    }

    #[test]
    #[should_panic(expected = "only coins made by the launcher can be listed")]
    fn nested_accounts_cannot_list() {
        ctx("x.coin.root.testnet", 0);
        let mut m = Market::new("root.testnet".parse().unwrap());
        m.ft_on_transfer("dev.testnet".parse().unwrap(), U128(T), r#"{"list":{}}"#.into());
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
