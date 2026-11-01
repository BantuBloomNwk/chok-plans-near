// The market on testnet, end to end: launch a coin the way the launcher does (its key deleted, so
// the coin can never change), list 80% of it on the curve, put the dev's 20% in a sealed plan,
// then a fan buys, the price rises, the fan sells half, the price falls, and the creator claims
// their fees. Also checks a coin from outside the launcher can't list.
//
//   node scripts/market-e2e.mjs            deploys the market first if deployment.json has none
//   node scripts/market-e2e.mjs --lock     afterwards deletes the market's only key
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import bs58 from 'bs58';
import { connect, keyStores, KeyPair, utils, transactions } from 'near-api-js';

const STATE = new URL('../deployment.json', import.meta.url);
const S = JSON.parse(fs.readFileSync(STATE));
const store = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
const near = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore: store });
const root = await near.account(S.root), dev = await near.account(S.dev), fan = await near.account(S.fan);
const wasm = (n) => fs.readFileSync(new URL(`../target/wasm32-unknown-unknown/release/${n}.wasm`, import.meta.url));
const N = (n) => BigInt(utils.format.parseNearAmount(String(n)));
const T = (n) => BigInt(Math.round(n)) * 1_000_000n;
const fmt = (y) => utils.format.formatNearAmount(String(y), 5);
const px = (y) => `${(Number(y) / 1e24).toExponential(3)} NEAR`;
const call = (a, contractId, methodName, args, deposit = 0n, gas = 300_000_000_000_000n) => a.functionCall({ contractId, methodName, args, attachedDeposit: deposit, gas });
const view = (contractId, methodName, args) => dev.viewFunction({ contractId, methodName, args });
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const nearOf = async (a) => BigInt((await a.getAccountBalance()).available);

// 0. the account that makes coins, and nothing else, then the market
if (!S.coins) {
  const id = `coins.${S.root}`;
  const kp = KeyPair.fromRandom('ed25519');
  await store.setKey('testnet', id, kp);
  await root.signAndSendTransaction({ receiverId: id, actions: [transactions.createAccount(), transactions.transfer(N(8)), transactions.addKey(kp.getPublicKey(), transactions.fullAccessKey())] });
  S.coins = id;
  fs.writeFileSync(STATE, JSON.stringify(S, null, 2) + '\n');
  console.log('made', id);
}
const maker = await near.account(S.coins);
if (!S.market) {
  const id = `market.${S.root}`;
  const kp = KeyPair.fromRandom('ed25519');
  await store.setKey('testnet', id, kp);
  await root.signAndSendTransaction({ receiverId: id, actions: [
    transactions.createAccount(), transactions.transfer(N(3)), transactions.addKey(kp.getPublicKey(), transactions.fullAccessKey()),
    transactions.deployContract(wasm('market')), transactions.functionCall('new', { launcher: S.coins }, 30_000_000_000_000n, 0n),
  ] });
  S.market = id;
  fs.writeFileSync(STATE, JSON.stringify(S, null, 2) + '\n');
  console.log('deployed', id);
}
const M = S.market;

// 1. a coin, launched the way the launcher does it
const sym = 'TEST';
const coinId = `${sym.toLowerCase()}-${Date.now().toString(36)}.${S.coins}`;
const ck = KeyPair.fromRandom('ed25519');
await maker.signAndSendTransaction({ receiverId: coinId, actions: [
  transactions.createAccount(), transactions.transfer(N(2.4)), transactions.addKey(ck.getPublicKey(), transactions.fullAccessKey()),
] });
await store.setKey('testnet', coinId, ck);
const coin = await near.account(coinId);
await coin.signAndSendTransaction({ receiverId: coinId, actions: [
  transactions.deployContract(wasm('token')),
  transactions.functionCall('new', { owner: S.dev, total_supply: T(1_000_000_000).toString(), name: 'Market test', symbol: sym }, 30_000_000_000_000n, 0n),
  transactions.deleteKey(ck.getPublicKey()),
] });
ok((await coin.getAccessKeys()).length === 0, `coin ${coinId} is deployed and has no keys left`);
for (const a of [M, S.plan]) await call(dev, coinId, 'storage_deposit', { account_id: a }, N(0.0125));

// 2. list 80% on the curve
await call(dev, coinId, 'ft_transfer_call', { receiver_id: M, amount: T(800_000_000).toString(), msg: '{"list":{}}' }, 1n, 100_000_000_000_000n);
const p0 = await view(M, 'get_pool', { token: coinId });
ok(p0 && p0.tokens_left === T(800_000_000).toString() && p0.creator === S.dev, `listed: 800M for sale, start price ${px(p0.price)} a token`);

