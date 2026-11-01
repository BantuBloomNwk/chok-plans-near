//! The sealed judge. It runs inside an OutLayer TEE worker. The dev's exact release rules reach it
//! only as an encrypted secret that OutLayer decrypts inside the enclave, so the agent never holds
//! them. In the playground our server holds the seed they come from. It reads one request and prints one
//! verdict on stdout, plus the commitment of the rules it judged by, so the plan contract can
//! check those were the rules committed when the plan was made. The rules themselves never leave.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;

/// The sealed secret: either one plan's rules, or a master seed that gives every plan its own
/// rules (the playground, where each visitor's plan must stay sealed when another is revealed).

/// One plan's sealed rules.
#[derive(Deserialize)]
struct Rules {
    /// Biggest single release allowed, in the token's smallest unit.
    max_per_release: String,
    /// No release before this unix time, in seconds.
    earliest: u64,
    /// At least this many seconds between releases.
    min_gap_secs: u64,
    /// 32 random bytes, hex, so the commitment can't be guessed from likely rules.
    salt: String,
}

/// What the plan contract sends.
#[derive(Deserialize)]
struct Request {
    plan_id: u32,
    amount: String,
    now_secs: u64,
    last_release_secs: u64,
}

#[derive(Serialize)]
struct Verdict {
    plan_id: u32,
    cleared: bool,
    /// Which sealed rule refused it, or "" when cleared. Naming the rule, never its value.
    reason: &'static str,
    commitment: String,
}

/// sha256("chok-sealed-v1|max|earliest|gap|salt"), hex. The dev publishes this when the plan is made.
pub fn commitment(max: &str, earliest: u64, gap: u64, salt: &str) -> String {
    let d = Sha256::digest(format!("chok-sealed-v1|{max}|{earliest}|{gap}|{salt}").as_bytes());
    d.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A plan's own rules from the master seed: at most 2M to 4M per release and 20 to 40 seconds
/// apart, open at once, with a salt only this plan uses. Anyone with the seed gets the same rules.
pub fn derive(seed: &str, plan_id: u32) -> Rules {
    let h = Sha256::digest(format!("chok-rules-v1|{seed}|{plan_id}").as_bytes());
    let n = u32::from_le_bytes([h[0], h[1], h[2], h[3]]) as u64;
    let tokens = 2_000_000 + n % 2_000_001;
    let salt = hex(&Sha256::digest(format!("chok-salt-v1|{seed}|{plan_id}").as_bytes()));
    Rules { max_per_release: (tokens as u128 * 1_000_000).to_string(), earliest: 0, min_gap_secs: 20 + (h[4] as u64) % 21, salt }
}

fn judge(rules: &Rules, req: &Request) -> Verdict {
    let amount: u128 = req.amount.parse().unwrap_or(u128::MAX);
    let max: u128 = rules.max_per_release.parse().unwrap_or(0);
    let reason = if req.now_secs < rules.earliest {
        "too early"
    } else if req.last_release_secs > 0 && req.now_secs < req.last_release_secs + rules.min_gap_secs {
        "too soon after the last release"
    } else if amount > max {
        "too large"
    } else {
        ""
    };
    Verdict { plan_id: req.plan_id, cleared: reason.is_empty(), reason, commitment: commitment(&rules.max_per_release, rules.earliest, rules.min_gap_secs, &rules.salt) }
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("stdin");
    let req: Request = serde_json::from_str(&input).expect("a release request");
    let raw = std::env::var("RULES").expect("the sealed RULES secret");
    let v: serde_json::Value = serde_json::from_str(&raw).expect("rules");
    let rules = match v.get("seed").and_then(|s| s.as_str()) {
        Some(seed) => derive(seed, req.plan_id),
        None => serde_json::from_value(v).expect("one plan's rules"),
    };
    print!("{}", serde_json::to_string(&judge(&rules, &req)).unwrap());
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rules() -> Rules { Rules { max_per_release: "1000".into(), earliest: 100, min_gap_secs: 60, salt: "ab".into() } }
    fn req(amount: &str, now: u64, last: u64) -> Request { Request { plan_id: 7, amount: amount.into(), now_secs: now, last_release_secs: last } }
    #[test]
    fn clears_inside_the_rules() { assert!(judge(&rules(), &req("1000", 200, 0)).cleared); }
    #[test]
    fn refuses_each_rule_without_saying_its_value() {
        assert_eq!(judge(&rules(), &req("10", 50, 0)).reason, "too early");
        assert_eq!(judge(&rules(), &req("10", 200, 180)).reason, "too soon after the last release");
        assert_eq!(judge(&rules(), &req("1001", 200, 0)).reason, "too large");
    }
    #[test]
    fn each_plan_gets_its_own_rules_from_the_seed() {
        let (a, b) = (derive("s", 1), derive("s", 2));
        assert_ne!(commitment(&a.max_per_release, a.earliest, a.min_gap_secs, &a.salt), commitment(&b.max_per_release, b.earliest, b.min_gap_secs, &b.salt));
        let m: u128 = a.max_per_release.parse().unwrap();
        assert!((2_000_000_000_000..=4_000_000_000_000).contains(&m) && (20..=40).contains(&a.min_gap_secs));
        assert_eq!(derive("s", 1).salt, a.salt);
    }
    #[test]
    fn the_commitment_binds_every_rule() {
        let c = commitment("1000", 100, 60, "ab");
        assert_eq!(judge(&rules(), &req("1", 200, 0)).commitment, c);
        assert_ne!(c, commitment("1001", 100, 60, "ab"));
        assert_ne!(c, commitment("1000", 100, 60, "ac"));
    }
}
