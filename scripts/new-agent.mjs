// A quick-try agent: one function-call key for request_release on the plan contract, with a gas
// allowance. If the live one runs low, make another, point "agent" in deployment.json at it and
// redeploy the server. No contract changes. Paid from the root account.
//
//   node scripts/new-agent.mjs <name> <allowance in NEAR>
import fs from 'fs';
import os from 'os';
import path from 'path';
import { connect, keyStores, KeyPair, utils, transactions } from 'near-api-js';

const [name, allowance] = process.argv.slice(2);
if (!allowance) { console.error('usage: new-agent.mjs <name> <allowance in NEAR>'); process.exit(1); }
const S = JSON.parse(fs.readFileSync(new URL('../deployment.json', import.meta.url)));
const store = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
const near = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore: store });
const N = (n) => BigInt(utils.format.parseNearAmount(String(n)));
const id = `${name}.${S.root}`;
const kp = KeyPair.fromRandom('ed25519');
await store.setKey('testnet-agent', id, kp);
await (await near.account(S.root)).signAndSendTransaction({ receiverId: id, actions: [
  transactions.createAccount(), transactions.transfer(N(Number(allowance) + 0.2)),
  transactions.addKey(kp.getPublicKey(), transactions.functionCallAccessKey(S.plan, ['request_release'], N(allowance))),
] });
console.log(`${id}: one key, request_release on ${S.plan}, ${allowance} NEAR of gas`);
