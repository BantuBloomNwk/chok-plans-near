// Puts the whole thing on testnet: plan contract, market, launcher and the quick-try coin, each made
// in one transaction with NO access key at all, so nobody, us included, has ever been able to change
// them. Also makes the quick-try agent with its one function-call key, and points deployment.json at
// all of it. Build first with npm run build. Needs a funded account in ~/.near-credentials/testnet
// named by "root" in deployment.json, and dev and fan accounts under it.
//
//   node scripts/deploy-all.mjs <plan> <market> <launcher> <coin> <agent>
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import bs58 from 'bs58';
import { connect, keyStores, KeyPair, utils, transactions } from 'near-api-js';

const [plan, market, launcher, coin, agent] = process.argv.slice(2);
if (!agent) { console.error('usage: deploy-all.mjs <plan> <market> <launcher> <coin> <agent>'); process.exit(1); }
const STATE = new URL('../deployment.json', import.meta.url);
const S = JSON.parse(fs.readFileSync(STATE));
const JUDGES = ['7e694289acabfdada2048a79d98ddf0d844d853d3a3752a33ca84bcc14c95535'];
const OUTLAYER = 'outlayer.testnet';
const store = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
const near = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore: store });
const root = await near.account(S.root), dev = await near.account(S.dev);
const N = (n) => BigInt(utils.format.parseNearAmount(String(n)));
const wasm = (n) => fs.readFileSync(new URL(`../target/wasm32-unknown-unknown/release/${n}.wasm`, import.meta.url));
const at = (n) => `${n}.${S.root}`;
const ids = { plan: at(plan), market: at(market), launcher: at(launcher), coin: at(coin), agent: at(agent) };

async function keyless(id, code, init, args, funds) {
  await root.signAndSendTransaction({ receiverId: id, actions: [
    transactions.createAccount(), transactions.transfer(N(funds)), transactions.deployContract(wasm(code)),
    transactions.functionCall(init, args, 50_000_000_000_000n, 0n),
  ] });
  const acct = await near.account(id);
  const keys = await acct.getAccessKeys(), state = await acct.state();
  const local = bs58.encode(crypto.createHash('sha256').update(wasm(code)).digest());
  console.log(`${id}: ${keys.length} keys, code ${state.code_hash === local ? 'is this build' : 'DIFFERS'}`);
  if (keys.length || state.code_hash !== local) process.exit(1);
  return state.code_hash;
}

const hashes = {
  plan: await keyless(ids.plan, 'plan', 'new', { outlayer: OUTLAYER, launcher: ids.launcher, judges: JUDGES }, 6.5),
  market: await keyless(ids.market, 'market', 'new', { launcher: ids.launcher }, 4.5),
  launcher: await keyless(ids.launcher, 'launcher', 'new', { market: ids.market, plans: ids.plan }, 5),
  coin: await keyless(ids.coin, 'token', 'new', { owner: S.dev, total_supply: (1_000_000_000n * 1_000_000n).toString(), name: 'Bus Dog', symbol: 'BUSDOG' }, 2.4),
};

// the plan contract has to be on the coin's register to hold plans of it
await dev.functionCall({ contractId: ids.coin, methodName: 'storage_deposit', args: { account_id: ids.plan }, attachedDeposit: N(0.0125), gas: 30_000_000_000_000n });

const ak = KeyPair.fromRandom('ed25519');
await store.setKey('testnet-agent', ids.agent, ak);
await root.signAndSendTransaction({ receiverId: ids.agent, actions: [
  transactions.createAccount(), transactions.transfer(N(2.5)),
  transactions.addKey(ak.getPublicKey(), transactions.functionCallAccessKey(ids.plan, ['request_release'], N(2))),
] });
console.log(`${ids.agent}: one key, request_release on the plan contract`);

const retired = [...new Set([...(S.retired || []), S.plan, S.market, S.agent, S.coin, S.coins, S.legacyPlan, S.legacyAgent].filter(Boolean))].filter((x) => !Object.values(ids).includes(x));
const next = { root: S.root, dev: S.dev, fan: S.fan, ...ids, outlayer: OUTLAYER, judges: JUDGES, codeHashes: hashes, retired };
fs.writeFileSync(STATE, JSON.stringify(next, null, 2) + '\n');
console.log('deployment.json now points at', ids.plan);