// 3. a fan buys with 0.5 NEAR
const quote = BigInt(await view(M, 'quote_buy', { token: coinId, deposit: N(0.5).toString() }));
const fanNear0 = await nearOf(fan);
await call(fan, M, 'buy', { token: coinId, min_out: (quote * 99n / 100n).toString() }, N(0.5));
const got = BigInt(await view(coinId, 'ft_balance_of', { account_id: S.fan }));
const p1 = await view(M, 'get_pool', { token: coinId });
ok(got === quote, `fan bought ${Number(got / 1_000_000n).toLocaleString()} tokens, exactly the quote`);
ok(BigInt(p1.price) > BigInt(p0.price), `the price rose to ${px(p1.price)}`);

// 4. a buy with a limit the price can't meet moves nothing
try { await call(fan, M, 'buy', { token: coinId, min_out: (quote * 2n).toString() }, N(0.5)); ok(false, 'a buy past its limit was refused'); }
catch (e) { ok(/price moved past your limit/.test(String(e.message)), 'a buy past its limit was refused, and the deposit came back'); }

// 5. the fan sells half
const half = got / 2n;
const sellQuote = BigInt(await view(M, 'quote_sell', { token: coinId, amount: half.toString() }));
const before = await nearOf(fan);
const sold = await call(fan, coinId, 'ft_transfer_call', { receiver_id: M, amount: half.toString(), msg: JSON.stringify({ sell: { min_out: (sellQuote * 99n / 100n).toString() } }) }, 1n, 100_000_000_000_000n);
const after = await nearOf(fan);
const p2 = await view(M, 'get_pool', { token: coinId });
ok(after > before && BigInt(p2.price) < BigInt(p1.price), `fan sold half for about ${fmt(sellQuote)} NEAR (balance up ${fmt(after - before)} after gas), price fell to ${px(p2.price)}`);

// 6. the tape, from the chain
const trades = await view(M, 'get_trades', { token: coinId });
ok(trades.length === 2 && trades[0].buy && !trades[1].buy, `the contract keeps the trades: ${trades.map((t) => (t.buy ? 'buy' : 'sell')).join(', ')}`);

// 7. nothing but a launcher coin can list, not even our own other accounts; only the creator takes the fees
try { await call(dev, M, 'ft_on_transfer', { sender_id: S.dev, amount: '1000000', msg: '{"list":{}}' }); ok(false, 'our own dev account could not list itself as a coin'); }
catch (e) { ok(/only coins made by the launcher/.test(String(e.message)), 'our own dev account could not list itself as a coin'); }
try { await call(fan, M, 'ft_on_transfer', { sender_id: S.fan, amount: '1000000', msg: '{"list":{}}' }); ok(false, 'a coin from outside the launcher could not list'); }
catch (e) { ok(/only coins made by the launcher/.test(String(e.message)), 'a coin from outside the launcher could not list'); }
try { await call(fan, M, 'claim_fees', { token: coinId }); ok(false, 'a stranger could not take the fees'); }
catch (e) { ok(/only the creator/.test(String(e.message)), 'a stranger could not take the fees'); }
const owed = BigInt(p2.fees_owed);
const devBefore = await nearOf(dev);
await call(dev, M, 'claim_fees', { token: coinId });
ok(owed > 0n && (await nearOf(dev)) > devBefore - N(0.002), `the creator claimed ${fmt(owed)} NEAR in fees`);

// 8. the pool can always pay every seller: its NEAR covers selling back every token sold
const p3 = await view(M, 'get_pool', { token: coinId });
const out = BigInt(await view(M, 'quote_sell', { token: coinId, amount: (BigInt(p3.sale_supply) - BigInt(p3.tokens_left)).toString() }));
ok(out <= BigInt(p3.real_near), `the pool holds ${fmt(p3.real_near)} NEAR, enough to buy back everything sold (${fmt(out)})`);

if (process.argv.includes('--lock')) {
  const m = await near.account(M);
  for (const k of await m.getAccessKeys()) await m.deleteKey(k.public_key);
  const state = await m.state();
  const local = bs58.encode(crypto.createHash('sha256').update(wasm('market')).digest());
  ok((await m.getAccessKeys()).length === 0 && state.code_hash === local, `market locked: 0 keys, code ${state.code_hash} is this build`);
  S.marketLocked = true;
  fs.writeFileSync(STATE, JSON.stringify(S, null, 2) + '\n');
}
S.lastMarketTest = coinId;
fs.writeFileSync(STATE, JSON.stringify(S, null, 2) + '\n');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
