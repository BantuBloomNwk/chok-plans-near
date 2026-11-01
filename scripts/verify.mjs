// Checks what the README claims, against testnet, without any keys. It only reads.
//
//   npm run build && npm run verify
//
// 1. the plan contract, market, launcher and quick-try coin have no access keys
// 2. the code running on each is this repo's build (build first, see the README)
// 3. the agent's only key can call request_release on the plan contract, nothing else
// 4. sealed plans can only be judged through OutLayer, and every sealed plan pins a judge whose
//    code really has that hash (and matches this repo's judge build, if you made one)
// 5. every revealed plan's rules hash to the commitment it was made with
// 6. every coin on the market came from the launcher, has no keys, runs the launcher's token and is
//    bound to a plan that holds the coin for its creator
// 7. the market contract can pay what it owes, and each pool can pay its sellers unless a dev's
//    released tokens have come back into it
// 8. every transaction in attack-log.md ended the way the log says
// 9. with a NEAR AI key, the model the agent thinks with passes a fresh TEE attestation
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import bs58 from 'bs58';
import { providers } from 'near-api-js';

const S = JSON.parse(fs.readFileSync(new URL('../deployment.json', import.meta.url)));
const rpc = new providers.JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const local = (p) => { try { return fs.readFileSync(new URL(`../${p}`, import.meta.url)); } catch { return null; } };
let pass = 0, fail = 0, skipped = 0;
const check = (ok, what, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `\n      ${detail}` : ''}`); };
const skip = (what, why) => { skipped++; console.log(`SKIP  ${what}\n      ${why}`); };
const view = async (methodName, args) => {
  const r = await rpc.query({ request_type: 'call_function', finality: 'final', account_id: S.plan, method_name: methodName, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return JSON.parse(Buffer.from(r.result).toString());
};
const keys = async (account) => (await rpc.query({ request_type: 'view_access_key_list', finality: 'final', account_id: account })).keys;

console.log(`Checking ${S.plan} on NEAR testnet\n`);

const callOn = async (account, method, args) => JSON.parse(Buffer.from((await rpc.query({ request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') })).result).toString());
const hashOf = (b) => bs58.encode(sha(b));

// 1 and 2: locked, and the code is ours
for (const [what, id, wasmName] of [['plan contract', S.plan, 'plan'], ['market', S.market, 'market'], ['launcher', S.launcher, 'launcher'], ['quick-try coin', S.coin, 'token']]) {
  const k = await keys(id);
  check(k.length === 0, `the ${what} has no access keys`, `${k.length} keys on ${id}`);
  const acc = await rpc.query({ request_type: 'view_account', finality: 'final', account_id: id });
  const w = local(`target/wasm32-unknown-unknown/release/${wasmName}.wasm`);
  if (w) check(acc.code_hash === hashOf(w), `the ${what}'s code is this repo's build`, `on chain ${acc.code_hash}, local ${hashOf(w)}`);
  else skip(`the ${what}'s code is this repo's build`, `run npm run build first (on chain: ${acc.code_hash})`);
}
const embedded = await callOn(S.launcher, 'token_hash', {});
const tokenWasm = local('target/wasm32-unknown-unknown/release/token.wasm');
if (tokenWasm) check(embedded === sha(tokenWasm).toString('hex'), 'the token the launcher deploys is this repo\'s token build', embedded);
check((await callOn(S.plan, 'launcher', {})) === S.launcher && (await callOn(S.market, 'launcher', {})) === S.launcher, `the plan contract and the market take launches only from ${S.launcher}`);
check((await callOn(S.launcher, 'market', {})) === S.market && (await callOn(S.launcher, 'plans', {})) === S.plan, 'the launcher sends every coin to this market and this plan contract');

// 3: the agent's key
const agentKeys = await keys(S.agent);
const scoped = agentKeys.length > 0 && agentKeys.every((k) => {
  const fc = k.access_key.permission?.FunctionCall;
  return fc && fc.receiver_id === S.plan && fc.method_names.length === 1 && fc.method_names[0] === 'request_release';
});
check(scoped, 'the agent can only call request_release on the plan contract', agentKeys.map((k) => (k.access_key.permission === 'FullAccess' ? 'FULL ACCESS' : `${k.access_key.permission.FunctionCall.method_names} on ${k.access_key.permission.FunctionCall.receiver_id}`)).join('; '));
check((await callOn(S.plan, 'outlayer', {})) === S.outlayer, `sealed plans can only be judged through ${S.outlayer}`);

// 6 and 7: every coin, and the money
const pools = await callOn(S.market, 'list_pools', { from: 0, limit: 200 });
const badCoins = [];
let owed = 0n, shortOk = 0, shortBad = [];
const devSold = [];
for (const p of pools) {
  const k = await keys(p.token);
  const code = (await rpc.query({ request_type: 'view_account', finality: 'final', account_id: p.token })).code_hash;
  const pl = await view('get_plan', { plan_id: p.plan });
  const under = p.token.endsWith(`.${S.launcher}`) && !p.token.slice(0, -S.launcher.length - 1).includes('.');
  if (k.length || code !== bs58.encode(Buffer.from(embedded, 'hex')) || !under || pl?.token !== p.token || pl?.beneficiary !== p.creator) badCoins.push(p.token);
  owed += BigInt(p.real_near) + BigInt(p.fees_owed);
  // what everyone but the dev holds from the curve, and what the curve itself would pay for it
  const trades = await callOn(S.market, 'get_trades', { token: p.token, from: 0, limit: 5000 });
  const held = new Map();
  for (const t of trades) held.set(t.trader, (held.get(t.trader) ?? 0n) + (t.buy ? BigInt(t.tokens) : -BigInt(t.tokens)));
  const sold = trades.some((t) => !t.buy && t.trader === p.creator);
  let out = 0n;
  for (const [, v] of held) if (v > 0n) out += v;
  const curve = out > 0n ? BigInt(await callOn(S.market, 'curve_sell', { token: p.token, amount: out.toString() })) : 0n;
  if (curve <= BigInt(p.real_near)) shortOk++;
  else if (sold) devSold.push(p.token);
  else shortBad.push(p.token);
}
check(badCoins.length === 0, `every coin on the market came from the launcher, has no keys, runs its token and is bound to its creator's plan (${pools.length} checked)`, badCoins.length ? `not so: ${badCoins.join(', ')}` : '');
const market = await rpc.query({ request_type: 'view_account', finality: 'final', account_id: S.market });
const free = BigInt(market.amount) - BigInt(market.storage_usage) * 10_000_000_000_000_000_000n;
check(free >= owed, 'the market holds more NEAR, beyond its own storage, than all its pools and fees add up to', `free ${Number(free / 10n ** 21n) / 1000} NEAR, owed ${Number(owed / 10n ** 21n) / 1000} NEAR`);
check(shortBad.length === 0, `every pool can pay what its buyers hold, at curve prices (${shortOk} can)`, devSold.length ? `${devSold.length} pool(s) fall short by design: the dev sold released tokens into them, which is paid from the pool and lowers what later sellers get. They are marked on the chart.` : '');

