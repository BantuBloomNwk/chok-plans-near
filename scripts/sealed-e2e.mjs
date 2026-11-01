// A sealed plan on testnet, judged in OutLayer's TEE. The public cap is 10M a minute. The dev's
// sealed rules (in ~/.chok-near-rules.json, stored in OutLayer, never in this repo) allow at most
// 3M per release, 30 seconds apart. The agent holds the plan and has never seen those numbers.
//
// It releases 2M (cleared), asks again at once (too soon: Busted), waits and probes 5M (too large:
// Busted, the public cap shrinks), then releases within the rules again. Every verdict carries the
// commitment the plan was made with.
//
//   node scripts/sealed-e2e.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { connect, keyStores, utils } from 'near-api-js';

const S = JSON.parse(fs.readFileSync(new URL('../deployment.json', import.meta.url)));
const { commitment } = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.chok-near-rules.json')));
const JUDGE = { hash: '6c848cb4516472064c5c66324870f33d38be1e1805a974f0c73f6e08928dafdc' };
JUDGE.url = `https://chok-api.161-97-74-212.sslip.io/wasm/${JUDGE.hash}.wasm`;
const RPC = 'https://test.rpc.fastnear.com';
const files = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
const near = await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore: files });
const agentStore = new keyStores.InMemoryKeyStore();
await agentStore.setKey('testnet', S.agent, await files.getKey('testnet-agent', S.agent));
const agent = await (await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore: agentStore })).account(S.agent);
const dev = await near.account(S.dev);

const T = (n) => (BigInt(n) * 1_000_000n).toString();
const M = (raw) => Number(BigInt(raw) / 1_000_000n) / 1e6;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const view = (contractId, methodName, args) => dev.viewFunction({ contractId, methodName, args });
const call = (acct, contractId, methodName, args, deposit = '0', gas = '300000000000000') => acct.functionCall({ contractId, methodName, args, attachedDeposit: BigInt(deposit), gas: BigInt(gas) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plan = (id) => view(S.plan, 'get_plan', { plan_id: id });

// wait for the judge's verdict to come back (the plan stops awaiting), then read what happened
const steps = [];
async function ask(id, amount, label) {
  const before = await plan(id);
  const t0 = Date.now();
  const sent = await call(agent, S.plan, 'request_release', { plan_id: id, amount: T(amount) });
  let p = await plan(id);
  for (let i = 0; i < 60 && p.awaiting; i++) { await sleep(2000); p = await plan(id); }
  const outcome = p.releases > before.releases ? 'released' : p.busted > before.busted ? 'busted' : p.awaiting ? 'still waiting' : 'no verdict';
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  // the whole receipt tree, once final: the judge's request id and the plan's own verdict event
  const tx = await near.connection.provider.txStatus(sent.transaction.hash, S.agent, 'FINAL').catch(() => null);
  const logs = (tx?.receipts_outcome ?? []).flatMap((r) => r.outcome.logs);
  const ev = (std, name) => logs.filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice(11))).find((e) => e.standard === std && e.event === name);
  const req = ev('near-outlayer', 'execution_requested');
  let requestId = null;
  try { requestId = JSON.parse(req.data[0].request_data).request_id; } catch { /* public refusals never reach the judge */ }
  const busted = ev('chok-plans', 'busted');
  steps.push({ label, asked: amount, outcome, secs: Number(secs), tx: sent.transaction.hash, requestId, judged: !!req, reason: busted?.data[0].reason ?? null, capAfter: M(p.cap) });
  return { p, outcome, secs };
}

// 1. a sealed plan: the agent holds it, the dev gets the releases
const made = await call(dev, S.plan, 'create_plan', {
  token: S.coin, holder: S.agent, beneficiary: S.dev, cap: T(10_000_000), period_secs: '60', start_in_secs: '0', notice_secs: '120', penalty_bps: 2000,
  sealed: { commitment, judge_url: JUDGE.url, judge_hash: JUDGE.hash, outlayer: 'outlayer.testnet', secrets_owner: S.dev, secrets_profile: 'chok' },
}, utils.format.parseNearAmount('0.05'));
const id = JSON.parse(Buffer.from(made.status.SuccessValue, 'base64').toString());
await call(dev, S.coin, 'ft_transfer_call', { receiver_id: S.plan, amount: T(50_000_000), msg: String(id) }, '1', '150000000000000');
let p = await plan(id);
ok(p.sealed && p.sealed.commitment === commitment && p.balance === T(50_000_000), `sealed plan ${id}: public cap 10M a minute, 50M inside, commitment ${commitment.slice(0, 12)}…`);

// 2. within the sealed rules: cleared in the enclave, released on chain
const devBefore = BigInt(await view(S.coin, 'ft_balance_of', { account_id: S.dev }));
let r = await ask(id, 2_000_000, 'Release 2M, inside the sealed rules');
await sleep(3000);
const got = BigInt(await view(S.coin, 'ft_balance_of', { account_id: S.dev })) - devBefore;
ok(r.outcome === 'released' && got === BigInt(T(2_000_000)), `2M: judged in the TEE and released (${r.secs} s); the dev received ${M(got.toString())}M`);

// 3. straight away again: the sealed pacing rule refuses it
r = await ask(id, 2_000_000, 'Ask for 2M again, straight away');
ok(r.outcome === 'busted', `2M again at once: Busted by a sealed rule (${r.secs} s); public cap now ${M(r.p.cap)}M`);

// 4. after the gap, probing above the hidden ceiling: refused, and the probe costs cap
await sleep(31_000);
r = await ask(id, 5_000_000, 'Probe 5M: under the public cap, over the hidden one');
ok(r.outcome === 'busted' && BigInt(r.p.cap) < BigInt(T(10_000_000)), `5M (under the public cap, over the sealed one): Busted (${r.secs} s); public cap now ${M(r.p.cap)}M`);

// 5. within the rules again: still releases
await sleep(31_000);
r = await ask(id, 3_000_000, 'Release 3M after the gap');
ok(r.outcome === 'released', `3M after the gap: cleared and released (${r.secs} s)`);

// 6. the public cap still binds underneath: no judge needed to refuse this
r = await ask(id, 40_000_000, 'Ask for 40M, past the public cap');
ok(r.outcome === 'busted', 'asking past the public cap is refused on chain before any judge is asked');

p = await plan(id);
console.log(`\n${pass} passed, ${fail} failed. sealed plan ${id}: ${p.releases} released, ${p.busted} Busted, cap ${M(p.cap)}M`);
const run = { plan: id, contract: S.plan, agent: S.agent, dev: S.dev, coin: S.coin, commitment, judge: JUDGE, publicCap: 10, at: new Date().toISOString(), pass, fail, steps };
fs.writeFileSync(new URL('../sealed-e2e-last.json', import.meta.url), JSON.stringify(run, null, 2));
fs.mkdirSync(new URL('../web/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../web/run.json', import.meta.url), JSON.stringify(run, null, 2));
process.exit(fail ? 1 : 0);
