// A launch and a market on testnet, end to end. One call to the launcher makes a coin with no keys,
// puts 80% on sale and the dev's 20% in a plan. Then a fan buys and the price rises, buys again and
// is not charged for registering twice, sells half and the price falls. The dev is refused when they
// ask for too much, gets out what the plan allows, and sells it back, more than the pool ever sold,
// which must leave the market readable. Needs the dev and fan keys in ~/.near-credentials/testnet.
//
//   node scripts/market-e2e.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { connect, keyStores, utils } from 'near-api-js';

const S = JSON.parse(fs.readFileSync(new URL('../deployment.json', import.meta.url)));
const store = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
const near = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore: store });
const dev = await near.account(S.dev), fan = await near.account(S.fan);
const N = (n) => BigInt(utils.format.parseNearAmount(String(n)));
const T = (n) => BigInt(Math.round(n)) * 1_000_000n;
const fmt = (y) => utils.format.formatNearAmount(String(y), 5);
const call = (a, contractId, methodName, args, deposit = 0n, gas = 300_000_000_000_000n) => a.functionCall({ contractId, methodName, args, attachedDeposit: deposit, gas });
const view = (contractId, methodName, args) => dev.viewFunction({ contractId, methodName, args });
const refused = async (f, re) => { try { await f(); return false; } catch (e) { return re.test(String(e.message)); } };
const nearOf = async (a) => BigInt((await a.getAccountBalance()).available);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const M = S.market, P = S.plan, L = S.launcher;

// 1. one call: the coin, its sale and its plan
const cost = BigInt(await view(L, 'launch_cost', {}));
const terms = { holder: S.dev, cap: T(20_000_000).toString(), min_cap: T(2_000_000).toString(), period_secs: '60', start_in_secs: '0', notice_secs: '120', penalty_bps: 2000, sealed: null, loosen_allowed: false };
const made = await call(dev, L, 'launch', { name: 'Market test', symbol: 'TEST', terms }, cost);
const coin = JSON.parse(Buffer.from(made.status.SuccessValue, 'base64').toString());
await sleep(3000);
const pool = await view(M, 'get_pool', { token: coin });
const coinAcct = await near.account(coin);
ok((await coinAcct.getAccessKeys()).length === 0, `${coin} has no keys, cost ${fmt(cost)} NEAR to launch`);
ok(pool && pool.tokens_left === T(800_000_000).toString() && pool.creator === S.dev, 'the launch put 800M on sale, in one call');
const plan = await view(P, 'get_plan', { plan_id: pool.plan });
ok(plan.balance === T(200_000_000).toString() && plan.beneficiary === S.dev && plan.token === coin, `the dev's 200M went straight into plan #${pool.plan}, recorded on the pool`);
ok(BigInt(await view(coin, 'ft_balance_of', { account_id: S.dev })) === 0n, 'the dev holds none of it loose');

// 2. the fan buys
const q1 = BigInt(await view(M, 'quote_buy', { token: coin, deposit: N(0.5).toString() }));
await call(fan, M, 'buy', { token: coin, min_out: (q1 * 99n / 100n).toString() }, N(0.5));
const got = BigInt(await view(coin, 'ft_balance_of', { account_id: S.fan }));
const p1 = await view(M, 'get_pool', { token: coin });
ok(got === q1 && BigInt(p1.price) > BigInt(pool.price), `fan bought ${got / 1_000_000n} tokens, exactly the quote, and the price rose`);

// 3. buying again costs no second registration
const q2 = BigInt(await view(M, 'quote_buy', { token: coin, deposit: N(0.1).toString() }));
const a0 = await nearOf(fan);
await call(fan, M, 'buy', { token: coin, min_out: '0' }, N(0.1));
await sleep(2000);
const spent = a0 - await nearOf(fan);
ok(spent < N(0.1) - N(0.0005), `a second buy gave the registration money back (spent ${fmt(spent)} of 0.1 NEAR, gas included)`);

// 4. past its limit, nothing happens
ok(await refused(() => call(fan, M, 'buy', { token: coin, min_out: (q1 * 2n).toString() }, N(0.5)), /price moved past your limit/), 'a buy past its limit was refused and the deposit came back');

