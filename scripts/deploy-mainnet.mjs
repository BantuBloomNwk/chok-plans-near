// The same plan contract, byte for byte, on NEAR mainnet, with one real plan run against it. Not the
// playground: no market, no launcher, no sealed judge, no sponsored fees. Just proof that the code you
// can rebuild is the code that says Busted on mainnet.
//
//   npm run build
//   MAINNET_ROOT=you.near node scripts/deploy-mainnet.mjs
//
// Needs about 4 NEAR in MAINNET_ROOT, with its key in ~/.near-credentials/mainnet. It makes
// plans.<root> with NO access key, in one transaction, and checks it runs this build. The plan it
// runs holds wNEAR (wrap.near, NEAR's own wrapped token, already on mainnet), so no coin of ours has
// to be deployed: 0.3 wNEAR under a public cap of 0.1 an hour. Then it asks for too much (Busted, the
// cap falls to 0.08) and for 0.05 (released, back to you). Everything lands in mainnet.json.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import bs58 from 'bs58';
import { connect, keyStores, utils, transactions } from 'near-api-js';

const ROOT = process.env.MAINNET_ROOT;
if (!ROOT || !ROOT.endsWith('.near')) { console.error('set MAINNET_ROOT=<your account>.near'); process.exit(1); }
const store = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
const near = await connect({ networkId: 'mainnet', nodeUrl: 'https://free.rpc.fastnear.com', keyStore: store });
const root = await near.account(ROOT);
const N = (n) => BigInt(utils.format.parseNearAmount(String(n)));
const wasm = (n) => fs.readFileSync(new URL(`../target/wasm32-unknown-unknown/release/${n}.wasm`, import.meta.url));
const judge = fs.readFileSync(new URL('../judge/target/wasm32-wasip2/release/judge.wasm', import.meta.url));
const JUDGES = [crypto.createHash('sha256').update(judge).digest('hex')];
const out = { network: 'mainnet', root: ROOT, at: new Date().toISOString(), txs: {} };
const tx = (name, r) => { out.txs[name] = r.transaction.hash; console.log(`${name}: https://nearblocks.io/txns/${r.transaction.hash}`); return r; };

const bal = BigInt((await root.getAccountBalance()).available);
if (bal < N(3.9)) { console.error(`${ROOT} has ${utils.format.formatNearAmount(bal.toString(), 3)} NEAR available; this needs about 4`); process.exit(1); }

async function keyless(id, code, args, funds) {
  tx(`create ${id}`, await root.signAndSendTransaction({ receiverId: id, actions: [
    transactions.createAccount(), transactions.transfer(N(funds)), transactions.deployContract(wasm(code)),
    transactions.functionCall('new', args, 50_000_000_000_000n, 0n),
  ] }));
  const acct = await near.account(id);
  const keys = await acct.getAccessKeys(), state = await acct.state();
  const local = bs58.encode(crypto.createHash('sha256').update(wasm(code)).digest());
  console.log(`${id}: ${keys.length} keys, code ${state.code_hash === local ? 'is this build' : 'DIFFERS'}`);
  if (keys.length || state.code_hash !== local) process.exit(1);
  return state.code_hash;
}

const plan = `plans.${ROOT}`, coin = 'wrap.near';
// the launcher is named but never deployed on mainnet, so no coin can ever arrive "launched" here
out.plan = plan; out.coin = coin; out.launcherNamed = `launch.${ROOT}`;
out.codeHashes = { plan: await keyless(plan, 'plan', { outlayer: 'outlayer.near', launcher: out.launcherNamed, judges: JUDGES }, 3.3) };
const W = (n) => (BigInt(Math.round(n * 1000)) * 10n ** 21n).toString(); // wNEAR has 24 decimals
for (const who of [plan, ROOT]) if (!await root.viewFunction({ contractId: coin, methodName: 'storage_balance_of', args: { account_id: who } })) tx(`register ${who} on wNEAR`, await root.functionCall({ contractId: coin, methodName: 'storage_deposit', args: { account_id: who, registration_only: true }, attachedDeposit: N(0.0125), gas: 30_000_000_000_000n }));
tx('wrap 0.3 NEAR', await root.functionCall({ contractId: coin, methodName: 'near_deposit', args: {}, attachedDeposit: N(0.3), gas: 30_000_000_000_000n }));

const made = tx('create a plan', await root.functionCall({ contractId: plan, methodName: 'create_plan', gas: 50_000_000_000_000n, attachedDeposit: N(0.1), args: {
  token: coin, holder: ROOT, beneficiary: ROOT, cap: W(0.1), min_cap: W(0.01), period_secs: '3600', start_in_secs: '0', notice_secs: '86400', penalty_bps: 2000, sealed: null, loosen_allowed: false,
} }));
const id = JSON.parse(Buffer.from(made.status.SuccessValue, 'base64').toString());
out.planId = id;
tx('put 0.3 wNEAR in the plan', await root.functionCall({ contractId: coin, methodName: 'ft_transfer_call', gas: 100_000_000_000_000n, attachedDeposit: 1n, args: { receiver_id: plan, amount: W(0.3), msg: String(id) } }));

const ask = async (name, amount) => { const r = tx(name, await root.functionCall({ contractId: plan, methodName: 'request_release', gas: 100_000_000_000_000n, args: { plan_id: id, amount: W(amount) } })); return JSON.parse(Buffer.from(r.status.SuccessValue || 'ZmFsc2U=', 'base64').toString()); };
out.busted = (await ask('ask for 0.2 wNEAR (over the cap)', 0.2)) === false;
out.released = (await ask('ask for 0.05 wNEAR (inside the cap)', 0.05)) === true;
const p = await root.viewFunction({ contractId: plan, methodName: 'get_plan', args: { plan_id: id } });
out.capAfter = p.cap; out.balanceAfter = p.balance;
console.log(`plan #${id}: busted ${out.busted}, released ${out.released}, cap now ${Number(p.cap) / 1e24} wNEAR, holds ${Number(p.balance) / 1e24} wNEAR`);
fs.writeFileSync(new URL('../mainnet.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log('wrote mainnet.json');
