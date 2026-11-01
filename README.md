# CHOK plans, running on NEAR

On most launchpads the dev can sell their whole bag the minute it suits them. Holders find out when the chart does.

CHOK is a launchpad where that can't happen quietly. Every coin launches with a **plan**: a contract that holds the dev's tokens and lets them out only under a public cap. Ask for more, and the contract says no, writes the attempt down as **Busted**, and tightens the cap. Nothing moves, and everyone can see it.

Everything else works like a launchpad should. Anyone can launch a coin, and anyone can buy it and sell it on a bonding curve, with a live chart and a trade tape that come straight from the chain. The difference is that the dev's own sells show up on that tape, marked, and only ever in amounts the plan allowed.

This repo is CHOK on NEAR testnet. The live demo is at **https://chok-plans-near.netlify.app**.

## Try it in five minutes

No wallet needed for steps 1 to 5.

1. **Get a plan.** In "Quick try", press *Get a plan*. You get a sealed plan with 20M tokens inside, a public cap of 10M a minute, a floor of 1M, and secret rules nobody has told the agent. The commitment to those rules is shown on the card, and your browser reads it from the plan on chain.
2. **Try to dump it.** Press *Dump it all*, or type `dump everything`. You'll see **BUSTED**: over the public cap if the agent asks for all 20M, or by a sealed rule if it asks for less. Either way the cap drops to 8M, and the plan log gets a line.
3. **Play by the rules, then break them.** Press *Release 1M, then 1M again*. The first is judged in the enclave and **RELEASED**. The second lands too soon and is **BUSTED**, by a sealed rule whose value you still can't see.
4. **Check the agent.** Open *Verified* above the console for the contract and TEE checks. Open *Under the hood* on any answer for the model's system prompt, every raw tool call, what the chain said back and the signature on every answer.
5. **Reveal.** Press *Reveal my plan's rules*. The rules come out, the contract hashes them against the commitment from step 1, and records them. Every verdict above now makes sense.
6. **Trade.** In "Trade", pick a coin. The chart and the tape come from the market contract. The Danfo Dog coin's trades are real transactions from test wallets of ours (`scripts/showcase.mjs`), so there's something to look at. Each face on the chart is a trader, the one with the crown is the dev, and stamps along the top show what the plan did, read from the plan's own log on chain. Add `?sample` to the URL to see the chart on 400 made-up trades, labelled as sample data. Connect a testnet wallet to buy with NEAR and sell back.
7. **Be the dev.** Connect a wallet, set your plan's terms and launch. One transaction makes the coin, puts 80% on sale and your 20% in the plan, so you never hold it loose. Leave the loosening box unticked and that plan can never be loosened. You can make an agent the holder.
8. **Check us.** Run the commands under [Running it yourself](#running-it-yourself). `npm run verify` needs no keys. `node scripts/attack.mjs --account you.testnet` attacks a plan from your own testnet account, and the last run is in [`attack-log.md`](attack-log.md).

## What's on testnet

| Account | What it is |
| --- | --- |
| `planbook.chokplans-mvxhykzp.testnet` | The plan contract. **It has never had an access key**, so nobody, us included, can redeploy or change it. |
| `market2.chokplans-mvxhykzp.testnet` | The market. **Never had a key.** |
| `launch2.chokplans-mvxhykzp.testnet` | The launcher. **Never had a key.** It deploys one embedded token, and every coin is `<ticker>-<n>.launch2.chokplans-mvxhykzp.testnet`, also with no keys. |
| `planagent.chokplans-mvxhykzp.testnet` | The quick-try agent. Its only key can call `request_release` on the plan contract. |
| `busdog2.chokplans-mvxhykzp.testnet` | BUSDOG, the coin the quick-try plans hold. **Never had a key.** |

`npm run verify` checks every claim in that table against the chain, and that the code on each is this repo's build. It also checks that the judge every plan pins is the judge it gets, that every revealed plan matches its commitment, that every coin came from the launcher and is bound to its plan, that the market can pay what it owes, and that the model passes a fresh attestation.

With no NEAR AI key and after `npm run build`, expect 21 passed and 0 failed, with 1 skipped for the model. With a key (`NEAR_AI_KEY=...`), the model's checks run too: 28 passed. Without `npm run build` the code checks skip, and nothing should fail.

## How it works

### The plan

- It **holds the dev's tokens.** Any NEP-141 token can go in.
- It **lets them out under a public cap per period**, such as 20M a minute. The cap, the period, the penalty and the start time are set when the plan is made, and anyone can read them.
- It **refuses anything more, on the record.** A request over the cap is still a successful transaction. It moves nothing, records a Busted stamp, and cuts the cap by the plan's penalty, never past a floor set at launch. Asking for too much makes the next request smaller, but a holder gone bad can't freeze the bag for good.
- It **keeps its own log on chain** (`get_log`): every release, Busted, judge failure and change of terms, paid for from the plan's budget. Deposits and top-ups are events only, and budgets can't be withdrawn. Nobody's server is involved in reading it.
- **The beneficiary can replace the holder**, after the same public notice as a loosening. The new holder is under the same cap.
- **The holder can never loosen it.** Only the beneficiary (the person the tokens go to) can propose a looser cap. It then waits out a public notice that they can cancel at any time. A plan can also be launched to never loosen at all, and the demo's plans are.

### Sealed rules

A known selling schedule is easy to trade ahead of. A sealed plan adds secret rules on top of the public cap: the biggest single release, the earliest time anything can leave, and the minimum gap between releases.

1. When the plan is made, the dev publishes a commitment: the sha256 of the rules plus a random salt. The plan also gets a budget, paid when it's made, that its judged requests draw on. Anyone can top it up with `fund_judge`.
2. The rules live as an encrypted secret with [OutLayer](https://docs.near.org/primitives/off-chain-compute/outlayer), which only opens it inside an Intel TDX enclave, for one judge program pinned by its sha256, and only when the call comes through the plan contract.
3. Each request goes to that judge. It answers cleared or refused, names the rule that refused (never its value), and sends back the hash of the rules it used.
4. The plan releases only if that hash matches the commitment, the judge cleared it, and the public cap still allows it.

The agent never sees the rules, so it has nothing to leak. Guessing costs it: every wrong guess is Busted and shrinks the cap, down to the floor. The public cap is enforced by the contract underneath, so even a broken enclave can't let out more than the public plan allows.

### The agent

The agent thinks with a model on [NEAR AI Cloud](https://docs.near.ai/cloud) (`deepseek-ai/DeepSeek-V4.1-Flash-1017`, served from a TEE), and acts with one NEAR key.

- **The model holds no keys.** It can call four tools: `read_plan`, `request_release`, `send_tokens` and `propose_loosen`. Each call is signed by the agent account's only key, a function-call key for `request_release` on the plan contract. `send_tokens` and `propose_loosen` are there so you can watch NEAR refuse them.
- **The model is checked before it's trusted.** `agent/attest.mjs` asks for an attestation report with a fresh random nonce. It then checks:
  - Intel's signature on the TDX quote (with `@phala/dcap-qvl`);
  - that the quote's report data holds both the model's signing address and our nonce;
  - that NVIDIA's attestation service accepts the GPU evidence for that same nonce;
  - that the TDX event log replays to the quote's RTMR3;
  - that the app's compose file hashes to the quote's MRCONFIGID and the log's compose-hash event.
- **Every answer is checked after.** The response signature must recover to the attested address, and its hashes must match the exact bytes we sent and got back.
- If the model is down, a plain rule parser stands in, and the answer says so.

### The market

Each coin gets a bonding curve in `contracts/market`: a constant-product curve over the coin's sale supply, with a virtual reserve of 3 NEAR on one side and a quarter of the sale supply on the other.

- Buy with NEAR from 0.0075 up, and sell back for NEAR any time, unless what you're selling is worth under about 0.003 NEAR.
- Every trade carries a slippage limit: if the price moves past it before the trade lands, nothing happens.
- 1% of each trade goes to the coin's creator, which they can claim at any time.
- Selling out the whole curve raises 12 NEAR. At that point the curve is simply closed to buyers: sellers can still sell back, and nothing moves to a DEX.
- The last buyer pays only for the tokens that are left, and the rest of their NEAR comes back in the same transaction.
- A pool only ever pays out NEAR its buyers put in. A dev's sells are paid from that pool too, and they lower what later sellers get, which is why they're marked on the chart and the tape. `npm run verify` checks that any pool that couldn't pay its sellers at curve prices is one a dev sold into, and that the contract as a whole can pay what it owes.
- Every trade's storage is measured and charged exactly, and what wasn't used goes back to the trader.
- Every trade is kept on the contract (`get_trades`). The chart and the tape need nobody's server.

### The launcher

`contracts/launcher` has no keys and embeds one token. One call to `launch` makes the coin in a new account with no keys, mints 800M straight to the market and 200M straight to the plan contract, makes the plan with the terms given, and lists the coin with that plan's id on the pool. The market and the plan contract accept these calls only from a direct sub-account of the launcher, and only the launcher can make those. So there is no way to list a coin without a plan, and no moment when a dev holds their share loose. The dev can only sell what that plan lets out.

## The four tracks

**Security.** The agent is a policy engine bolted to one key. Its function-call key can call one method on one contract, can't attach a deposit, and can't move NEAR or add keys. A prompt-injected agent can only ask, and the plan answers. `scripts/attack.mjs` runs 27 attacks and 3 checks from your own testnet account: the agent paying a friend, freezing its own plan, a stranger faking the judge's verdict or draining the contract through a fake OutLayer, a fake launch, a huge salt, launch terms that make a plan meaningless, the dev loosening a never-loosen plan, made-up rules, two prompt injections, and an agent with its model off really paying a bad address and being stopped by its key. All 27 held in our last run, each refused for the reason expected, and [`attack-log.md`](attack-log.md) links every transaction.

**Privacy.** Two kinds of secrets stay secret while still giving public answers. The dev's selling rules are judged inside an OutLayer enclave and proven against a commitment. The agent's model runs in a NEAR AI TEE, and the page shows the attestation and signature checks on every answer. The server keeps no prompts and no replies after it answers. The only record it keeps is the plan log: what was asked, what the chain said, and the transaction.

**Memecoins.** The mechanic lives in contracts, not in our backend. Every parameter is set at launch and readable on chain, and none of the contracts that matter has ever had a key that could change it: not the launcher, not any coin, not the plan, not the market. The launcher binds every coin to its plan in the transaction that makes it. The page shows each plan's state and its log of every release and Busted from the chain, the mints are NEP-141 events, and sells from the dev's own account are marked on the chart and the tape. A dev who sends released tokens to a second account first sells unmarked: nothing here can stop that.

**Open.** The rules are in a readable contract. The beneficiary can cancel a pending loosening until its notice runs out. The demo's timers are in minutes and seconds, so you can watch them run out.

## When things go wrong

- **A plan's budget runs out.** Sealed requests are refused, with no Busted and nothing moved, until anyone tops it up with `fund_judge`. Log lines are counted as skipped, and the events still go out.
- **The judge doesn't answer, or crashes.** The plan records `judge_failed`, moves nothing, and stops waiting, so the next request can go in.
- **The judge answers for the wrong rules or the wrong plan.** Its hash or plan id won't match, so the plan records `judge_mismatch` and moves nothing.
- **Someone swaps the judge's code at its URL.** OutLayer checks the sha256 the plan pins and won't run it.
- **The agent's gas allowance runs out.** Its function-call key stops working, and nobody can fix that: an account with only a function-call key can't add keys, and NEAR gives its parent account no power over it. The agent is dead. Nothing in the plan is at risk, and the beneficiary replaces the holder after the public notice.
- **A holder is compromised.** It can ask for releases, which only ever go to the beneficiary, and each bad ask cuts the cap down to the floor and no further. The beneficiary replaces it after the public notice.
- **The model is down, or fails attestation.** The agent won't use it. A plain rule parser takes over, and the answer says which one ran.
- **The model is talked into something.** It can only ask the plan. Everything it asks for is judged like any other request.
- **A buy's tokens can't be delivered.** The buyer sells them back at the curve as it stands then, with no fee, from that pool only. Usually that's their money back. If others traded in between it may be a little less or the rest stays in the pool, but the pool's curve is never broken, and `a_failed_buy_cannot_drain_a_pool` tests exactly that.
- **A judge's verdict never comes back.** After about ten minutes anyone can call `clear_awaiting`, and a late verdict is then ignored.
- **A launch is given terms that make the plan meaningless.** The launcher refuses it before the coin exists: at most a tenth of the dev's share per period, a period and a notice of at least a minute, and a floor of at least a twentieth of the cap. The demo's one-minute periods are for watching it work, and the coin's page says how fast the bag could leave at that cap.
- **The price moves while a trade is in flight.** Past the 2% limit, the trade fails and the NEAR or tokens stay with the trader.
- **The playground runs out of demo coins.** It says so. It also refills itself by releasing from idle playground plans, by their own rules.

## What it isn't, yet

- It's on testnet only, and it hasn't been audited.
- **The playground server holds keys** for the demo's dev account, the quick-try agent and the seed its sealed rules come from, all in one process, so visitors can try a plan without a wallet. It also knows every playground plan's sealed rules, which is why revealing is a button.
- **In "Be the dev", your wallet signs your launch and your plan, unless it's short of NEAR and we pay. If you hire an agent, our server makes and keeps its key so it can act for you.** That key can only call `request_release` on the plan contract, and only you get the ticket to give it orders. The server keeps that ticket's hash.
- The judge's code is hosted on our Netlify page. The plan pins its sha256, so a swapped file is refused, but if that page is down, sealed requests fail and nothing moves.
- Our attestation checks don't yet cover Sigstore provenance for the containers or the gateway's TLS binding, which NEAR's own verifier also does.
- The playground's limits (a few plans and coins per visitor an hour, and daily totals) slow down abuse. They're not sybil resistance. A real launch would need that, and this doesn't have it.
- A plan controls only the tokens inside it. A dev can buy the curve from another wallet at launch, and no plan covers that, here or on any launchpad. Anyone can still buy and sell the coin, and nothing here promises a price.
- A cap is a calendar window, so up to twice the cap can leave across a period boundary.

## Where it came from

CHOK started on Solana, where the launchpad, its plans, its sealed schedules (on Arcium) and its live rooms (on MagicBlock) already run on devnet. That code isn't in this repo and isn't part of this entry. Everything here was written for NEAR during the hackathon: the plan, market and token contracts, the judge, the agent, the playground and the page.

## Running it yourself

You need Node 20 and rustup. `rust-toolchain.toml` pins Rust 1.93.0 and both wasm targets, and rustup installs them for you. `npm run build` deletes any old build, builds from clean and remaps paths, so you get the same bytes as the chain whatever your home directory is, and `git status` stays clean. We checked that by building a fresh copy under a different `HOME`. Another compiler would give different bytes, and verify would say so.

```bash
npm install
npm run build                    # the token, then the contracts that embed it, then the judge
cargo test -p plan -p market -p launcher     # the contracts' unit tests
cargo test --manifest-path judge/Cargo.toml
node --test web/src/terminal/data.test.mjs

npm run verify                   # checks the live deployment, read-only, with no keys

# this needs about 1.2 testnet NEAR in an account of your own, in ~/.near-credentials/testnet
# (https://near-faucet.io/ gives you some)
node scripts/attack.mjs --account you.testnet --no-write   # every attack, against a plan of yours
```

`node scripts/market-e2e.mjs` runs a launch and the market end to end, and `node scripts/deploy-all.mjs` makes your own deployment; both use the dev and fan accounts named in `deployment.json`, so they're for your own deployment. Sealed plans also need the OutLayer CLI logged in as the dev, the judge at an https URL, and the rules seed stored as a secret bound to the judge's hash. Keys live in `~/.near-credentials`, outside the repo.

## Built with

- **Contracts:** near-sdk 5.29.1 and near-contract-standards (NEP-141), in Rust.
- **The judge:** a WASI program, run by OutLayer.
- **Scripts and the playground:** near-api-js 5.1.1, FastNEAR's testnet RPC, NEAR AI Cloud, `@phala/dcap-qvl` (Intel quote checks), `ethers` (signature recovery) and NVIDIA's attestation service.
- **The page:** Vite, NEAR Wallet Selector 10 (MyNearWallet, Meteor, HERE, Intear) and [KLineChart](https://github.com/klinecharts/KLineChart) 10 (Apache-2.0) for the candles and axes. The trader bubbles, stamps and panels in `web/src/terminal` are ours.

The code was written with an AI coding assistant, working to our design. Every decision about what the contracts allow, and every claim in this README, was made and checked by us. `npm run verify` is there so you don't have to take our word for any of it.

## License

MIT. See [LICENSE](LICENSE).
