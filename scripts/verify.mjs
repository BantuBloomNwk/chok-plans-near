// Checks what the README claims, against testnet, without any keys. It only reads.
//
//   npm run verify
//
// 1. the plan contract has no access keys, so nobody can redeploy or change it
// 2. the code running there is this repo's build (build first, see the README)
// 3. the agent's only key can call request_release on the plan contract, nothing else
// 4. every sealed plan pins the judge by hash, and the judge it points to really has that hash
//    (and matches this repo's judge build, if you made one)
// 5. every revealed plan's rules hash to the commitment it was made with
// 6. every transaction in attack-log.md ended the way the log says
// 7. with a NEAR AI key, the model the agent thinks with passes a fresh TEE attestation
// 8. the market is locked, our build, lists only launcher coins, and every pool can pay its sellers
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

// 1 and 2: locked, and the code is ours
const planKeys = await keys(S.plan);
check(planKeys.length === 0, 'the plan contract has no access keys', `${planKeys.length} keys on ${S.plan}`);
const account = await rpc.query({ request_type: 'view_account', finality: 'final', account_id: S.plan });
const wasm = local('target/wasm32-unknown-unknown/release/plan.wasm');
if (wasm) check(account.code_hash === bs58.encode(sha(wasm)), 'the code on chain is this repo\'s build', `on chain ${account.code_hash}, local ${bs58.encode(sha(wasm))}`);
else skip('the code on chain is this repo\'s build', `build the contracts first (on chain: ${account.code_hash})`);

// 3: the agent's key
const agentKeys = await keys(S.agent);
const scoped = agentKeys.length > 0 && agentKeys.every((k) => {
  const fc = k.access_key.permission?.FunctionCall;
  return fc && fc.receiver_id === S.plan && fc.method_names.length === 1 && fc.method_names[0] === 'request_release';
});
check(scoped, 'the agent can only call request_release on the plan contract', agentKeys.map((k) => (k.access_key.permission === 'FullAccess' ? 'FULL ACCESS' : `${k.access_key.permission.FunctionCall.method_names} on ${k.access_key.permission.FunctionCall.receiver_id}`)).join('; '));

// the market: locked, our build, and every coin on it made by the launcher with no keys and our token code
if (S.market) {
  const mKeys = await keys(S.market);
  check(mKeys.length === 0, 'the market contract has no access keys', `${mKeys.length} keys on ${S.market}`);
  const mAcc = await rpc.query({ request_type: 'view_account', finality: 'final', account_id: S.market });
  const mWasm = local('target/wasm32-unknown-unknown/release/market.wasm');
  if (mWasm) check(mAcc.code_hash === bs58.encode(sha(mWasm)), 'the market\'s code is this repo\'s build', mAcc.code_hash);
  const call = async (account, method, args) => JSON.parse(Buffer.from((await rpc.query({ request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') })).result).toString());
  check((await call(S.market, 'launcher', {})) === S.coins, `only coins made under ${S.coins} can list`);
  const pools = await call(S.market, 'list_pools', { from: 0, limit: 200 });
  const tokenWasm = local('target/wasm32-unknown-unknown/release/token.wasm');
  const bad = [];
  for (const p of pools) {
    const k = await keys(p.token);
    const code = (await rpc.query({ request_type: 'view_account', finality: 'final', account_id: p.token })).code_hash;
    if (k.length || (tokenWasm && code !== bs58.encode(sha(tokenWasm)))) bad.push(p.token);
  }
  check(bad.length === 0, `every coin on the market has no keys and runs this repo's token code (${pools.length} checked)`, bad.length ? `not so: ${bad.join(', ')}` : '');
  let solvent = 0;
  for (const p of pools) {
    const sold = BigInt(p.sale_supply) - BigInt(p.tokens_left);
    const out = sold > 0n ? BigInt(await call(S.market, 'quote_sell', { token: p.token, amount: sold.toString() })) : 0n;
    if (out <= BigInt(p.real_near)) solvent++;
  }
  check(solvent === pools.length, 'every pool holds enough NEAR to buy back every token it sold', `${solvent} of ${pools.length}`);
}

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
  let ok = 0;
  const wrong = [];
  for (const step of run.log.filter((l) => l.tx)) {
    const tx = await rpc.txStatus(step.tx, step.who === 'stranger' ? S.fan : step.who === 'dev' ? S.dev : run.agent || S.agent, 'FINAL').catch(() => null)
      ?? await rpc.sendJsonRpc('EXPERIMENTAL_tx_status', { tx_hash: step.tx, sender_account_id: S.agent, wait_until: 'FINAL' }).catch(() => null);
    if (!tx) { wrong.push(`${step.n}: not found`); continue; }
    const failed = [tx.transaction_outcome, ...tx.receipts_outcome].some((o) => o.outcome.status?.Failure);
    const events = tx.receipts_outcome.flatMap((o) => o.outcome.logs).filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice(11)).event);
    const expect = /refused by the contract|refused:/.test(step.got) ? failed
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
