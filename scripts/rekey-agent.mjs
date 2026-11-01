// Replaces the agent's function-call key (same scope: request_release on the plan contract only)
// with a bigger gas allowance. A judged request reserves up to 0.3 NEAR of gas up front.
//   node scripts/rekey-agent.mjs [allowanceNear]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';
const STATE = new URL('../deployment.json', import.meta.url);
const S = JSON.parse(fs.readFileSync(STATE));
const store = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
const near = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore: store });
const agent = await near.account(S.agent);
try { await agent.deleteKey(S.agentKey); } catch { /* already gone */ }
const kp = KeyPair.fromRandom('ed25519');
await agent.addKey(kp.getPublicKey(), S.plan, ['request_release'], utils.format.parseNearAmount(process.argv[2] || '1'));
await store.setKey('testnet-agent', S.agent, kp);
S.agentKey = kp.getPublicKey().toString();
fs.writeFileSync(STATE, JSON.stringify(S, null, 2) + '\n');
console.log('agent key replaced: request_release on', S.plan, 'only, allowance', process.argv[2] || '1', 'NEAR');
