// Testnet setup: a root account from NEAR's faucet helper, sub-accounts for the plan contract,
// the demo coin, the dev, the agent and a fan, both contracts deployed, and the agent given a
// function-call key that can only call `request_release` on the plan. Keys live in
// ~/.near-credentials/testnet (the CLI's usual place), never in the repo.
//
//   node scripts/setup.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const NETWORK = 'testnet';
const store = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
const near = await connect({ networkId: NETWORK, nodeUrl: 'https://test.rpc.fastnear.com', keyStore: store });
const STATE = new URL('../deployment.json', import.meta.url);
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE)) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');

// 1. the root account, funded by the testnet faucet helper
if (!state.root) {
  const root = `chokplans-${Date.now().toString(36)}.testnet`;
  const kp = KeyPair.fromRandom('ed25519');
  const res = await fetch('https://helper.testnet.near.org/account', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: root, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!res.ok) throw new Error(`faucet helper said ${res.status}: ${await res.text()}`);
  await store.setKey(NETWORK, root, kp);
  state.root = root; save();
  console.log('root account', root);
  await new Promise((r) => setTimeout(r, 3000));
}
const root = await near.account(state.root);

// 2. sub-accounts, each with its own full-access key
async function sub(name, nearAmount) {
  const id = `${name}.${state.root}`;
  if (state[name]) return near.account(id);
  const kp = KeyPair.fromRandom('ed25519');
  await root.createAccount(id, kp.getPublicKey(), utils.format.parseNearAmount(String(nearAmount)));
  await store.setKey(NETWORK, id, kp);
  state[name] = id; save();
  console.log('created', id);
  return near.account(id);
}
const plan = await sub('plan', 3);
const coin = await sub('coin', 3);
const dev = await sub('dev', 1);
const agent = await sub('agent', 0.5);
const fan = await sub('fan', 0.5);

// 3. deploy and initialise both contracts
const wasm = (n) => fs.readFileSync(new URL(`../target/wasm32-unknown-unknown/release/${n}.wasm`, import.meta.url));
if (!state.planDeployed) {
  await plan.deployContract(wasm('plan'));
  await plan.functionCall({ contractId: state.plan, methodName: 'new', args: {} });
  state.planDeployed = true; save();
  console.log('plan contract deployed and initialised');
}
if (!state.coinDeployed) {
  await coin.deployContract(wasm('token'));
  // a billion BUSDOG with six decimals, all to the dev
  await coin.functionCall({ contractId: state.coin, methodName: 'new', args: { owner: state.dev, total_supply: (10n ** 15n).toString(), name: 'Busted Dog', symbol: 'BUSDOG' } });
  state.coinDeployed = true; save();
  console.log('coin deployed: 1,000,000,000 BUSDOG to the dev');
}

// 4. the agent's key: it may only call request_release on the plan contract, and spend at most 0.25 NEAR on gas
if (!state.agentKey) {
  const kp = KeyPair.fromRandom('ed25519');
  const fullAgent = await near.account(state.agent);
  await fullAgent.addKey(kp.getPublicKey(), state.plan, ['request_release'], utils.format.parseNearAmount('0.25'));
  // keep it apart from the agent's full key so the demo agent only ever holds the limited one
  await store.setKey(`${NETWORK}-agent`, state.agent, kp);
  state.agentKey = kp.getPublicKey().toString(); save();
  console.log('agent function-call key added, scoped to', state.plan, 'request_release only');
}
console.log(JSON.stringify(state, null, 2));