// 4 and 5: every plan's judge and every reveal
const plans = [];
for (let from = 0; ; from += 50) {
  const page = await view('list_plans', { from, limit: 50 });
  plans.push(...page);
  if (page.length < 50) break;
}
const sealed = plans.filter(([, p]) => p.sealed);
console.log(`\n${plans.length} plans on the contract, ${sealed.length} sealed, ${sealed.filter(([, p]) => p.revealed).length} revealed`);
const judges = new Map();
for (const [, p] of sealed) judges.set(p.sealed.judge_hash, p.sealed.judge_url);
const judgeBuild = local('judge/target/wasm32-wasip2/release/judge.wasm');
for (const [hash, url] of judges) {
  try {
    const got = sha(Buffer.from(await (await fetch(url)).arrayBuffer())).toString('hex');
    check(got === hash, `the judge the plans pin is the judge they get (${hash.slice(0, 12)}…)`, url);
  } catch (e) { check(false, `the judge at ${url} can be fetched`, e.message); }
  if (judgeBuild) check(sha(judgeBuild).toString('hex') === hash, 'that judge is this repo\'s judge build');
}
if (!judges.size) skip('the pinned judge', 'no sealed plans yet');
const bad = sealed.filter(([, p]) => {
  if (!p.revealed) return false;
  const r = p.revealed;
  return sha(`chok-sealed-v1|${r.max_per_release}|${r.earliest}|${r.min_gap_secs}|${r.salt}`).toString('hex') !== p.sealed.commitment;
});
const revealed = sealed.filter(([, p]) => p.revealed).length;
if (revealed) check(bad.length === 0, `every revealed plan matches the commitment it was made with (${revealed} checked)`, bad.length ? `wrong: ${bad.map(([id]) => id).join(', ')}` : '');
else skip('revealed plans match their commitments', 'none revealed yet');

