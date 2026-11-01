//! CHOK plans, running on NEAR. A plan holds a dev's tokens (any NEP-141) and lets them out only
//! under a public cap per period. The plan's holder (the dev's everyday key, or an agent) can ask;
//! asking for more than the cap, or before the plan opens, is refused and recorded as Busted, and
//! each Busted tightens the cap. Loosening can only be proposed by the person the tokens go to,
//! never by the holder, and waits out a public notice that the person can cancel.
//!
//! A refusal is a successful transaction that moves nothing: the record of it is the point. So the
//! contract keeps each plan's own log, paid for from that plan's budget, and needs no indexer.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

const MAX_PENALTY_BPS: u16 = 5_000;
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_JUDGE: Gas = Gas::from_tgas(120);
const GAS_VERDICT: Gas = Gas::from_tgas(60);
/// Sent to OutLayer with each judged request, from the contract's balance (an agent's function-call
/// key cannot attach a deposit). OutLayer sends back what it doesn't use.
const JUDGE_DEPOSIT: NearToken = NearToken::from_millinear(50);
/// What each judged request costs its plan's budget. OutLayer charges about a fifth of this, and it
/// can only ever be OutLayer: the account is fixed when the contract is made.
const JUDGE_COST: NearToken = NearToken::from_millinear(5);
/// Paid to ask for a new holder, for the few extra bytes that takes.
const HOLDER_STORAGE: NearToken = NearToken::from_millinear(2);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Plans,
    Log,
    Index,
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
pub struct PendingHolder {
    pub holder: AccountId,
    pub effective_at: U64,
}

/// One line of a plan's log.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct LogEntry {
    pub at_ms: U64,
    pub block: U64,
    pub kind: String,
    pub by: Option<AccountId>,
    pub amount: Option<U128>,
    pub reason: Option<String>,
    /// The cap right after this happened.
    pub cap: U128,
}

/// What a plan is, before it holds anything. A launched coin's plan is made from these.
#[near(serializers = [json])]
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
    /// Set at launch and never changed: however often a plan is Busted, the cap stops here, and
    /// nobody can tighten past it. So a holder gone bad can't freeze the bag for good.
    pub min_cap: U128,
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
    /// A new holder waiting out the public notice, if the beneficiary asked for one.
    pub pending_holder: Option<PendingHolder>,
    /// NEAR set aside for this plan's judge and its log. Anyone may top it up with `fund_judge`.
    pub budget: U128,
    pub log_len: u32,
    /// Lines left out of the log because the budget ran out. The NEP-297 events still carry them.
    pub log_skipped: u32,
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
    /// The only account a sealed plan may send a judged request to.
    outlayer: AccountId,
    /// Only coins made directly under this account can bring a plan with them.
    launcher: AccountId,
    /// The judge code the page can call known, by sha256.
    judges: Vec<String>,
    log: LookupMap<(u32, u32), LogEntry>,
    /// Plans by the account that holds them or gets their releases.
    index: LookupMap<AccountId, Vec<u32>>,
}

/// Adds a line to a plan's log and takes its exact storage from the plan's budget. With no budget
/// left the line is counted as skipped, and the event still goes out.
fn note(log: &mut LookupMap<(u32, u32), LogEntry>, plan: &mut Plan, plan_id: u32, kind: &str, by: Option<AccountId>, amount: Option<U128>, reason: Option<&str>) {
    let entry = LogEntry { at_ms: U64(env::block_timestamp_ms()), block: U64(env::block_height()), kind: kind.to_string(), by, amount, reason: reason.map(str::to_string), cap: plan.cap };
    let before = env::storage_usage();
    log.insert((plan_id, plan.log_len), entry);
    log.flush();
    let cost = env::storage_byte_cost().as_yoctonear() * (env::storage_usage() - before) as u128;
    if plan.budget.0 >= cost {
        plan.budget = U128(plan.budget.0 - cost);
        plan.log_len += 1;
    } else {
        log.remove(&(plan_id, plan.log_len));
        log.flush();
        plan.log_skipped += 1;
    }
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
    plan.cap = U128((old - old * plan.penalty_bps as u128 / 10_000).max(plan.min_cap.0));
    event("busted", json!({ "plan": plan_id, "by": by, "asked": amount, "reason": reason, "cap_before": U128(old), "cap_after": plan.cap, "busted": plan.busted }));
}

