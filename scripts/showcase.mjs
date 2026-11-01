// Launches a coin and trades it for real on testnet, so the chart has something to show: several
// test wallets of ours buying and selling, the dev Busted by their own plan, a release, and the dev
// selling what came out. These trades are real transactions, made by us, and the README says so.
//
//   node scripts/showcase.mjs [name] [ticker]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { connect, keyStores, KeyPair, utils, transactions } from 'near-api-js';

const S = JSON.parse(fs.readFileSync(new URL('../deployment.json', import.meta.url)));
const store = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
const mem = new keyStores.InMemoryKeyStore();
const near = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore: store });
const nearMem = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore: mem });
const dev = await near.account(S.dev);
const N = (n) => BigInt(utils.format.parseNearAmount(String(n)));
const T = (n) => BigInt(Math.round(n)) * 1_000_000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const view = (c, m, a) => dev.viewFunction({ contractId: c, methodName: m, args: a });
const call = (a, c, m, args, d = 0n, gas = 200_000_000_000_000n) => a.functionCall({ contractId: c, methodName: m, args, attachedDeposit: d, gas });

const name = process.argv[2] || 'Danfo Dog', symbol = process.argv[3] || 'DANDOG';
const terms = { holder: S.dev, cap: T(20_000_000).toString(), min_cap: T(2_000_000).toString(), period_secs: '60', start_in_secs: '0', notice_secs: '120', penalty_bps: 2000, sealed: null, loosen_allowed: false };
const made = await call(dev, S.launcher, 'launch', { name, symbol, terms }, BigInt(await view(S.launcher, 'launch_cost', {})), 280_000_000_000_000n);
const coin = JSON.parse(Buffer.from(made.status.SuccessValue, 'base64').toString());
await sleep(4000);
const { plan } = await view(S.market, 'get_pool', { token: coin });
console.log(`${coin}, plan #${plan}`);

const traders = [];
for (const label of ['ada', 'bola', 'chidi', 'funke', 'musa']) {
  const id = `${label}${Date.now().toString(36)}.${S.dev}`;
  const kp = KeyPair.fromRandom('ed25519');
  await mem.setKey('testnet', id, kp);
  await dev.signAndSendTransaction({ receiverId: id, actions: [transactions.createAccount(), transactions.transfer(N(0.7)), transactions.addKey(kp.getPublicKey(), transactions.fullAccessKey())] });
  traders.push(await nearMem.account(id));
}
const buy = (a, amount) => call(a, S.market, 'buy', { token: coin, min_out: '0' }, N(amount));
const sell = async (a, share) => { const has = BigInt(await view(coin, 'ft_balance_of', { account_id: a.accountId })); const amount = has * BigInt(Math.round(share * 100)) / 100n; if (amount > 0n) await call(a, coin, 'ft_transfer_call', { receiver_id: S.market, amount: amount.toString(), msg: '{"sell":{"min_out":"0"}}' }, 1n, 100_000_000_000_000n); };
const [ada, bola, chidi, funke, musa] = traders;
const steps = [
  () => buy(ada, 0.12), () => buy(bola, 0.25), () => buy(chidi, 0.08), () => sell(ada, 0.5), () => buy(funke, 0.3), () => buy(musa, 0.18),
  () => call(dev, S.plan, 'request_release', { plan_id: plan, amount: T(30_000_000).toString() }), // over the cap: Busted, and the cap drops to 16M
  () => buy(ada, 0.15), () => sell(bola, 0.4), () => buy(chidi, 0.22), () => call(dev, coin, 'storage_deposit', { account_id: S.dev }, N(0.0125)),
  () => call(dev, S.plan, 'request_release', { plan_id: plan, amount: T(10_000_000).toString() }), // inside the cap: it comes out
  () => call(dev, coin, 'ft_transfer_call', { receiver_id: S.market, amount: T(6_000_000).toString(), msg: '{"sell":{"min_out":"0"}}' }, 1n, 100_000_000_000_000n), // the dev sells, marked on the tape
  () => sell(funke, 0.6), () => buy(musa, 0.1), () => sell(chidi, 0.5), () => buy(bola, 0.2), () => buy(funke, 0.12), () => sell(ada, 0.3), () => buy(chidi, 0.16),
];
for (const [i, step] of steps.entries()) {
  await step().catch((e) => console.log(`step ${i}:`, String(e.message).slice(0, 120)));
  await sleep(14_000);
}
const p = await view(S.market, 'get_pool', { token: coin });
const pl = await view(S.plan, 'get_plan', { plan_id: plan });
console.log(`${p.trades} trades, market cap ${(Number(BigInt(p.price) * 1_000_000_000n) / 1e24).toFixed(2)} NEAR, plan: ${pl.busted} Busted, ${pl.releases} released, cap ${Number(BigInt(pl.cap) / 1_000_000n)}`);
