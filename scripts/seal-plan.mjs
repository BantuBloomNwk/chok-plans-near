// A dev's own sealed plan on testnet, end to end, with our server nowhere in it except one faucet call
// for demo tokens. It makes the rules on your machine, makes a plan with their commitment, stores them
// encrypted for OutLayer's enclave, then asks for releases and lets the enclave judge. Finally it
// reveals the rules, and the contract checks them against the commitment.
//
//   node scripts/seal-plan.mjs --account you.testnet
//
// Your account needs about 0.6 testnet NEAR. Your key is read from ~/.near-credentials/testnet. Writes
// the rules to ~/.chok-sealed-<plan>.json. Add --no-reveal to keep them sealed.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { connect, keyStores, utils } from 'near-api-js';
import { makeRules, commitmentOf, storeSecretArgs, newProfile } from '../web/src/seal.js';

const S = JSON.parse(fs.readFileSync(new URL('../deployment.json', import.meta.url)));
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const ME = arg('--account') || process.env.NEAR_ACCOUNT;
if (!ME) { console.error('usage: seal-plan.mjs --account you.testnet [--no-reveal]'); process.exit(1); }
const API = process.env.PLAYGROUND || 'https://near-play.161-97-74-212.sslip.io';
const store = new keyStores.UnencryptedFileSystemKeyStore(process.env.NEAR_CREDENTIALS || path.join(os.homedir(), '.near-credentials'));
const near = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore: store });
const me = await near.account(ME);
const N = (n) => BigInt(utils.format.parseNearAmount(String(n)));
const T = (n) => (BigInt(Math.round(n)) * 1_000_000n).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const view = (contractId, methodName, args) => me.viewFunction({ contractId, methodName, args });
const call = (contractId, methodName, args, deposit = 0n, gas = 300_000_000_000_000n) => me.functionCall({ contractId, methodName, args, attachedDeposit: deposit, gas });
const tx = (h) => `https://testnet.nearblocks.io/txns/${h}`;
let pass = 0, fail = 0;
const ok = (c, m, h) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${h ? `\n      ${tx(h)}` : ''}`); };

// tokens to hold in the plan
if (BigInt(await view(S.coin, 'ft_balance_of', { account_id: ME })) < BigInt(T(5_000_000))) {
  const r = await fetch(`${API}/near/faucet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: ME }) });
  if (!r.ok) throw new Error(`the faucet said ${r.status}: ${await r.text()}`);
  await sleep(3000);
}

// the rules, made here: at most 2M at a time, 30 seconds apart. The public cap is far above that.
const rules = makeRules({ maxPerRelease: T(2_000_000), minGapSecs: 30 });
const commitment = commitmentOf(rules);
const profile = newProfile();
const judgeHash = S.judges[0];
const made = await call(S.plan, 'create_plan', {
  token: S.coin, holder: ME, beneficiary: ME, cap: T(10_000_000), min_cap: T(1_000_000), period_secs: '60', start_in_secs: '0', notice_secs: '120', penalty_bps: 2000,
  sealed: { commitment, judge_url: `https://chok-plans-near.netlify.app/judge/${judgeHash}.wasm`, judge_hash: judgeHash, outlayer: S.outlayer, secrets_owner: ME, secrets_profile: profile },
  loosen_allowed: false,
}, N(0.1), 100_000_000_000_000n);
const id = JSON.parse(Buffer.from(made.status.SuccessValue, 'base64').toString());
ok(typeof id === 'number', `plan #${id} made, with only the commitment ${commitment.slice(0, 16)}… on chain`, made.transaction.hash);
const file = path.join(process.env.HOME || os.homedir(), `.chok-sealed-${id}.json`);
fs.writeFileSync(file, JSON.stringify({ plan: id, contract: S.plan, profile, rules, commitment }, null, 2), { mode: 0o600 });

// the secret: encrypted on this machine, readable only in the enclave, only through the plan contract
const stored = await call(S.outlayer, 'store_secrets', await storeSecretArgs({ rules, planId: id, judgeHash, planContract: S.plan, owner: ME, profile }), N(0.1), 100_000_000_000_000n);
ok(true, `the rules are stored, encrypted on this machine (profile ${profile})`, stored.transaction.hash);
const onChain = JSON.stringify(stored.transaction.actions[0]);
ok(!onChain.includes(rules.salt), 'the salt appears nowhere in the transaction');

await call(S.coin, 'ft_transfer_call', { receiver_id: S.plan, amount: T(5_000_000), msg: String(id) }, 1n, 150_000_000_000_000n);
await sleep(3000);

async function ask(amount) {
  const before = await view(S.plan, 'get_plan', { plan_id: id });
  const out = await call(S.plan, 'request_release', { plan_id: id, amount: T(amount) });
  let p = await view(S.plan, 'get_plan', { plan_id: id });
  for (let i = 0; i < 40 && p.awaiting; i++) { await sleep(1500); p = await view(S.plan, 'get_plan', { plan_id: id }); }
  await sleep(1500);
  p = await view(S.plan, 'get_plan', { plan_id: id });
  const log = await view(S.plan, 'get_log', { plan_id: id, from: Math.max(0, p.log_len - 1), limit: 1 });
  return { hash: out.transaction.hash, released: p.releases > before.releases, busted: p.busted > before.busted, line: log[0] };
}

let r = await ask(1_000_000);
ok(r.released, 'asked for 1M, inside the rules: the enclave cleared it and it was released', r.hash);
r = await ask(1_000_000);
ok(r.busted && /too soon/.test(r.line?.reason), `asked for 1M again at once: Busted (${r.line?.reason})`, r.hash);
await sleep(32_000);
r = await ask(3_000_000);
ok(r.busted && /too large/.test(r.line?.reason), `waited, then asked for 3M, under the public cap and over the sealed one: Busted (${r.line?.reason})`, r.hash);

if (!process.argv.includes('--no-reveal')) {
  const fake = await me.functionCall({ contractId: S.plan, methodName: 'reveal', args: { plan_id: id, max_per_release: T(1_000_000_000), earliest: '0', min_gap_secs: '0', salt: rules.salt }, gas: 100_000_000_000_000n });
  ok(!(await view(S.plan, 'get_plan', { plan_id: id })).revealed, 'revealing false rules with the right salt recorded nothing', fake.transaction.hash);
  const real = await me.functionCall({ contractId: S.plan, methodName: 'reveal', args: { plan_id: id, max_per_release: rules.max_per_release, earliest: String(rules.earliest), min_gap_secs: String(rules.min_gap_secs), salt: rules.salt }, gas: 100_000_000_000_000n });
  ok(!!(await view(S.plan, 'get_plan', { plan_id: id })).revealed, 'the real rules were revealed, and the contract checked them against the commitment', real.transaction.hash);
}
console.log(`\n${pass} passed, ${fail} failed. Plan #${id}, rules in ${file}`);
process.exit(fail ? 1 : 0);
