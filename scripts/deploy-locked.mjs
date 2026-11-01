// Deploys the plan contract to a fresh account and then deletes every key on that account, so
// nobody (us included) can redeploy it or change it. Also makes a new quick-try agent whose only
// key is a function-call key for request_release on the new contract, and points
// deployment.json at both. The old contract stays where it is, for the record.
//
//   node scripts/deploy-locked.mjs <name>
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import bs58 from 'bs58';
import { connect, keyStores, KeyPair, utils, transactions } from 'near-api-js';

const name = process.argv[2];
if (!name) { console.error('name the new account, e.g. locked'); process.exit(1); }
const STATE = new URL('../deployment.json', import.meta.url);
const S = JSON.parse(fs.readFileSync(STATE));
const store = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
const near = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore: store });
const root = await near.account(S.root), dev = await near.account(S.dev);
const wasm = fs.readFileSync(new URL('../target/wasm32-unknown-unknown/release/plan.wasm', import.meta.url));
const id = `${name}.${S.root}`;

// 1. the contract account, deployed, initialised and funded in one transaction
const kp = KeyPair.fromRandom('ed25519');
await store.setKey('testnet', id, kp);
await root.signAndSendTransaction({ receiverId: id, actions: [
  transactions.createAccount(),
  transactions.transfer(BigInt(utils.format.parseNearAmount('9'))),
  transactions.addKey(kp.getPublicKey(), transactions.fullAccessKey()),
  transactions.deployContract(wasm),
  transactions.functionCall('new', {}, 30_000_000_000_000n, 0n),
] });
console.log('deployed', id);

// 2. it needs storage on the demo coin to hold plans of it
await dev.functionCall({ contractId: S.coin, methodName: 'storage_deposit', args: { account_id: id }, attachedDeposit: BigInt(utils.format.parseNearAmount('0.0125')), gas: 30_000_000_000_000n });

// 3. a quick-try agent made with one function-call key and no full-access key, ever
const agentId = `quickagent.${S.root}`;
const ak = KeyPair.fromRandom('ed25519');
await store.setKey('testnet-agent', agentId, ak);
await root.signAndSendTransaction({ receiverId: agentId, actions: [
  transactions.createAccount(),
  transactions.transfer(BigInt(utils.format.parseNearAmount('2.5'))),
  transactions.addKey(ak.getPublicKey(), transactions.functionCallAccessKey(id, ['request_release'], BigInt(utils.format.parseNearAmount('2')))),
] });
console.log('quick-try agent', agentId);

// 4. lock the contract: delete its only key
const contract = await near.account(id);
await contract.deleteKey(kp.getPublicKey());
const keys = await contract.getAccessKeys();
const state = await contract.state();
const local = bs58.encode(crypto.createHash('sha256').update(wasm).digest());
console.log('contract keys left:', keys.length, '| code hash on chain', state.code_hash, '| local build', local, state.code_hash === local ? 'MATCH' : 'DIFFERENT');
const agentKeys = (await (await near.account(agentId)).getAccessKeys()).map((k) => (k.access_key.permission === 'FullAccess' ? 'FULL' : `${k.access_key.permission.FunctionCall.method_names} on ${k.access_key.permission.FunctionCall.receiver_id}`));
console.log('agent keys:', agentKeys);

Object.assign(S, { legacyPlan: S.plan, legacyAgent: S.agent, plan: id, agent: agentId, agentKey: ak.getPublicKey().toString(), planCodeHash: state.code_hash, planLocked: keys.length === 0 });
fs.writeFileSync(STATE, JSON.stringify(S, null, 2) + '\n');
console.log('deployment.json now points at', id);
