// Tops up the root account from NEAR's testnet faucet helper: makes a few funded throwaway
// accounts and deletes them into the root. Testnet only.
//   node scripts/topup.mjs [count]
import fs from 'fs'; import os from 'os'; import path from 'path';
import { connect, keyStores, KeyPair, InMemorySigner } from 'near-api-js';
const S = JSON.parse(fs.readFileSync(new URL('../deployment.json', import.meta.url)));
const mem = new keyStores.InMemoryKeyStore();
const near = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore: mem });
for (let i = 0; i < Number(process.argv[2] || 3); i++) {
  const id = `chokfill-${Date.now().toString(36)}${i}.testnet`;
  const kp = KeyPair.fromRandom('ed25519');
  const res = await fetch('https://helper.testnet.near.org/account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }) });
  if (!res.ok) { console.log('faucet said', res.status); break; }
  await mem.setKey('testnet', id, kp);
  await new Promise((r) => setTimeout(r, 4000));
  await (await near.account(id)).deleteAccount(S.root);
  console.log('swept', id);
}
const files = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
const n2 = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore: files });
console.log('root now', (Number(BigInt((await (await n2.account(S.root)).getAccountBalance()).available)) / 1e24).toFixed(2), 'NEAR');