// 5. the fan sells half
const half = got / 2n;
const qs = BigInt(await view(M, 'quote_sell', { token: coin, amount: half.toString() }));
const b0 = await nearOf(fan);
await call(fan, coin, 'ft_transfer_call', { receiver_id: M, amount: half.toString(), msg: JSON.stringify({ sell: { min_out: (qs * 99n / 100n).toString() } }) }, 1n, 100_000_000_000_000n);
await sleep(2000);
const p2 = await view(M, 'get_pool', { token: coin });
ok((await nearOf(fan)) > b0 && BigInt(p2.price) < BigInt(p1.price), `fan sold half for about ${fmt(qs)} NEAR, price fell`);

// 6. the tape
const tape = await view(M, 'get_trades', { token: coin });
ok(tape.length === 3 && tape[0].buy && tape[1].buy && !tape[2].buy, `the contract keeps the trades: ${tape.map((t) => (t.buy ? 'buy' : 'sell')).join(', ')}`);

// 7. outside coins and old routes can't list
ok(await refused(() => call(dev, M, 'list_launched', { creator: S.dev, sale: '1000000' }), /only coins made by the launcher|promise result/i), 'our own dev account could not list itself as a coin');
const fanHas = await view(coin, 'ft_balance_of', { account_id: S.fan }), poolsBefore = (await view(M, 'list_pools', { limit: 200 })).length;
await call(fan, coin, 'ft_transfer_call', { receiver_id: M, amount: '1000000', msg: '{"list":{}}' }, 1n).catch(() => {});
await sleep(2000);
ok((await view(coin, 'ft_balance_of', { account_id: S.fan })) === fanHas && (await view(M, 'list_pools', { limit: 200 })).length === poolsBefore, 'tokens sent with a list message came straight back and listed nothing');
ok(await refused(() => call(dev, P, 'create_launched', { dev: S.dev, terms, amount: '1' }, N(0.1)), /only coins made by the launcher/), 'only a launched coin can bring its plan with it');
ok(await refused(() => call(fan, M, 'claim_fees', { token: coin }), /only the creator/), 'a stranger could not take the fees');

// 8. the plan binds the dev: too much is Busted, less comes out
const before = await view(P, 'get_plan', { plan_id: pool.plan });
await call(dev, P, 'request_release', { plan_id: pool.plan, amount: T(25_000_000).toString() });
const afterBust = await view(P, 'get_plan', { plan_id: pool.plan });
ok(afterBust.busted === before.busted + 1 && BigInt(afterBust.cap) === T(16_000_000), 'the dev asked for 25M over a 20M cap: Busted, and the cap is 16M');
await call(dev, coin, 'storage_deposit', { account_id: S.dev }, N(0.0125));
await call(dev, P, 'request_release', { plan_id: pool.plan, amount: T(16_000_000).toString() });
await sleep(3000);
ok(BigInt(await view(coin, 'ft_balance_of', { account_id: S.dev })) === T(16_000_000), 'then the dev got the 16M the plan allows');
const log = await view(P, 'get_log', { plan_id: pool.plan });
ok(log.map((e) => e.kind).join() === 'busted,released', `the plan's own log says: ${log.map((e) => e.kind).join(', ')}`);

// 9. the bug this round fixed: sell back more than the pool ever sold, and the market still reads
await call(dev, coin, 'ft_transfer_call', { receiver_id: M, amount: T(16_000_000).toString(), msg: '{"sell":{"min_out":"0"}}' }, 1n, 100_000_000_000_000n);
await call(fan, coin, 'ft_transfer_call', { receiver_id: M, amount: (await view(coin, 'ft_balance_of', { account_id: S.fan })), msg: '{"sell":{"min_out":"0"}}' }, 1n, 100_000_000_000_000n);
await sleep(2000);
const p3 = await view(M, 'get_pool', { token: coin });
const all = await view(M, 'list_pools', { from: 0, limit: 200 });
ok(BigInt(p3.tokens_left) > BigInt(p3.sale_supply) && p3.sold_bps === 0 && all.some((x) => x.token === coin), 'the pool took back more than it sold, and every market view still reads');

// 10. the creator takes the fees
const owed = BigInt(p3.fees_owed);
await call(dev, M, 'claim_fees', { token: coin });
ok(owed > 0n, `the creator claimed ${fmt(owed)} NEAR in fees`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