fn release(plan: &mut Plan, plan_id: u32, by: &AccountId, amount: U128, now: u64) {
    plan.released_in_period = U128(plan.released_in_period.0 + amount.0);
    plan.released_total = U128(plan.released_total.0 + amount.0);
    plan.balance = U128(plan.balance.0 - amount.0);
    plan.releases += 1;
    plan.last_release = U64(now);
    event("released", json!({ "plan": plan_id, "by": by, "amount": amount, "to": plan.beneficiary, "released_in_period": plan.released_in_period, "cap": plan.cap }));
    let _ = Promise::new(plan.token.clone())
        .function_call("ft_transfer".to_string(), json!({ "receiver_id": plan.beneficiary, "amount": amount }).to_string().into_bytes(), NearToken::from_yoctonear(1), GAS_FT_TRANSFER)
        .then(Promise::new(env::current_account_id()).function_call("on_released".to_string(), json!({ "plan_id": plan_id, "amount": amount }).to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_CALLBACK));
}

fn event(name: &str, data: near_sdk::serde_json::Value) {
    log!("EVENT_JSON:{}", json!({ "standard": "chok-plans", "version": "1.0.0", "event": name, "data": [data] }));
}

#[near]
impl Plans {
    #[init]
    pub fn new(outlayer: AccountId, launcher: AccountId, judges: Vec<String>) -> Self {
        Self { plans: IterableMap::new(Key::Plans), next_id: 0, outlayer, launcher, judges, log: LookupMap::new(Key::Log), index: LookupMap::new(Key::Index) }
    }

    /// What every plan must satisfy, however it was made, then the plan itself. Whatever was
    /// attached beyond its storage becomes the plan's budget.
    fn make(&mut self, token: AccountId, beneficiary: AccountId, t: Terms, balance: u128) -> u32 {
        require!(t.cap.0 > 0, "the cap must be above zero");
        require!(t.min_cap.0 > 0 && t.min_cap.0 <= t.cap.0, "the cap's floor must be above zero and no more than the cap");
        require!(t.period_secs.0 > 0 && t.notice_secs.0 > 0, "periods and notice must be longer than zero");
        require!(t.penalty_bps <= MAX_PENALTY_BPS, "a Busted can tighten the cap by at most half");
        require!(t.holder != beneficiary || t.penalty_bps > 0, "a self-held plan needs a penalty");
        if let Some(sealed) = &t.sealed {
            require!(sealed.outlayer == self.outlayer, "a sealed plan can only be judged through OutLayer");
        }
        let used_before = env::storage_usage();
        let now = env::block_timestamp();
        let id = self.next_id;
        self.next_id += 1;
        let plan = Plan {
            token, holder: t.holder, beneficiary, cap: t.cap, min_cap: t.min_cap,
            period_ns: U64(t.period_secs.0 * 1_000_000_000),
            period_start: U64(now),
            released_in_period: U128(0), released_total: U128(0), balance: U128(balance),
            not_before: U64(now + t.start_in_secs.0 * 1_000_000_000),
            notice_ns: U64(t.notice_secs.0 * 1_000_000_000),
            penalty_bps: t.penalty_bps, releases: 0, busted: 0, tightenings: 0, loosenings: 0, pending: None,
            sealed: t.sealed, last_release: U64(0), awaiting: None, loosen_allowed: t.loosen_allowed, revealed: None,
            pending_holder: None, budget: U128(0), log_len: 0, log_skipped: 0,
        };
        event("plan_created", json!({ "loosen_allowed": t.loosen_allowed, "plan": id, "token": plan.token, "holder": plan.holder, "beneficiary": plan.beneficiary, "cap": plan.cap, "min_cap": plan.min_cap, "period_secs": t.period_secs, "not_before": plan.not_before, "penalty_bps": t.penalty_bps, "sealed_commitment": plan.sealed.as_ref().map(|s| s.commitment.clone()), "judge_hash": plan.sealed.as_ref().map(|s| s.judge_hash.clone()) }));
        for who in [plan.holder.clone(), plan.beneficiary.clone()] {
            let mut list = self.index.get(&who).cloned().unwrap_or_default();
            if !list.contains(&id) { list.push(id); }
            self.index.insert(who, list);
        }
        self.index.flush();
        self.plans.insert(id, plan);
        self.plans.flush();
        let cost = env::storage_byte_cost().as_yoctonear() * (env::storage_usage() - used_before) as u128;
        let paid = env::attached_deposit().as_yoctonear();
        require!(paid >= cost, format!("attach at least {cost} yoctoNEAR for storage"));
        self.plans.get_mut(&id).unwrap().budget = U128(paid - cost);
        id
    }

