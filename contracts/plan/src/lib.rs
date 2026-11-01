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
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Plans {
    plans: IterableMap<u32, Plan>,
    next_id: u32,
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
        };
        event("plan_created", json!({ "plan": id, "token": plan.token, "holder": plan.holder, "beneficiary": plan.beneficiary, "cap": plan.cap, "period_secs": period_secs, "not_before": plan.not_before, "penalty_bps": penalty_bps }));
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

    /// The holder asks to release `amount` to the beneficiary. Over the cap, or before the plan
    /// opens: refused, recorded as Busted, and the cap tightens. Returns whether it was released.
    pub fn request_release(&mut self, plan_id: u32, amount: U128) -> bool {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let plan = self.plans.get_mut(&plan_id).unwrap_or_else(|| env::panic_str("no such plan"));
        require!(caller == plan.holder, "only the plan's holder can ask");
        require!(amount.0 > 0 && amount.0 <= plan.balance.0, "ask for more than zero and no more than the plan holds");
        if now >= plan.period_start.0 + plan.period_ns.0 {
            let periods = (now - plan.period_start.0) / plan.period_ns.0;
            plan.period_start = U64(plan.period_start.0 + periods * plan.period_ns.0);
            plan.released_in_period = U128(0);
        }
        let reason = if now < plan.not_before.0 {
            Some("not yet")
        } else if plan.released_in_period.0 + amount.0 > plan.cap.0 {
            Some("over the cap")
        } else {
            None
        };
        if let Some(reason) = reason {
            plan.busted += 1;
            let old = plan.cap.0;
            plan.cap = U128(old - old * plan.penalty_bps as u128 / 10_000);
            event("busted", json!({ "plan": plan_id, "by": caller, "asked": amount, "reason": reason, "cap_before": U128(old), "cap_after": plan.cap, "busted": plan.busted }));
            return false;
        }
        plan.released_in_period = U128(plan.released_in_period.0 + amount.0);
        plan.released_total = U128(plan.released_total.0 + amount.0);
        plan.balance = U128(plan.balance.0 - amount.0);
        plan.releases += 1;
        event("released", json!({ "plan": plan_id, "by": caller, "amount": amount, "to": plan.beneficiary, "released_in_period": plan.released_in_period, "cap": plan.cap }));
        let (token, to) = (plan.token.clone(), plan.beneficiary.clone());
        Promise::new(token)
            .function_call("ft_transfer".to_string(), json!({ "receiver_id": to, "amount": amount }).to_string().into_bytes(), NearToken::from_yoctonear(1), GAS_FT_TRANSFER)
            .then(Promise::new(env::current_account_id()).function_call("on_released".to_string(), json!({ "plan_id": plan_id, "amount": amount }).to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_CALLBACK));
        true
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

    pub fn get_plan(&self, plan_id: u32) -> Option<Plan> {
        self.plans.get(&plan_id).cloned()
    }

    pub fn list_plans(&self, from: Option<u32>, limit: Option<u32>) -> Vec<(u32, Plan)> {
        let from = from.unwrap_or(0);
        self.plans.iter().filter(|(id, _)| **id >= from).take(limit.unwrap_or(50) as usize).map(|(id, p)| (*id, p.clone())).collect()
    }
}
