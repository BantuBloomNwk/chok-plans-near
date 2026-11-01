//! CHOK plans, running on NEAR. A plan holds a dev's tokens (any NEP-141) and lets them out only
//! under a public cap per period. The plan's holder (the dev's everyday key, or an agent) can ask;
//! asking for more than the cap, or before the plan opens, is refused and recorded as Busted, and
//! each Busted tightens the cap. Loosening can only be proposed by the person the tokens go to,
//! never by the holder, and waits out a public notice that the person can cancel.
//!
//! A refusal is a successful transaction that moves nothing: the record of it is the point.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::IterableMap;
use near_sdk::{env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

const MAX_PENALTY_BPS: u16 = 5_000;
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_JUDGE: Gas = Gas::from_tgas(120);
const GAS_VERDICT: Gas = Gas::from_tgas(60);
/// What the plan contract pays OutLayer per judged request, from its own balance (an agent's
/// function-call key cannot attach a deposit). Unused funds come back.
const JUDGE_DEPOSIT: NearToken = NearToken::from_millinear(50);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Plans,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Pending {
    pub cap: U128,
    pub effective_at: U64,
}

/// A sealed plan's judge: the dev's exact rules live only in an OutLayer secret, and this pins
/// which code may judge by them and what they must hash to.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Sealed {
    /// sha256("chok-sealed-v1|max|earliest|gap|salt"), published when the plan is made.
    pub commitment: String,
    /// Where OutLayer fetches the judge, and the sha256 it must have.
    pub judge_url: String,
    pub judge_hash: String,
    pub outlayer: AccountId,
    /// Whose OutLayer secrets hold the rules, under which profile.
    pub secrets_owner: AccountId,
    pub secrets_profile: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Plan {
    pub token: AccountId,
    /// May ask for releases and tighten. Never loosens.
    pub holder: AccountId,
    /// Receives every release, and alone may propose or cancel a loosening.
    pub beneficiary: AccountId,
    /// Most that may leave per period, in the token's smallest unit.
    pub cap: U128,
    pub period_ns: U64,
    pub period_start: U64,
    pub released_in_period: U128,
    pub released_total: U128,
    /// Tokens the plan holds right now.
    pub balance: U128,
    /// Nothing leaves before this.
    pub not_before: U64,
    pub notice_ns: U64,
    /// How much each Busted tightens the cap, in basis points.
    pub penalty_bps: u16,
    pub releases: u32,
    pub busted: u32,
    pub tightenings: u32,
    pub loosenings: u32,
    pub pending: Option<Pending>,
    pub sealed: Option<Sealed>,
    /// When the last release went out (ns), for the sealed judge's pacing rule.
    pub last_release: U64,
    /// A request out with the sealed judge, if any.
    pub awaiting: Option<U128>,
    /// Set at launch and never changed: whether the cap can ever be loosened at all.
    pub loosen_allowed: bool,
    /// A sealed plan's rules once someone has revealed them and the contract checked them
    /// against the commitment.
    pub revealed: Option<Revealed>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Revealed {
    pub max_per_release: U128,
    pub earliest: U64,
    pub min_gap_secs: U64,
    pub salt: String,
    pub by: AccountId,
    pub at: U64,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Plans {
    plans: IterableMap<u32, Plan>,
    next_id: u32,
}

/// The public rules: rolls the period, then the plan's start date and its cap.
fn public_refusal(plan: &mut Plan, amount: u128, now: u64) -> Option<&'static str> {
    if now >= plan.period_start.0 + plan.period_ns.0 {
        let periods = (now - plan.period_start.0) / plan.period_ns.0;
        plan.period_start = U64(plan.period_start.0 + periods * plan.period_ns.0);
        plan.released_in_period = U128(0);
    }
    if now < plan.not_before.0 {
        Some("not yet")
    } else if plan.released_in_period.0 + amount > plan.cap.0 {
        Some("over the cap")
    } else {
        None
    }
}

/// A refusal that is recorded, not reverted: Busted counts up and the cap tightens.
fn bust(plan: &mut Plan, plan_id: u32, by: &AccountId, amount: U128, reason: &str) {
    plan.busted += 1;
    let old = plan.cap.0;
    plan.cap = U128(old - old * plan.penalty_bps as u128 / 10_000);
    event("busted", json!({ "plan": plan_id, "by": by, "asked": amount, "reason": reason, "cap_before": U128(old), "cap_after": plan.cap, "busted": plan.busted }));
}

fn release(plan: &mut Plan, plan_id: u32, by: &AccountId, amount: U128, now: u64) {
    plan.released_in_period = U128(plan.released_in_period.0 + amount.0);
    plan.released_total = U128(plan.released_total.0 + amount.0);
    plan.balance = U128(plan.balance.0 - amount.0);
    plan.releases += 1;
    plan.last_release = U64(now);
    event("released", json!({ "plan": plan_id, "by": by, "amount": amount, "to": plan.beneficiary, "released_in_period": plan.released_in_period, "cap": plan.cap }));
    Promise::new(plan.token.clone())
        .function_call("ft_transfer".to_string(), json!({ "receiver_id": plan.beneficiary, "amount": amount }).to_string().into_bytes(), NearToken::from_yoctonear(1), GAS_FT_TRANSFER)
        .then(Promise::new(env::current_account_id()).function_call("on_released".to_string(), json!({ "plan_id": plan_id, "amount": amount }).to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_CALLBACK));
}

fn event(name: &str, data: near_sdk::serde_json::Value) {
    log!("EVENT_JSON:{}", json!({ "standard": "chok-plans", "version": "1.0.0", "event": name, "data": [data] }));
}

#[near]
impl Plans {
    #[init]
    pub fn new() -> Self {
        Self { plans: IterableMap::new(Key::Plans), next_id: 0 }
    }

    /// Make a plan. Whoever calls it pays the storage; the tokens arrive afterwards through
    /// `ft_transfer_call` with the plan id as the message.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn create_plan(
        &mut self,
        token: AccountId,
        holder: AccountId,
        beneficiary: AccountId,
        cap: U128,
        period_secs: U64,
        start_in_secs: U64,
        notice_secs: U64,
        penalty_bps: u16,
        sealed: Option<Sealed>,
        loosen_allowed: bool,
    ) -> u32 {
        require!(cap.0 > 0, "the cap must be above zero");
        require!(period_secs.0 > 0 && notice_secs.0 > 0, "periods and notice must be longer than zero");
        require!(penalty_bps <= MAX_PENALTY_BPS, "a Busted can tighten the cap by at most half");
        require!(holder != beneficiary || penalty_bps > 0, "a self-held plan needs a penalty");
        let used_before = env::storage_usage();
        let now = env::block_timestamp();
        let id = self.next_id;
        self.next_id += 1;
        let plan = Plan {
            token, holder, beneficiary, cap,
            period_ns: U64(period_secs.0 * 1_000_000_000),
            period_start: U64(now),
            released_in_period: U128(0), released_total: U128(0), balance: U128(0),
            not_before: U64(now + start_in_secs.0 * 1_000_000_000),
            notice_ns: U64(notice_secs.0 * 1_000_000_000),
            penalty_bps, releases: 0, busted: 0, tightenings: 0, loosenings: 0, pending: None,
            sealed, last_release: U64(0), awaiting: None, loosen_allowed, revealed: None,
        };
        event("plan_created", json!({ "loosen_allowed": loosen_allowed, "plan": id, "token": plan.token, "holder": plan.holder, "beneficiary": plan.beneficiary, "cap": plan.cap, "period_secs": period_secs, "not_before": plan.not_before, "penalty_bps": penalty_bps, "sealed_commitment": plan.sealed.as_ref().map(|s| s.commitment.clone()), "judge_hash": plan.sealed.as_ref().map(|s| s.judge_hash.clone()) }));
        self.plans.insert(id, plan);
        self.plans.flush();
        let cost = env::storage_byte_cost().saturating_mul((env::storage_usage() - used_before) as u128);
        require!(env::attached_deposit() >= cost, format!("attach at least {} yoctoNEAR for storage", cost.as_yoctonear()));
        id
    }

    /// NEP-141 receiver: tokens sent with the plan id as `msg` go into that plan.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let id: u32 = msg.trim().parse().unwrap_or_else(|_| env::panic_str("msg must be a plan id"));
        let token = env::predecessor_account_id();
        let plan = self.plans.get_mut(&id).unwrap_or_else(|| env::panic_str("no such plan"));
        require!(plan.token == token, "this plan holds a different token");
        plan.balance = U128(plan.balance.0 + amount.0);
        event("deposited", json!({ "plan": id, "from": sender_id, "amount": amount }));
        PromiseOrValue::Value(U128(0))
    }

    /// The holder asks to release `amount` to the beneficiary. The public rules are checked first:
    /// over the cap, or before the plan opens, is refused, recorded as Busted, and the cap
    /// tightens. A sealed plan then sends the request to its judge in an OutLayer TEE, and the
    /// verdict comes back to `on_verdict`. Returns whether it was released or sent to the judge.
    pub fn request_release(&mut self, plan_id: u32, amount: U128) -> bool {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let plan = self.plans.get_mut(&plan_id).unwrap_or_else(|| env::panic_str("no such plan"));
        require!(caller == plan.holder, "only the plan's holder can ask");
        require!(amount.0 > 0 && amount.0 <= plan.balance.0, "ask for more than zero and no more than the plan holds");
        require!(plan.awaiting.is_none(), "a request is already with the judge");
        if let Some(reason) = public_refusal(plan, amount.0, now) {
            bust(plan, plan_id, &caller, amount, reason);
            return false;
        }
        if let Some(sealed) = plan.sealed.clone() {
            plan.awaiting = Some(amount);
            event("sent_to_judge", json!({ "plan": plan_id, "by": caller, "asked": amount, "judge_hash": sealed.judge_hash }));
            let input = json!({ "plan_id": plan_id, "amount": amount, "now_secs": now / 1_000_000_000, "last_release_secs": plan.last_release.0 / 1_000_000_000 }).to_string();
            let args = json!({
                "source": { "WasmUrl": { "url": sealed.judge_url, "hash": sealed.judge_hash, "build_target": "wasm32-wasip2" } },
                "input_data": input,
                "resource_limits": { "max_instructions": 1_000_000_000u64, "max_memory_mb": 64, "max_execution_seconds": 30 },
                "secrets_ref": { "profile": sealed.secrets_profile, "account_id": sealed.secrets_owner },
                "response_format": "Json",
                "payer_account_id": env::current_account_id(),
            });
            Promise::new(sealed.outlayer)
                .function_call("request_execution".to_string(), args.to_string().into_bytes(), JUDGE_DEPOSIT, GAS_JUDGE)
                .then(Promise::new(env::current_account_id()).function_call("on_verdict".to_string(), json!({ "plan_id": plan_id, "amount": amount, "by": caller }).to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_VERDICT));
            return true;
        }
        release(plan, plan_id, &caller, amount, now);
        true
    }

    /// The sealed judge's verdict. It must carry the commitment the plan was made with, so the
    /// rules that judged it are the rules the dev committed to; the public cap is checked again.
    #[private]
    pub fn on_verdict(&mut self, plan_id: u32, amount: U128, by: AccountId) {
        let now = env::block_timestamp();
        let plan = self.plans.get_mut(&plan_id).unwrap_or_else(|| env::panic_str("no such plan"));
        plan.awaiting = None;
        let sealed = plan.sealed.clone().unwrap_or_else(|| env::panic_str("not a sealed plan"));
        let raw = match env::promise_result_checked(0, 4096) {
            Ok(bytes) => bytes,
            Err(_) => { event("judge_failed", json!({ "plan": plan_id, "asked": amount })); return; }
        };
        // OutLayer returns the program's stdout; with Json it may arrive as an object or as a JSON string of one
        let mut v: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(&raw).unwrap_or(near_sdk::serde_json::Value::Null);
        if let Some(inner) = v.as_str().and_then(|s| near_sdk::serde_json::from_str(s).ok()) { v = inner; }
        if v.get("commitment").and_then(|c| c.as_str()) != Some(sealed.commitment.as_str()) || v.get("plan_id").and_then(|p| p.as_u64()) != Some(plan_id as u64) {
            event("judge_mismatch", json!({ "plan": plan_id, "asked": amount }));
            return;
        }
        let cleared = v.get("cleared").and_then(|c| c.as_bool()).unwrap_or(false);
        let reason = v.get("reason").and_then(|r| r.as_str()).unwrap_or("refused by the sealed rules").to_string();
        if !cleared {
            let reason: &'static str = match reason.as_str() {
                "too early" => "sealed: too early",
                "too soon after the last release" => "sealed: too soon after the last release",
                "too large" => "sealed: too large",
                _ => "sealed: refused",
            };
            bust(plan, plan_id, &by, amount, reason);
            return;
        }
        if amount.0 > plan.balance.0 { event("judge_failed", json!({ "plan": plan_id, "asked": amount, "why": "balance moved" })); return; }
        if let Some(reason) = public_refusal(plan, amount.0, now) {
            bust(plan, plan_id, &by, amount, reason);
            return;
        }
        release(plan, plan_id, &by, amount, now);
    }

    /// If the token transfer failed (say the beneficiary isn't registered), put everything back.
    #[private]
    pub fn on_released(&mut self, plan_id: u32, amount: U128) {
        if env::promise_result_checked(0, 1024).is_ok() {
            return;
        }
        let plan = self.plans.get_mut(&plan_id).unwrap_or_else(|| env::panic_str("no such plan"));
        plan.balance = U128(plan.balance.0 + amount.0);
        plan.released_in_period = U128(plan.released_in_period.0.saturating_sub(amount.0));
        plan.released_total = U128(plan.released_total.0.saturating_sub(amount.0));
        plan.releases -= 1;
        event("release_reverted", json!({ "plan": plan_id, "amount": amount }));
    }

    /// Tighten the cap, at once. The holder or the beneficiary may; it also drops any pending loosening.
    pub fn tighten(&mut self, plan_id: u32, cap: U128) {
        let caller = env::predecessor_account_id();
        let plan = self.plans.get_mut(&plan_id).unwrap_or_else(|| env::panic_str("no such plan"));
        require!(caller == plan.holder || caller == plan.beneficiary, "only the holder or the beneficiary");
        require!(cap.0 > 0 && cap.0 < plan.cap.0, "tightening means a smaller cap");
        plan.cap = cap;
        plan.tightenings += 1;
        plan.pending = None;
        event("tightened", json!({ "plan": plan_id, "by": caller, "cap": cap }));
    }

    /// Only the beneficiary may propose a looser cap, and it waits out the plan's public notice.
    pub fn propose_loosen(&mut self, plan_id: u32, cap: U128) {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let plan = self.plans.get_mut(&plan_id).unwrap_or_else(|| env::panic_str("no such plan"));
        require!(plan.loosen_allowed, "this plan was launched to never loosen");
        require!(caller == plan.beneficiary, "only the beneficiary can propose a loosening; the holder never can");
        require!(cap.0 > plan.cap.0, "loosening means a larger cap");
        let effective_at = U64(now + plan.notice_ns.0);
        plan.pending = Some(Pending { cap, effective_at });
        event("loosen_proposed", json!({ "plan": plan_id, "cap": cap, "effective_at": effective_at }));
    }

    pub fn cancel_loosen(&mut self, plan_id: u32) {
        let plan = self.plans.get_mut(&plan_id).unwrap_or_else(|| env::panic_str("no such plan"));
        require!(env::predecessor_account_id() == plan.beneficiary, "only the beneficiary");
        require!(plan.pending.is_some(), "nothing pending");
        plan.pending = None;
        event("loosen_cancelled", json!({ "plan": plan_id }));
    }

    /// Anyone may apply a loosening once its notice has run out.
    pub fn apply_loosen(&mut self, plan_id: u32) {
        let now = env::block_timestamp();
        let plan = self.plans.get_mut(&plan_id).unwrap_or_else(|| env::panic_str("no such plan"));
        let p = plan.pending.clone().unwrap_or_else(|| env::panic_str("nothing pending"));
        require!(now >= p.effective_at.0, "the notice has not run out");
        plan.cap = p.cap;
        plan.loosenings += 1;
        plan.pending = None;
        event("loosen_applied", json!({ "plan": plan_id, "cap": p.cap }));
    }

    /// Anyone may reveal a sealed plan's rules. The contract hashes them the same way the judge
    /// does and records them only if they match the commitment published when the plan was made.
    pub fn reveal(&mut self, plan_id: u32, max_per_release: U128, earliest: U64, min_gap_secs: U64, salt: String) -> bool {
        let plan = self.plans.get_mut(&plan_id).unwrap_or_else(|| env::panic_str("no such plan"));
        let sealed = plan.sealed.clone().unwrap_or_else(|| env::panic_str("not a sealed plan"));
        require!(plan.revealed.is_none(), "already revealed");
        let text = format!("chok-sealed-v1|{}|{}|{}|{}", max_per_release.0, earliest.0, min_gap_secs.0, salt);
        let hash: String = env::sha256(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        let matches = hash == sealed.commitment;
        event("reveal_checked", json!({ "plan": plan_id, "matches": matches, "commitment": sealed.commitment, "hash": hash }));
        if matches {
            plan.revealed = Some(Revealed { max_per_release, earliest, min_gap_secs, salt, by: env::predecessor_account_id(), at: U64(env::block_timestamp()) });
            event("revealed", json!({ "plan": plan_id, "max_per_release": max_per_release, "earliest": earliest, "min_gap_secs": min_gap_secs }));
        }
        matches
    }

    /// The id the next plan will get (plans are never deleted), so a sealed plan's commitment can
    /// be worked out for it before it is made.
    pub fn next_plan_id(&self) -> u32 {
        self.next_id
    }

    pub fn get_plan(&self, plan_id: u32) -> Option<Plan> {
        self.plans.get(&plan_id).cloned()
    }

    pub fn list_plans(&self, from: Option<u32>, limit: Option<u32>) -> Vec<(u32, Plan)> {
        let from = from.unwrap_or(0);
        self.plans.iter().filter(|(id, _)| **id >= from).take(limit.unwrap_or(50) as usize).map(|(id, p)| (*id, p.clone())).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId { s.parse().unwrap() }
    fn ctx(by: &str, deposit: NearToken) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(acc(by)).attached_deposit(deposit).block_timestamp(1_000_000_000_000).build());
    }
    fn plan(c: &mut Plans, loosen: bool, sealed: Option<Sealed>) -> u32 {
        ctx("dev.testnet", NearToken::from_near(1));
        let id = c.create_plan(acc("coin.testnet"), acc("agent.testnet"), acc("dev.testnet"), U128(100), U64(60), U64(0), U64(120), 2000, sealed, loosen);
        ctx("coin.testnet", NearToken::from_yoctonear(0));
        c.ft_on_transfer(acc("dev.testnet"), U128(1_000), id.to_string());
        id
    }

    #[test]
    fn over_the_cap_is_busted_recorded_and_tightens() {
        let mut c = Plans::new();
        let id = plan(&mut c, true, None);
        ctx("agent.testnet", NearToken::from_yoctonear(0));
        assert!(!c.request_release(id, U128(150)));
        let p = c.get_plan(id).unwrap();
        assert_eq!((p.busted, p.cap.0, p.balance.0), (1, 80, 1_000));
    }

    #[test]
    fn under_the_cap_releases() {
        let mut c = Plans::new();
        let id = plan(&mut c, true, None);
        ctx("agent.testnet", NearToken::from_yoctonear(0));
        assert!(c.request_release(id, U128(60)));
        let p = c.get_plan(id).unwrap();
        assert_eq!((p.releases, p.balance.0, p.released_in_period.0), (1, 940, 60));
    }

    #[test]
    #[should_panic(expected = "only the plan's holder can ask")]
    fn only_the_holder_can_ask() {
        let mut c = Plans::new();
        let id = plan(&mut c, true, None);
        ctx("stranger.testnet", NearToken::from_yoctonear(0));
        c.request_release(id, U128(1));
    }

    #[test]
    #[should_panic(expected = "this plan was launched to never loosen")]
    fn a_plan_launched_not_to_loosen_never_loosens() {
        let mut c = Plans::new();
        let id = plan(&mut c, false, None);
        ctx("dev.testnet", NearToken::from_yoctonear(0));
        c.propose_loosen(id, U128(1_000));
    }

    #[test]
    #[should_panic(expected = "only the beneficiary can propose a loosening")]
    fn the_holder_can_never_loosen() {
        let mut c = Plans::new();
        let id = plan(&mut c, true, None);
        ctx("agent.testnet", NearToken::from_yoctonear(0));
        c.propose_loosen(id, U128(1_000));
    }

    #[test]
    fn reveal_is_checked_against_the_commitment_on_chain() {
        let text = "chok-sealed-v1|300|0|30|ab";
        let commitment: String = env::sha256(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        let sealed = Sealed { commitment, judge_url: "https://x".into(), judge_hash: "h".into(), outlayer: acc("outlayer.testnet"), secrets_owner: acc("dev.testnet"), secrets_profile: "p".into() };
        let mut c = Plans::new();
        let id = plan(&mut c, false, Some(sealed));
        ctx("anyone.testnet", NearToken::from_yoctonear(0));
        assert!(!c.reveal(id, U128(301), U64(0), U64(30), "ab".into()));
        assert!(c.get_plan(id).unwrap().revealed.is_none());
        assert!(c.reveal(id, U128(300), U64(0), U64(30), "ab".into()));
        assert_eq!(c.get_plan(id).unwrap().revealed.unwrap().max_per_release.0, 300);
    }
}