    /// Make a plan. Whoever calls it pays the storage, and anything more they attach is the plan's
    /// budget. The tokens arrive afterwards through `ft_transfer_call` with the plan id as the message.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn create_plan(
        &mut self,
        token: AccountId,
        holder: AccountId,
        beneficiary: AccountId,
        cap: U128,
        min_cap: U128,
        period_secs: U64,
        start_in_secs: U64,
        notice_secs: U64,
        penalty_bps: u16,
        sealed: Option<Sealed>,
        loosen_allowed: bool,
    ) -> u32 {
        self.make(token, beneficiary, Terms { holder, cap, min_cap, period_secs, start_in_secs, notice_secs, penalty_bps, sealed, loosen_allowed }, 0)
    }

    /// A coin the launcher just made brings its plan with it: the dev's share was minted straight
    /// to this contract in the same transaction. Only a direct sub-account of the launcher can call
    /// this, and only the launcher can make those, and it only ever deploys one token.
    #[payable]
    pub fn create_launched(&mut self, dev: AccountId, terms: Terms, amount: U128) -> u32 {
        let token = env::predecessor_account_id();
        let suffix = format!(".{}", self.launcher);
        let label = token.as_str().strip_suffix(&suffix).unwrap_or_else(|| env::panic_str("only coins made by the launcher"));
        require!(!label.is_empty() && !label.contains('.'), "only coins made by the launcher");
        self.make(token, dev, terms, amount.0)
    }

    /// Anyone may add to a plan's budget, which pays for its judge and its log.
    #[payable]
    pub fn fund_judge(&mut self, plan_id: u32) -> U128 {
        let plan = self.plans.get_mut(&plan_id).unwrap_or_else(|| env::panic_str("no such plan"));
        plan.budget = U128(plan.budget.0 + env::attached_deposit().as_yoctonear());
        plan.budget
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
            note(&mut self.log, plan, plan_id, "busted", Some(caller), Some(amount), Some(reason));
            return false;
        }
        if let Some(sealed) = plan.sealed.clone() {
            require!(plan.budget.0 >= JUDGE_COST.as_yoctonear(), "this plan's judge budget has run out; anyone can top it up with fund_judge");
            plan.budget = U128(plan.budget.0 - JUDGE_COST.as_yoctonear());
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
            let _ = Promise::new(sealed.outlayer)
                .function_call("request_execution".to_string(), args.to_string().into_bytes(), JUDGE_DEPOSIT, GAS_JUDGE)
                .then(Promise::new(env::current_account_id()).function_call("on_verdict".to_string(), json!({ "plan_id": plan_id, "amount": amount, "by": caller }).to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_VERDICT));
            return true;
        }
        release(plan, plan_id, &caller, amount, now);
        note(&mut self.log, plan, plan_id, "released", Some(caller), Some(amount), None);
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
            note(&mut self.log, plan, plan_id, "busted", Some(by), Some(amount), Some(reason));
            return;
        }
        if amount.0 > plan.balance.0 { event("judge_failed", json!({ "plan": plan_id, "asked": amount, "why": "balance moved" })); return; }
        if let Some(reason) = public_refusal(plan, amount.0, now) {
            bust(plan, plan_id, &by, amount, reason);
            note(&mut self.log, plan, plan_id, "busted", Some(by), Some(amount), Some(reason));
            return;
        }
        release(plan, plan_id, &by, amount, now);
        note(&mut self.log, plan, plan_id, "released", Some(by), Some(amount), None);
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
        note(&mut self.log, plan, plan_id, "reverted", None, Some(amount), Some("the transfer failed, so the tokens went back in"));
    }

    /// Tighten the cap, at once. The holder or the beneficiary may; it also drops any pending loosening.
    pub fn tighten(&mut self, plan_id: u32, cap: U128) {
        let caller = env::predecessor_account_id();
        let plan = self.plans.get_mut(&plan_id).unwrap_or_else(|| env::panic_str("no such plan"));
        require!(caller == plan.holder || caller == plan.beneficiary, "only the holder or the beneficiary");
        require!(cap.0 >= plan.min_cap.0 && cap.0 < plan.cap.0, "tightening means a smaller cap, and never below the floor set at launch");
        plan.cap = cap;
        plan.tightenings += 1;
        plan.pending = None;
        event("tightened", json!({ "plan": plan_id, "by": caller, "cap": cap }));
        note(&mut self.log, plan, plan_id, "tightened", Some(caller), Some(cap), None);
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
        note(&mut self.log, plan, plan_id, "loosen_proposed", Some(caller), Some(cap), None);
    }

    pub fn cancel_loosen(&mut self, plan_id: u32) {
        let plan = self.plans.get_mut(&plan_id).unwrap_or_else(|| env::panic_str("no such plan"));
        require!(env::predecessor_account_id() == plan.beneficiary, "only the beneficiary");
        require!(plan.pending.is_some(), "nothing pending");
        plan.pending = None;
        event("loosen_cancelled", json!({ "plan": plan_id }));
        note(&mut self.log, plan, plan_id, "loosen_cancelled", Some(env::predecessor_account_id()), None, None);
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
        note(&mut self.log, plan, plan_id, "loosen_applied", None, Some(p.cap), None);
    }

    /// The beneficiary may replace a dead or compromised holder, after the same public notice as a
    /// loosening. It can't let anything more out: the new holder is under the same cap.
    #[payable]
    pub fn propose_holder(&mut self, plan_id: u32, holder: AccountId) {
        require!(env::attached_deposit() >= HOLDER_STORAGE, "attach 0.002 NEAR for storage");
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let plan = self.plans.get_mut(&plan_id).unwrap_or_else(|| env::panic_str("no such plan"));
        require!(caller == plan.beneficiary, "only the beneficiary can replace the holder");
        require!(holder != plan.holder, "that is already the holder");
        let effective_at = U64(now + plan.notice_ns.0);
        plan.pending_holder = Some(PendingHolder { holder: holder.clone(), effective_at });
        event("holder_proposed", json!({ "plan": plan_id, "holder": holder, "effective_at": effective_at }));
        note(&mut self.log, plan, plan_id, "holder_proposed", Some(caller), None, Some(holder.as_str()));
    }

    pub fn cancel_holder(&mut self, plan_id: u32) {
        let plan = self.plans.get_mut(&plan_id).unwrap_or_else(|| env::panic_str("no such plan"));
        require!(env::predecessor_account_id() == plan.beneficiary, "only the beneficiary");
        require!(plan.pending_holder.is_some(), "nothing pending");
        plan.pending_holder = None;
        event("holder_cancelled", json!({ "plan": plan_id }));
        note(&mut self.log, plan, plan_id, "holder_cancelled", Some(env::predecessor_account_id()), None, None);
    }

    /// Anyone may apply a new holder once its notice has run out.
    pub fn apply_holder(&mut self, plan_id: u32) {
        let now = env::block_timestamp();
        let plan = self.plans.get_mut(&plan_id).unwrap_or_else(|| env::panic_str("no such plan"));
        let p = plan.pending_holder.clone().unwrap_or_else(|| env::panic_str("nothing pending"));
        require!(now >= p.effective_at.0, "the notice has not run out");
        let old = std::mem::replace(&mut plan.holder, p.holder.clone());
        plan.pending_holder = None;
        let beneficiary = plan.beneficiary.clone();
        event("holder_applied", json!({ "plan": plan_id, "holder": p.holder, "was": old }));
        note(&mut self.log, plan, plan_id, "holder_applied", None, None, Some(p.holder.as_str()));
        if old != beneficiary {
            if let Some(list) = self.index.get_mut(&old) { list.retain(|x| *x != plan_id); }
        }
        let mut list = self.index.get(&p.holder).cloned().unwrap_or_default();
        if !list.contains(&plan_id) { list.push(plan_id); }
        self.index.insert(p.holder, list);
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
            note(&mut self.log, plan, plan_id, "revealed", Some(env::predecessor_account_id()), None, None);
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

    /// Plans in id order from `from`. Ids are dense and plans are never deleted.
    pub fn list_plans(&self, from: Option<u32>, limit: Option<u32>) -> Vec<(u32, Plan)> {
        let from = from.unwrap_or(0);
        (from..self.next_id.min(from.saturating_add(limit.unwrap_or(50)))).filter_map(|id| self.plans.get(&id).map(|p| (id, p.clone()))).collect()
    }

    /// The plans this account holds or gets the releases of, so a page never has to read them all.
    pub fn plans_of(&self, account: AccountId) -> Vec<(u32, Plan)> {
        self.index.get(&account).map_or(vec![], |ids| ids.iter().filter_map(|id| self.plans.get(id).map(|p| (*id, p.clone()))).collect())
    }

    /// A plan's log, oldest first.
    pub fn get_log(&self, plan_id: u32, from: Option<u32>, limit: Option<u32>) -> Vec<LogEntry> {
        let count = self.plans.get(&plan_id).map_or(0, |p| p.log_len);
        let from = from.unwrap_or(0);
        (from..count.min(from.saturating_add(limit.unwrap_or(100)))).filter_map(|n| self.log.get(&(plan_id, n)).cloned()).collect()
    }

    pub fn outlayer(&self) -> AccountId {
        self.outlayer.clone()
    }

    pub fn launcher(&self) -> AccountId {
        self.launcher.clone()
    }

    pub fn known_judges(&self) -> Vec<String> {
        self.judges.clone()
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
    fn new_book() -> Plans { Plans::new(acc("outlayer.testnet"), acc("launcher.testnet"), vec!["h".into()]) }
    fn ctx_at(by: &str, deposit: NearToken, ns: u64) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(acc(by)).attached_deposit(deposit).block_timestamp(ns).build());
    }
    fn plan(c: &mut Plans, loosen: bool, sealed: Option<Sealed>) -> u32 {
        ctx("dev.testnet", NearToken::from_near(1));
        let id = c.create_plan(acc("coin.testnet"), acc("agent.testnet"), acc("dev.testnet"), U128(100), U128(10), U64(60), U64(0), U64(120), 2000, sealed, loosen);
        ctx("coin.testnet", NearToken::from_yoctonear(0));
        c.ft_on_transfer(acc("dev.testnet"), U128(1_000), id.to_string());
        id
    }

    #[test]
    fn over_the_cap_is_busted_recorded_and_tightens() {
        let mut c = new_book();
        let id = plan(&mut c, true, None);
        ctx("agent.testnet", NearToken::from_yoctonear(0));
        assert!(!c.request_release(id, U128(150)));
        let p = c.get_plan(id).unwrap();
        assert_eq!((p.busted, p.cap.0, p.balance.0), (1, 80, 1_000));
    }

    #[test]
    fn under_the_cap_releases() {
        let mut c = new_book();
        let id = plan(&mut c, true, None);
        ctx("agent.testnet", NearToken::from_yoctonear(0));
        assert!(c.request_release(id, U128(60)));
        let p = c.get_plan(id).unwrap();
        assert_eq!((p.releases, p.balance.0, p.released_in_period.0), (1, 940, 60));
    }

    #[test]
    #[should_panic(expected = "only the plan's holder can ask")]
    fn only_the_holder_can_ask() {
        let mut c = new_book();
        let id = plan(&mut c, true, None);
        ctx("stranger.testnet", NearToken::from_yoctonear(0));
        c.request_release(id, U128(1));
    }

    #[test]
    #[should_panic(expected = "this plan was launched to never loosen")]
    fn a_plan_launched_not_to_loosen_never_loosens() {
        let mut c = new_book();
        let id = plan(&mut c, false, None);
        ctx("dev.testnet", NearToken::from_yoctonear(0));
        c.propose_loosen(id, U128(1_000));
    }

    #[test]
    #[should_panic(expected = "only the beneficiary can propose a loosening")]
    fn the_holder_can_never_loosen() {
        let mut c = new_book();
        let id = plan(&mut c, true, None);
        ctx("agent.testnet", NearToken::from_yoctonear(0));
        c.propose_loosen(id, U128(1_000));
    }

    #[test]
    fn reveal_is_checked_against_the_commitment_on_chain() {
        let text = "chok-sealed-v1|300|0|30|ab";
        let commitment: String = env::sha256(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        let s = Sealed { commitment, judge_url: "https://x".into(), judge_hash: "h".into(), outlayer: acc("outlayer.testnet"), secrets_owner: acc("dev.testnet"), secrets_profile: "p".into() };
        let mut c = new_book();
        let id = plan(&mut c, false, Some(s));
        ctx("anyone.testnet", NearToken::from_yoctonear(0));
        assert!(!c.reveal(id, U128(301), U64(0), U64(30), "ab".into()));
        assert!(c.get_plan(id).unwrap().revealed.is_none());
        assert!(c.reveal(id, U128(300), U64(0), U64(30), "ab".into()));
        assert_eq!(c.get_plan(id).unwrap().revealed.unwrap().max_per_release.0, 300);
    }

    fn sealed(outlayer: &str) -> Sealed {
        Sealed { commitment: "c".into(), judge_url: "https://x".into(), judge_hash: "h".into(), outlayer: acc(outlayer), secrets_owner: acc("dev.testnet"), secrets_profile: "p".into() }
    }

    #[test]
    #[should_panic(expected = "a sealed plan can only be judged through OutLayer")]
    fn a_plan_cannot_name_its_own_outlayer() {
        let mut c = new_book();
        plan(&mut c, false, Some(sealed("attacker.testnet")));
    }

    #[test]
    #[should_panic(expected = "judge budget has run out")]
    fn a_sealed_plan_with_no_budget_is_refused_before_any_money_moves() {
        let mut c = new_book();
        let s = sealed("outlayer.testnet");
        let id = plan(&mut c, false, Some(s));
        c.plans.get_mut(&id).unwrap().budget = U128(0);
        ctx("agent.testnet", NearToken::from_yoctonear(0));
        c.request_release(id, U128(1));
    }

    #[test]
    fn each_judged_request_costs_its_own_plan_and_anyone_can_fund_it() {
        let mut c = new_book();
        let id = plan(&mut c, false, Some(sealed("outlayer.testnet")));
        let b0 = c.get_plan(id).unwrap().budget.0;
        ctx("agent.testnet", NearToken::from_yoctonear(0));
        assert!(c.request_release(id, U128(1)));
        assert_eq!(c.get_plan(id).unwrap().budget.0, b0 - JUDGE_COST.as_yoctonear());
        ctx("stranger.testnet", NearToken::from_millinear(10));
        c.fund_judge(id);
        assert_eq!(c.get_plan(id).unwrap().budget.0, b0 - JUDGE_COST.as_yoctonear() + NearToken::from_millinear(10).as_yoctonear());
    }

    #[test]
    fn busted_stops_at_the_floor() {
        let mut c = new_book();
        let id = plan(&mut c, false, None);
        ctx("agent.testnet", NearToken::from_yoctonear(0));
        for _ in 0..30 { assert!(!c.request_release(id, U128(500))); }
        let p = c.get_plan(id).unwrap();
        assert_eq!((p.busted, p.cap.0), (30, 10));
    }

    #[test]
    #[should_panic(expected = "never below the floor")]
    fn nobody_can_tighten_past_the_floor() {
        let mut c = new_book();
        let id = plan(&mut c, false, None);
        ctx("agent.testnet", NearToken::from_yoctonear(0));
        c.tighten(id, U128(9));
    }

    #[test]
    #[should_panic(expected = "the cap's floor must be")]
    fn the_floor_cannot_sit_above_the_cap() {
        let mut c = new_book();
        ctx("dev.testnet", NearToken::from_near(1));
        c.create_plan(acc("coin.testnet"), acc("a.testnet"), acc("dev.testnet"), U128(100), U128(101), U64(60), U64(0), U64(120), 2000, None, false);
    }

    #[test]
    fn the_beneficiary_replaces_the_holder_after_the_notice() {
        let mut c = new_book();
        let id = plan(&mut c, false, None);
        ctx_at("dev.testnet", HOLDER_STORAGE, 1_000_000_000_000);
        c.propose_holder(id, acc("new.testnet"));
        ctx_at("anyone.testnet", NearToken::from_yoctonear(0), 1_000_000_000_000 + 120_000_000_000);
        c.apply_holder(id);
        let p = c.get_plan(id).unwrap();
        assert_eq!(p.holder, acc("new.testnet"));
        assert_eq!(c.plans_of(acc("new.testnet")).len(), 1);
        assert_eq!(c.plans_of(acc("agent.testnet")).len(), 0);
        assert_eq!(c.plans_of(acc("dev.testnet")).len(), 1);
    }

    #[test]
    #[should_panic(expected = "the notice has not run out")]
    fn a_new_holder_waits_out_the_notice() {
        let mut c = new_book();
        let id = plan(&mut c, false, None);
        ctx("dev.testnet", HOLDER_STORAGE);
        c.propose_holder(id, acc("new.testnet"));
        c.apply_holder(id);
    }

    #[test]
    #[should_panic(expected = "only the beneficiary can replace the holder")]
    fn the_holder_cannot_replace_itself() {
        let mut c = new_book();
        let id = plan(&mut c, false, None);
        ctx("agent.testnet", HOLDER_STORAGE);
        c.propose_holder(id, acc("friend.testnet"));
    }

    #[test]
    fn the_log_keeps_every_release_and_busted_and_stops_when_the_budget_does() {
        let mut c = new_book();
        let id = plan(&mut c, false, None);
        ctx("agent.testnet", NearToken::from_yoctonear(0));
        c.request_release(id, U128(50));
        c.request_release(id, U128(500));
        let log = c.get_log(id, None, None);
        assert_eq!(log.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["released", "busted"]);
        assert_eq!(log[1].cap.0, 80);
        assert_eq!(log[1].reason.as_deref(), Some("over the cap"));
        c.plans.get_mut(&id).unwrap().budget = U128(0);
        c.request_release(id, U128(500));
        let p = c.get_plan(id).unwrap();
        assert_eq!((p.busted, p.log_len, p.log_skipped), (2, 2, 1));
    }

    #[test]
    fn a_launched_coin_brings_its_plan_with_its_bag_already_inside() {
        let mut c = new_book();
        ctx("dan-1.launcher.testnet", NearToken::from_near(1));
        let t = Terms { holder: acc("dev.testnet"), cap: U128(100), min_cap: U128(10), period_secs: U64(60), start_in_secs: U64(0), notice_secs: U64(60), penalty_bps: 2000, sealed: None, loosen_allowed: false };
        let id = c.create_launched(acc("dev.testnet"), t, U128(200));
        let p = c.get_plan(id).unwrap();
        assert_eq!((p.balance.0, p.token.as_str(), p.beneficiary.as_str()), (200, "dan-1.launcher.testnet", "dev.testnet"));
    }

    #[test]
    #[should_panic(expected = "only coins made by the launcher")]
    fn nothing_else_can_bring_a_plan_with_it() {
        let mut c = new_book();
        ctx("evil.testnet", NearToken::from_near(1));
        let t = Terms { holder: acc("dev.testnet"), cap: U128(100), min_cap: U128(10), period_secs: U64(60), start_in_secs: U64(0), notice_secs: U64(60), penalty_bps: 2000, sealed: None, loosen_allowed: false };
        c.create_launched(acc("dev.testnet"), t, U128(200));
    }

    #[test]
    fn listing_from_a_later_id_does_not_walk_every_plan() {
        let mut c = new_book();
        for _ in 0..5 { plan(&mut c, false, None); }
        let ids: Vec<u32> = c.list_plans(Some(3), Some(50)).into_iter().map(|(i, _)| i).collect();
        assert_eq!(ids, [3, 4]);
    }
}
