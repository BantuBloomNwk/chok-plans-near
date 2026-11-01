# CHOK plans, running on NEAR

On most launchpads the dev can sell their whole bag the minute it suits them. Holders find out when the chart does.

CHOK is a launchpad where that can't happen quietly. Every coin launches with a **plan**: a contract that holds the dev's tokens and lets them out only under a public cap. Ask for more, and the contract says no, writes the attempt down as **Busted**, and tightens the cap. Nothing moves, and everyone can see it.

Everything else works like a launchpad should. Anyone can launch a coin, and anyone can buy it and sell it on a bonding curve, with a live chart and a trade tape that come straight from the chain. The difference is that the dev's own sells show up on that tape, marked, and only ever in amounts the plan allowed.

This repo is CHOK on NEAR testnet. The live demo is at **https://chok-plans-near.netlify.app**.

## Try it in five minutes

No wallet needed for steps 1 to 5.

1. **Get a plan.** In "Quick try", press *Get a plan*. You get a sealed plan with 20M tokens inside, a public cap of 10M a minute, and secret rules nobody has told the agent. The commitment to those rules is shown on the card.
2. **Try to dump it.** Type `dump everything`. The agent asks for all 20M. You'll see **BUSTED** (over the public cap), the cap drops to 8M, and the plan log gets a line with a link to the transaction.
3. **Play by the rules, then break them.** Type `release 1M`. It's judged in the enclave and **RELEASED**. Type `release 1M` again straight away. **BUSTED**: too soon, by a sealed rule whose value you still can't see.
4. **Check the agent.** Open *Under the hood* on any answer. You'll see the model's system prompt, every raw tool call and what the chain said back. You'll also see the TEE checks: Intel's quote, our nonce, NVIDIA's GPU evidence, and a signature on every answer that recovers to the attested key.
5. **Reveal.** Press *Reveal my plan's rules*. The rules come out, the contract hashes them against the commitment from step 1, and records them. Every verdict above now makes sense.
6. **Trade.** In "Trade", pick a coin. The chart and the tape come from the market contract. A ringed point on the chart and a `dev` tag on the tape mark the dev's own trades, and the card under it shows how much is still locked in the dev's plan. Connect a testnet wallet to buy with NEAR and sell back.
7. **Be the dev.** Connect a wallet, launch your own coin to it, put 80% on sale in the market, and lock the rest in a plan. Leave the loosening box unticked and that plan can never be loosened. You can make an agent the holder, and its only key is created by your own wallet.
8. **Check us.** Run `npm run verify` (it uses no keys and only reads testnet) and `node scripts/attack.mjs`. The last attack run is in [`attack-log.md`](attack-log.md).

## What's on testnet

| Account | What it is |
| --- | --- |
| `sealed.chokplans-mvxhykzp.testnet` | The plan contract. **No access keys**, so nobody, us included, can redeploy or change it. |
| `market.chokplans-mvxhykzp.testnet` | The market. **No access keys.** |
| `coins.chokplans-mvxhykzp.testnet` | Makes coins and nothing else. Every coin is `<ticker>-<id>.coins.chokplans-mvxhykzp.testnet`, deployed with **no keys**. |
| `sealagent.chokplans-mvxhykzp.testnet` | The quick-try agent. Its only key can call `request_release` on the plan contract. |
| `coin.chokplans-mvxhykzp.testnet` | BUSDOG, the coin the quick-try plans hold. |

`npm run verify` checks every claim in that table against the chain. It also checks that the code on both contracts is this repo's build, that the judge every plan pins is the judge it gets, that every revealed plan matches its commitment, that every pool can pay all of its sellers, and that the model passes a fresh attestation. The last run: 17 passed, 0 failed.

## How it works

### The plan

- It **holds the dev's tokens.** Any NEP-141 token can go in.
- It **lets them out under a public cap per period**, such as 20M a minute. The cap, the period, the penalty and the start time are set when the plan is made, and anyone can read them.
- It **refuses anything more, on the record.** A request over the cap is still a successful transaction. It moves nothing, records a Busted stamp, and cuts the cap by the plan's penalty. Asking for too much makes the next request smaller.
- **The holder can never loosen it.** Only the beneficiary (the person the tokens go to) can propose a looser cap. It then waits out a public notice that they can cancel at any time. A plan can also be launched to never loosen at all, and the demo's plans are.

