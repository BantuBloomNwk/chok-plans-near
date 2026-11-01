// Deploys the current plan contract to a fresh sub-account (the stored layout changed) and points
// deployment.json at it. Also re-registers it on the coin.
//   node scripts/redeploy.mjs <name>
import fs from 'fs';
import os from 'os';
import path from 'path';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';
const name = process.argv[2];
const STATE = new URL('../deployment.json', import.meta.url);
const S = JSON.parse(fs.readFileSync(STATE));
const store = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
const near = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore: store });
const root = await near.account(S.root);
const id = `${name}.${S.root}`;
// carry on if an earlier run already made the account
if (!(await store.getKey('testnet', id))) {
  const kp = KeyPair.fromRandom('ed25519');
  await store.setKey('testnet', id, kp);
  await root.createAccount(id, kp.getPublicKey(), utils.format.parseNearAmount('2.6'));
}
const acct = await near.account(id);
await acct.deployContract(fs.readFileSync(new URL('../target/wasm32-unknown-unknown/release/plan.wasm', import.meta.url)));
await acct.functionCall({ contractId: id, methodName: 'new', args: {} });
// the agent's scoped key must point at the new contract: replace it
const agent = await near.account(S.agent);
if (S.agentKey) { try { await agent.deleteKey(S.agentKey); } catch { /* already gone */ } }
const ak = KeyPair.fromRandom('ed25519');
await agent.addKey(ak.getPublicKey(), id, ['request_release'], utils.format.parseNearAmount('0.25'));
await store.setKey('testnet-agent', S.agent, ak);
Object.assign(S, { plan: id, agentKey: ak.getPublicKey().toString() });
fs.writeFileSync(STATE, JSON.stringify(S, null, 2) + '\n');
console.log('plan contract now at', id, '; agent key rescoped to it');
