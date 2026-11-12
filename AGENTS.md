# For agents and judges: every claim, and where to check it

Start with one command. It builds from clean, runs every test, checks every claim below against testnet with no keys, and builds the page:

```bash
npm install && npm run judge          # about 10 minutes, most of it the Rust build
npm run judge -- --quick              # skip the build and the Rust tests, about a minute
```

It prints PASS or FAIL per step and a table at the end. `npm run verify` on its own is the chain part. Set `NEAR_AI_KEY` and verify also attests the agent's model.

Each row below is a claim from the README, the code that makes it true, the test that pins it, and what to read on chain. Contract tests are in `contracts/<name>/src/lib.rs`; the judge's are in `judge/src/main.rs`. "verify N" is the numbered check list at the top of `scripts/verify.mjs`. "attack #N" is a row of [`attack-log.md`](attack-log.md), which links every transaction.

## Nobody can change the rules

| Claim | Code | Test | On chain |
|---|---|---|---|
| The plan, market, launcher and quick-try coin have never had an access key | `scripts/deploy-all.mjs` deploys with no key left | | verify 1 (`view_access_key_list` is empty) |
| The code running on each is this repo's build, byte for byte | `scripts/build.sh` (clean build, paths remapped) | judge step "The build changes no tracked file" | verify 2 (code hash on chain = sha256 of the local build) |
| Every launched coin has no keys, runs the launcher's token and is bound to its creator's plan | `contracts/launcher` | `a_launched_coin_brings_its_plan_with_its_bag_already_inside`, `only_a_coin_can_confirm`, `nothing_else_can_bring_a_plan_with_it` | verify 6 |
| Launch terms that would make a plan meaningless are refused before the coin exists | `contracts/launcher` | `the_whole_bag_as_a_cap_is_refused`, `a_one_second_period_is_refused`, `a_one_second_notice_is_refused`, `a_floor_of_nothing_is_refused`, `an_overflowing_period_is_refused_before_the_coin_exists` | attack log |
| A plan launched not to loosen never loosens | `contracts/plan` | `a_plan_launched_not_to_loosen_never_loosens` | attack log (the dev tries) |

## The plan enforces the cap

| Claim | Code | Test | On chain |
|---|---|---|---|
| Asking over the cap is refused, written down as Busted, and tightens the cap | `contracts/plan` `request_release` | `over_the_cap_is_busted_recorded_and_tightens` | attack log; every plan's log via `get_plan` |
| Busted tightens only down to the floor | `contracts/plan` | `busted_stops_at_the_floor`, `nobody_can_tighten_past_the_floor` | |
| Only the holder can ask, and a new holder waits out the public notice | `contracts/plan` | `only_the_holder_can_ask`, `a_new_holder_waits_out_the_notice` | attack log |
| Releases only ever go to the beneficiary | `contracts/plan` | `only_the_holder_can_ask` | attack #1 |

## The agent can only ask

| Claim | Code | Test | On chain |
|---|---|---|---|
| The agent's only key can call `request_release` on the plan contract and nothing else | `scripts/new-agent.mjs` | | verify 3 (the key's receiver and method list) |
| A prompt-injected model forced to pay an attacker is stopped by its key | `agent/brain.mjs` (tools), `server/demo.mjs` | `scripts/attack.mjs` | attack #32: the model's real `send_tokens` call to `attacker.testnet`, signed by its TEE, refused with `ReceiverMismatch` |
| It can't attach a deposit or call another method | | | attack #2 `MethodNameMismatch`, attack #3 `DepositWithFunctionCall` |
| If the model is down or fails attestation, a plain rule parser runs and the answer says so | `agent/brain.mjs` | | the page's *Under the hood* panel |

## Sealed rules stay sealed, and are proven

| Claim | Code | Test | On chain |
|---|---|---|---|
| Sealed plans can only be judged through OutLayer | `contracts/plan`, `contracts/launcher` | `a_plan_cannot_name_its_own_outlayer`, `a_fake_outlayer_is_refused_before_the_coin_exists` | verify 4 |
| The judge refuses a request without saying which rule or its value | `judge/src/main.rs` | `refuses_each_rule_without_saying_its_value`, `clears_inside_the_rules` | |
| The judge every plan pins is the judge it gets, and it is this repo's judge build | `judge/` | | verify 4 (sha256 of the hosted judge = the pinned hash = the local build) |
| A revealed plan's rules hash to the commitment it was made with, checked by the contract | `contracts/plan` `reveal` | `reveal_is_checked_against_the_commitment_on_chain`, `the_commitment_binds_every_rule` | verify 5 |
| Every verdict has a proof: OutLayer's record, Intel's signature and the chain | `scripts/judge-proof.mjs` | | verify (verdict checks) |
| A stuck verdict can be cleared, and a late one does nothing | `contracts/plan` | `a_stuck_wait_can_be_cleared_and_a_late_verdict_does_nothing`, `a_wait_cannot_be_cleared_early` | |
| A huge salt can't freeze the contract; each plan pays for its own judging | `contracts/plan` | `a_huge_salt_cannot_lock_up_the_contract`, `each_judged_request_costs_its_own_plan_and_anyone_can_fund_it`, `a_sealed_plan_with_no_budget_is_refused_before_any_money_moves` | attack log |

## The model is private and checked

| Claim | Code | On chain or live |
|---|---|---|
| The agent's model runs in a NEAR AI TEE and passes a fresh attestation: Intel TDX quote for our nonce, NVIDIA GPU evidence | `agent/attest.mjs` | verify 9 with `NEAR_AI_KEY` |
| Every answer the agent uses carries a signature from that enclave, and the page checks it | `agent/attest.mjs` | the page's *Verified* and *Under the hood* panels |
| The server keeps no prompts and no replies after it answers; the only record is the plan log | `server/demo.mjs` | |

## The market pays what it owes

| Claim | Code | Test | On chain |
|---|---|---|---|
| The market holds at least what all its pools and fees owe | `contracts/market` | `buy_then_sell_never_pays_out_more`, `the_smallest_buy_can_be_sold_back` | verify 7 |
| A failed buy can't drain a pool | `contracts/market` | `a_failed_buy_cannot_drain_a_pool`, `a_failed_buy_adds_nothing_to_a_sandwich`, `a_failed_buy_with_nothing_in_between_refunds_nearly_everything` | |
| Only coins from the launcher, bound to a plan, can list | `contracts/market` | `outside_coins_cannot_list`, `no_plan_no_listing`, `nested_accounts_cannot_list`, `tokens_sent_in_cannot_list_themselves` | verify 6 |
| Past a 2% price move the trade fails and nothing is lost | `contracts/market` | `slippage_limit_holds` | |

## The log is true

| Claim | Check |
|---|---|
| Every transaction in `attack-log.md` ended the way the log says | verify 8 (reads each one from an archive node) |
| There is no code from before the hackathon | the first commit, f45d68b, is 1 Nov 2026 07:23 UTC; the tag `hackathon-submission` is what we submitted |

What it isn't yet is in the README under "What it isn't, yet": testnet only, not audited, the playground server holds the demo's keys, and two of the listed wallets are untested.