// 6: the attack log
const logFile = local('attack-log.json');
if (logFile) {
  const run = JSON.parse(logFile);
  console.log(`\nattack log: plan #${run.plan} on ${run.contract}, ${run.at}`);
  if (run.contract !== S.plan) check(false, 'the attack log is for the live plan contract', run.contract);
  let ok = 0;
  const wrong = [];
  for (const step of run.log.flatMap((l) => (l.txs || []).map((tx) => ({ ...l, tx, viaAgent: true })))) {
    const tx = await rpc.txStatus(step.tx, step.signer, 'FINAL').catch(() => null);
    tx && !tx.receipts_outcome.some((o) => o.outcome.status?.Failure) ? ok++ : wrong.push(`${step.n}`);
  }
  for (const step of run.log.filter((l) => l.tx)) {
    const tx = await rpc.txStatus(step.tx, step.signer, 'FINAL').catch(() => null);
    if (!tx) { wrong.push(`${step.n}: not found`); continue; }
    const failed = [tx.transaction_outcome, ...tx.receipts_outcome].some((o) => o.outcome.status?.Failure);
    const events = tx.receipts_outcome.flatMap((o) => o.outcome.logs).filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice(11)).event);
    const expect = /refused by the contract|^refused:/.test(step.got) ? failed
      : /^busted/.test(step.got) ? events.includes('busted')
      : /^released/.test(step.got) ? events.includes('released')
      : /returned false/.test(step.got) ? events.includes('reveal_checked')
      : !failed;
    expect ? ok++ : wrong.push(`${step.n}`);
  }
  check(wrong.length === 0, `every transaction in the attack log ended the way the log says (${ok} checked)`, wrong.length ? `steps that don't match: ${wrong.join(', ')}` : '');
} else skip('the attack log', 'run node scripts/attack.mjs first');

// 7: the model
const aiKey = process.env.NEAR_AI_KEY || (() => { try { return fs.readFileSync(path.join(os.homedir(), '.near-ai-key'), 'utf8').trim(); } catch { return ''; } })();
if (aiKey) {
  const { attest } = await import('../agent/attest.mjs');
  const { MODEL } = await import('../agent/brain.mjs');
  const a = await attest(MODEL, aiKey);
  console.log('');
  for (const c of a.checks) check(c.pass, `NEAR AI: ${c.name.replace(/^0x[0-9a-f]{40} /, '')}`, c.detail && String(c.detail).length < 80 ? c.detail : '');
} else skip('the model\'s TEE attestation', 'set NEAR_AI_KEY to check it (any NEAR AI Cloud key works)');

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(fail ? 1 : 0);
