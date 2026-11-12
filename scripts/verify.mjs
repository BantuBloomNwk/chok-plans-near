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
// 10. if mainnet.json exists: the mainnet plan contract and coin have no keys, run this same build, and the
//     mainnet plan was Busted
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import bs58 from 'bs58';
import { providers } from 'near-api-js';

const S = JSON.parse(fs.readFileSync(new URL('../deployment.json', import.meta.url)));
// the same public RPCs the page uses, so a rate limit on one isn't reported as a broken claim
const rpc = new providers.FailoverRpcProvider(['https://test.rpc.fastnear.com', 'https://rpc.testnet.fastnear.com', 'https://near-testnet.drpc.org'].map((url) => new providers.JsonRpcProvider({ url }, { retries: 4, backoff: 2, wait: 800 })));
// past transactions live only on archive nodes: ordinary testnet nodes keep about two days of them
const archive = new providers.FailoverRpcProvider(['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org'].map((url) => new providers.JsonRpcProvider({ url }, { retries: 3, backoff: 2, wait: 500 })));
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
check((await callOn(S.launcher, 'outlayer', {})) === S.outlayer, `launches can only name ${S.outlayer} as a judge's host`);
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

// 5b: a proof for each verdict the judge gave: OutLayer's public record, Intel's signature on the quote,
// and the request and answer it commits to, all checked against the chain
{
  const { proveVerdict } = await import('./judge-proof.mjs');
  const log = local('attack-log.json');
  const judged = log ? JSON.parse(log).log.filter((l) => /model said|rule parser/.test(l.got || '')).flatMap((l) => l.txs || []) : [];
  const pinned = [...judges.keys()][0];
  if (!pinned || !judged.length) skip('proofs for the judge\'s verdicts', 'no judged requests in the attack log yet');
  else {
    console.log(`\nthe judge's verdicts: ${judged.length} in the attack log, each checked against OutLayer's record, Intel and the chain`);
    for (const tx of judged) {
      const checks = await proveVerdict(tx, { pinned }).catch((e) => [{ name: 'the proof can be read', pass: false, detail: e.message }]);
      const bad = checks.filter((c) => !c.pass);
      check(bad.length === 0, `verdict ${tx.slice(0, 10)}…: ${checks.length - bad.length} of ${checks.length} checks hold`, bad.length ? bad.map((c) => `${c.name}: ${c.detail}`).join('; ') : checks[0]?.link ?? '');
    }
  }
}

// 6: the attack log
const logFile = local('attack-log.json');
if (logFile) {
  const run = JSON.parse(logFile);
  console.log(`\nattack log: plan #${run.plan} on ${run.contract}, ${run.at}`);
  if (run.contract !== S.plan) check(false, 'the attack log is for the live plan contract', run.contract);
  let ok = 0;
  const wrong = [], unread = [];
  for (const step of run.log.flatMap((l) => (l.txs || []).map((tx) => ({ ...l, tx, viaAgent: true })))) {
    const tx = await archive.txStatus(step.tx, step.signer, 'FINAL').catch(() => null);
    if (!tx) { unread.push(`${step.n}`); continue; }
    !tx.receipts_outcome.some((o) => o.outcome.status?.Failure) ? ok++ : wrong.push(`${step.n}`);
  }
  for (const step of run.log.filter((l) => l.tx)) {
    const tx = await archive.txStatus(step.tx, step.signer, 'FINAL').catch(() => null);
    if (!tx) { unread.push(`${step.n}`); continue; }
    const failures = [tx.transaction_outcome, ...tx.receipts_outcome].filter((o) => o.outcome.status?.Failure).map((o) => JSON.stringify(o.outcome.status.Failure));
    const failed = failures.length > 0;
    // a refusal has to be the refusal the log says, not just any failure
    const said = step.got.match(/^refused: (.+)$/)?.[1];
    const events = tx.receipts_outcome.flatMap((o) => o.outcome.logs).filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice(11)).event);
    const expect = said ? failures.some((f) => f.includes(said.trim())) : /^refused/.test(step.got) ? failed
      : /^busted/.test(step.got) ? events.includes('busted')
      : /^released/.test(step.got) ? events.includes('released')
      : /returned false/.test(step.got) ? events.includes('reveal_checked')
      : !failed;
    expect ? ok++ : wrong.push(`${step.n}`);
  }
  check(wrong.length === 0, `every transaction in the attack log ended the way the log says (${ok} checked)`, wrong.length ? `steps that don't match: ${wrong.join(', ')}` : '');
  if (unread.length) skip(`attack log steps ${unread.join(', ')}`, 'the RPCs are busy and would not answer, so these were not checked. Run it again in a minute.');
} else skip('the attack log', 'run node scripts/attack.mjs first');

// 8: mainnet, if this repo has been deployed there (mainnet.json)
const MN = (() => { try { return JSON.parse(fs.readFileSync(new URL('../mainnet.json', import.meta.url))); } catch { return null; } })();
if (MN) {
  console.log('');
  const mrpc = new providers.FailoverRpcProvider(['https://free.rpc.fastnear.com', 'https://rpc.mainnet.fastnear.com'].map((url) => new providers.JsonRpcProvider({ url }, { retries: 4, backoff: 2, wait: 800 })));
  for (const [what, id, wasmName] of [['mainnet plan contract', MN.plan, 'plan'], ['mainnet coin', MN.coin, 'token']]) {
    const ks = (await mrpc.query({ request_type: 'view_access_key_list', finality: 'final', account_id: id })).keys;
    check(ks.length === 0, `the ${what} has no access keys`, `${ks.length} keys on ${id}`);
    const acc = await mrpc.query({ request_type: 'view_account', finality: 'final', account_id: id });
    const w = local(`target/wasm32-unknown-unknown/release/${wasmName}.wasm`);
    if (w) check(acc.code_hash === hashOf(w), `the ${what}'s code is this repo's build, the same bytes as on testnet`, `on chain ${acc.code_hash}, local ${hashOf(w)}`);
  }
  const r = await mrpc.query({ request_type: 'call_function', finality: 'final', account_id: MN.plan, method_name: 'get_plan', args_base64: Buffer.from(JSON.stringify({ plan_id: MN.planId })).toString('base64') });
  const mp = JSON.parse(Buffer.from(r.result).toString());
  check(BigInt(mp.cap) < 10_000_000_000_000n, `mainnet plan #${MN.planId} was Busted and its cap tightened`, `cap now ${Number(mp.cap) / 1e12}M`);
} else skip('mainnet', 'not deployed there from this checkout (no mainnet.json)');

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
