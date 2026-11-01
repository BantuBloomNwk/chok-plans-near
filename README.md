# CHOK plans, running on NEAR

On most launchpads the dev can sell their whole bag the minute it suits them. Holders find out when the chart does.

A CHOK plan changes that. The dev's tokens sit in a contract with a public limit on how much can leave in each period. If the dev, or an agent working for them, asks for more than that, the contract says no, writes the attempt down as **Busted**, and tightens the limit as a penalty. Nothing moves. Anyone can see it happen.

This repo is the plan running on NEAR. It started on Solana as part of CHOK, a launchpad where every token launches with a plan like this. Here we're showing that the idea doesn't belong to one chain.

## What a plan does

- **Holds the dev's tokens.** Any NEP-141 token can go in. The plan keeps track of what it holds.
- **Lets them out under a public cap.** For example, at most 10 million tokens a day. The cap and the start date are visible to everyone from the first second.
- **Refuses anything more, on the record.** A request over the cap, or before the start date, is still a successful transaction. It just moves nothing. It records a Busted stamp and cuts the cap by a set percentage. Asking for too much makes the next request smaller, not bigger.
- **Never lets the holder loosen it.** Only the person the tokens go to (the beneficiary) can propose a looser cap. The change then waits out a public notice period, and the beneficiary can cancel it at any point before it takes effect.

## Agents

A plan's holder can be an agent instead of a person. On NEAR, that agent gets a function-call access key that can call exactly one method, `request_release`, on exactly one contract. It can't touch the token, it can't loosen the plan, and it can't send itself anything. The released tokens always go to the beneficiary.

So an agent that goes wrong, or gets talked into something by a bad prompt, can only make requests. Every bad one is refused and stamped, and every one makes its own limit tighter.

## Sealed plans

Some devs don't want their exact selling rules public, because a known schedule is easy to trade ahead of. A sealed plan keeps those rules secret, even from the agent that runs the plan, while every request still gets a public answer.

How it works:

1. When the plan is made, the dev publishes a commitment: a hash of their rules plus a random salt. The rules are the biggest single release allowed, the earliest time anything can leave, and the minimum gap between releases.
2. The rules themselves are stored as an encrypted secret with [OutLayer](https://docs.near.org/primitives/off-chain-compute/outlayer), which only decrypts them inside a hardware-protected enclave (Intel TDX).
3. Each request goes to a small judge program running in that enclave. The plan pins the judge by its exact code hash, so nothing else can stand in for it.
4. The judge answers cleared or refused, says which rule refused it (never the value), and returns the hash of the rules it used.
5. The plan only releases if that hash matches the commitment from day one, the judge cleared the request, and the public cap still allows it. Anything else is Busted.

Who can get a verdict out of those rules is locked down too. The secret only opens for the plan's agent, and only when the request comes through the plan contract. When the dev tried to run the judge directly, OutLayer refused with "Access denied by access condition". The judge is fetched by URL, but the plan pins its sha256, so OutLayer won't run anything else.

The agent never has the rules, so there's nothing for it to leak. If it tries to find the hidden limit by guessing, every wrong guess is refused, stamped, and shrinks its cap. The public cap stays enforced by the contract underneath, so even a broken enclave can't let more out than the public plan allows.

## What's in here

| Folder | What it is |
| --- | --- |
| `contracts/plan` | The plan contract (Rust, near-sdk 5.29). Public plans and sealed plans. |
| `contracts/token` | A plain NEP-141 memecoin for the demo, BUSDOG, built on NEAR's own token standard. |
| `judge` | The sealed judge, a WASI program that OutLayer runs in its enclave. |
| `scripts` | Testnet setup, the end-to-end runs, and a few helpers. |
| `web` | The demo page. It reads the plan live from testnet, replays the recorded sealed run with a link to every transaction, and hashes the judge in your browser to check it's the code the plan pins. |

## On testnet now

- Plan contract: `sealed.chokplans-mvxhykzp.testnet`. It has no access keys at all, so nobody, us included, can redeploy or change it. `npm run verify` checks that, and that its code is this repo's build.
- The agent: `sealagent.chokplans-mvxhykzp.testnet`. Its only key can call `request_release` on the plan contract and nothing else.
- Demo coin: `coin.chokplans-mvxhykzp.testnet`
- `deployment.json` lists every account the scripts use. It holds no keys.

The end-to-end run (`scripts/e2e.mjs`) currently passes 9 of 9 checks on testnet:

- the agent releases under the cap and the dev receives exactly that amount
- asking for 50 million against a 10 million cap is Busted, nothing moves, and the cap drops to 8 million
- the agent's key can't propose a loosening and can't call the token at all
- the dev's looser cap waits in public, can't be applied early, and can be cancelled

The sealed run (`scripts/sealed-e2e.mjs`) passes 6 of 6, with every verdict coming back from OutLayer's enclave in about 10 seconds. The public cap was 10 million a minute. The dev's sealed rules were 3 million per release at most, 30 seconds apart, and the agent was never told either number.

- 2 million: judged in the enclave and released, and the dev received exactly 2 million
- 2 million again straight away: Busted by the sealed pacing rule, and the public cap fell to 8 million
- 5 million, under the public cap but over the sealed one: Busted, and the cap fell to 6.4 million
- 3 million after the gap: cleared and released
- 40 million: refused by the public cap on chain, before any judge was asked

## Running it yourself

You need Rust 1.93 or later with the `wasm32-unknown-unknown` and `wasm32-wasip2` targets, and Node 20.

```bash
# the contracts
# (.cargo/config.toml adds the flags, including the --cfg near that near-sdk needs)
cargo build --target wasm32-unknown-unknown --release

# the judge, and its tests
cargo test --manifest-path judge/Cargo.toml
cargo build --manifest-path judge/Cargo.toml --target wasm32-wasip2 --release

# testnet: makes accounts through NEAR's faucet, deploys, and gives the agent its limited key
npm install
node scripts/setup.mjs
node scripts/e2e.mjs

# sealed plans also need the OutLayer CLI, logged in as the dev, the judge hosted at an https
# URL, and the rules stored as a secret bound to the judge's hash (see scripts/sealed-e2e.mjs)
node scripts/sealed-e2e.mjs
```

Keys are kept in `~/.near-credentials`, outside the repo. The scripts talk to testnet through FastNEAR's RPC.

## What it isn't

- It's on testnet only, and it hasn't been audited.
- It doesn't stop anyone buying or selling the token on the open market. It only controls the tokens inside the plan.
- The penalty and the notice period are set when the plan is made. They're there to make dumping costly and visible, not to promise any price.