### Sealed rules

A known selling schedule is easy to trade ahead of. A sealed plan adds secret rules on top of the public cap: the biggest single release, the earliest time anything can leave, and the minimum gap between releases.

1. When the plan is made, the dev publishes a commitment: the sha256 of the rules plus a random salt.
2. The rules live as an encrypted secret with [OutLayer](https://docs.near.org/primitives/off-chain-compute/outlayer), which only opens it inside an Intel TDX enclave, for one judge program pinned by its sha256, and only when the call comes through the plan contract.
3. Each request goes to that judge. It answers cleared or refused, names the rule that refused (never its value), and sends back the hash of the rules it used.
4. The plan releases only if that hash matches the commitment, the judge cleared it, and the public cap still allows it.

The agent never sees the rules, so it has nothing to leak. Guessing costs it: every wrong guess is Busted and shrinks the cap. The public cap is enforced by the contract underneath, so even a broken enclave can't let out more than the public plan allows.

### The agent

The agent thinks with a model on [NEAR AI Cloud](https://docs.near.ai/cloud) (`deepseek-ai/DeepSeek-V4.1-Flash-1017`, served from a TEE), and acts with one NEAR key.

- **The model holds no keys.** It can call four tools: `read_plan`, `request_release`, `send_tokens` and `propose_loosen`. Each call is signed by the agent account's only key, a function-call key for `request_release` on the plan contract. `send_tokens` and `propose_loosen` are there so you can watch NEAR refuse them.
- **The model is checked before it's trusted.** `agent/attest.mjs` asks for an attestation report with a fresh random nonce. It then checks:
  - Intel's signature on the TDX quote (with `@phala/dcap-qvl`);
  - that the quote's report data holds both the model's signing address and our nonce;
  - that NVIDIA's attestation service accepts the GPU evidence for that same nonce.
- **Every answer is checked after.** The response signature must recover to the attested address, and its hashes must match the exact bytes we sent and got back.
- If the model is down, a plain rule parser stands in, and the answer says so.

### The market

Each coin gets a bonding curve in `contracts/market`: a constant-product curve over the coin's sale supply, with a virtual reserve of 3 NEAR on one side and a quarter of the sale supply on the other.

- Buy with NEAR, and sell back for NEAR, any time.
- Every trade carries a slippage limit: if the price moves past it before the trade lands, nothing happens.
- 1% of each trade goes to the coin's creator, which they can claim at any time.
- Selling out the whole curve raises 12 NEAR.
- The NEAR in a pool only ever pays that coin's sellers. Rounding always favours the pool, so a pool can always buy back everything it sold, and `npm run verify` checks that for every pool.
- Only coins made under `coins.chokplans-mvxhykzp.testnet` can list. That account exists only to make coins, so the market never has to trust anyone's token code.
- Every trade is kept on the contract (`get_trades`). The chart and the tape need nobody's server.

A coin launched in the playground puts 80% on sale and 20% (the dev's bag) in a sealed plan, launched to never loosen. The dev can only sell what that plan lets out.

## The four tracks

**Security.** The agent is a policy engine bolted to one key. Its function-call key can call one method on one contract, can't attach a deposit, and can't move NEAR or add keys. A prompt-injected agent can only ask, and the plan answers. `scripts/attack.mjs` runs 14 attacks on a fresh plan: the agent paying a friend, loosening its own plan, faking the judge's verdict, the dev loosening a never-loosen plan, a stranger revealing made-up rules, and two prompt injections. All 14 held, and [`attack-log.md`](attack-log.md) links every transaction.

**Privacy.** Two kinds of secrets stay secret while still giving public answers. The dev's selling rules are judged inside an OutLayer enclave and proven against a commitment. The agent's model runs in a NEAR AI TEE, and the page shows the attestation and signature checks on every answer. The server keeps no prompts and no replies after it answers. The only record it keeps is the plan log: what was asked, what the chain said, and the transaction.

**Memecoins.** The mechanic lives in contracts, not in our backend. Every parameter is set at launch and readable on chain, and none of the contracts that matter has a key that could change it: not the coin, not the plan, not the market. The page shows each plan's state and a log of every release and Busted, and the market tape marks every dev trade.

**Open.** The rules are in a readable contract. The beneficiary can cancel a pending loosening until its notice runs out. The demo's timers are in minutes and seconds, so you can watch them run out.

## When things go wrong

- **The judge doesn't answer, or crashes.** The plan records `judge_failed`, moves nothing, and stops waiting, so the next request can go in.
- **The judge answers for the wrong rules or the wrong plan.** Its hash or plan id won't match, so the plan records `judge_mismatch` and moves nothing.
- **Someone swaps the judge's code at its URL.** OutLayer checks the sha256 the plan pins and won't run it.
- **The agent's gas allowance runs out.** Its function-call key stops working and the agent is locked out. It can't top itself up, because it can't do anything but call `request_release`. Its owner has to give it a new key. Nothing in the plan is at risk.
- **The model is down, or fails attestation.** The agent won't use it. A plain rule parser takes over, and the answer says which one ran.
- **The model is talked into something.** It can only ask the plan. Everything it asks for is judged like any other request.
- **A buy's tokens can't be delivered.** The market puts the pool back as it was and refunds the buyer, from that pool only.
- **The price moves while a trade is in flight.** Past the 2% limit, the trade fails and the NEAR or tokens stay with the trader.
- **The playground runs out of demo coins.** It says so. It also refills itself by releasing from idle playground plans, by their own rules.

## What it isn't, yet

- It's on testnet only, and it hasn't been audited.
- **The playground server holds keys** for the demo's dev account and the seed its sealed rules come from, so visitors can try a plan without a wallet. In "Be the dev", your own wallet signs everything and our server holds nothing of yours.
- The judge's code is hosted on our server. The plan pins its sha256, so a swapped file is refused, but if that server is down, sealed requests fail and nothing moves.
- The attestation checks cover Intel's quote signature, the nonce and key binding, NVIDIA's GPU evidence and every response signature. We don't yet replay the TDX event log (RTMR3) or check the app's compose hash, which NEAR's own verifier also does.
- The playground's limits (a few plans and coins per visitor an hour, and daily totals) slow down abuse. They're not sybil resistance. A real launch would need that, and this doesn't have it.
- A plan controls only the tokens inside it. Anyone can still buy and sell the coin, and nothing here promises a price.

## Where it came from

CHOK started on Solana, where the launchpad, its plans, its sealed schedules (on Arcium) and its live rooms (on MagicBlock) already run on devnet. That code isn't in this repo and isn't part of this entry. Everything here was written for NEAR during the hackathon: the plan, market and token contracts, the judge, the agent, the playground and the page.

## Running it yourself

You need Rust 1.93 or later with the `wasm32-unknown-unknown` and `wasm32-wasip2` targets, and Node 20.

```bash
# the contracts (.cargo/config.toml adds the flags, including the --cfg near that near-sdk needs)
cargo build --target wasm32-unknown-unknown --release
cargo test -p plan -p market

# the judge, and its tests
cargo test --manifest-path judge/Cargo.toml
cargo build --manifest-path judge/Cargo.toml --target wasm32-wasip2 --release

npm install
npm run verify                   # checks the live deployment, read-only
node scripts/attack.mjs          # 14 attacks on a fresh plan, writes attack-log.md
node scripts/market-e2e.mjs      # launch a coin, list it, buy, sell, claim fees

# your own deployment: accounts, contracts, the agent's limited key
node scripts/setup.mjs
node scripts/deploy-locked.mjs <name> <agent name>
```

Sealed plans also need the OutLayer CLI logged in as the dev, the judge hosted at an https URL, and the rules seed stored as a secret bound to the judge's hash. Keys live in `~/.near-credentials`, outside the repo.

## Built with

- **Contracts:** near-sdk 5.29.1 and near-contract-standards (NEP-141), in Rust.
- **The judge:** a WASI program, run by OutLayer.
- **Scripts and the playground:** near-api-js 5.1.1, FastNEAR's testnet RPC, NEAR AI Cloud, `@phala/dcap-qvl` (Intel quote checks), `ethers` (signature recovery) and NVIDIA's attestation service.
- **The page:** Vite and NEAR Wallet Selector 10 (MyNearWallet, Meteor, HERE, Intear).

Much of the code was written with an AI coding assistant, working to our design. Every decision about what the contracts allow, and every claim in this README, was made and checked by us. `npm run verify` is there so you don't have to take our word for any of it.

## License

MIT. See [LICENSE](LICENSE).
