// End to end on NEAR testnet. The dev puts 100M BUSDOG in a plan held by an agent (cap 10M a
// minute, 20% penalty per Busted). The agent's only key can call request_release and nothing
// else. It releases under the cap, gets Busted asking for more (and the cap tightens), cannot
// loosen anything, and the dev's loosening waits out a public notice and can be cancelled.
//
//   node scripts/e2e.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { connect, keyStores, utils } from 'near-api-js';

const S = JSON.parse(fs.readFileSync(new URL('../deployment.json', import.meta.url)));
const files = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
const near = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore: files });
// the agent connection holds ONLY the scoped function-call key
const agentStore = new keyStores.InMemoryKeyStore();
await agentStore.setKey('testnet', S.agent, await files.getKey('testnet-agent', S.agent));
const nearAgent = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore: agentStore });

const dev = await near.account(S.dev), agent = await nearAgent.account(S.agent);
const T = (n) => (BigInt(n) * 1_000_000n).toString();
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const view = (contractId, methodName, args) => dev.viewFunction({ contractId, methodName, args });
const events = (out) => out.receipts_outcome.flatMap((r) => r.outcome.logs).filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice(11)));
const call = (acct, contractId, methodName, args, deposit = '0', gas = '100000000000000') => acct.functionCall({ contractId, methodName, args, attachedDeposit: BigInt(deposit), gas: BigInt(gas) });
const refusedBy = async (p) => { try { await p; return null; } catch (e) { return String(e.type || e.message).slice(0, 80); } };

// storage on the coin for the plan contract (the dev is registered as the minter)
await call(dev, S.coin, 'storage_deposit', { account_id: S.plan }, utils.format.parseNearAmount('0.01'));

// 1. the dev makes the plan: the agent holds it, the dev gets the releases
const made = await call(dev, S.plan, 'create_plan', { token: S.coin, holder: S.agent, beneficiary: S.dev, cap: T(10_000_000), period_secs: '60', start_in_secs: '0', notice_secs: '120', penalty_bps: 2000, sealed: null, loosen_allowed: true }, utils.format.parseNearAmount('0.05'));
const id = JSON.parse(Buffer.from(made.status.SuccessValue, 'base64').toString());
ok(Number.isInteger(id), `plan ${id} made: agent holds it, 10M BUSDOG a minute, 20% penalty per Busted`);

// 2. the dev's bag goes in
await call(dev, S.coin, 'ft_transfer_call', { receiver_id: S.plan, amount: T(100_000_000), msg: String(id) }, '1', '150000000000000');
let p = await view(S.plan, 'get_plan', { plan_id: id });
ok(p.balance === T(100_000_000), 'the plan holds 100M BUSDOG');

// 3. the agent releases under the cap, with its scoped key
const devBefore = BigInt(await view(S.coin, 'ft_balance_of', { account_id: S.dev }));
let out = await call(agent, S.plan, 'request_release', { plan_id: id, amount: T(5_000_000) });
await new Promise((r) => setTimeout(r, 3000));
const devAfter = BigInt(await view(S.coin, 'ft_balance_of', { account_id: S.dev }));
ok(events(out).some((e) => e.event === 'released') && devAfter - devBefore === BigInt(T(5_000_000)), 'the agent releases 5M under the cap; the dev receives exactly 5M');

// 4. the agent asks for far more: refused, recorded, cap tightens
out = await call(agent, S.plan, 'request_release', { plan_id: id, amount: T(50_000_000) });
const b = events(out).find((e) => e.event === 'busted');
p = await view(S.plan, 'get_plan', { plan_id: id });
ok(b && b.data[0].reason === 'over the cap' && p.busted === 1 && p.cap === T(8_000_000) && p.balance === T(95_000_000), `asking for 50M is Busted, nothing moves, the cap tightens 10M -> ${BigInt(p.cap) / 1_000_000n / 1_000_000n}M`);

// 5. the agent's key cannot do anything else, not even the plan's other methods
ok(!!(await refusedBy(call(agent, S.plan, 'propose_loosen', { plan_id: id, cap: T(100_000_000) }))), 'the agent key cannot propose a loosening (NEAR refuses the method)');
ok(!!(await refusedBy(call(agent, S.coin, 'ft_transfer', { receiver_id: S.agent, amount: '1' }, '1'))), 'the agent key cannot touch the coin contract at all');

// 6. loosening: only the dev, and it waits out a public notice
await call(dev, S.plan, 'propose_loosen', { plan_id: id, cap: T(20_000_000) });
p = await view(S.plan, 'get_plan', { plan_id: id });
ok(p.pending && p.pending.cap === T(20_000_000), 'the dev proposes a looser cap; it is public and pending');
ok(!!(await refusedBy(call(dev, S.plan, 'apply_loosen', { plan_id: id }))), 'it cannot apply before the notice runs out');
await call(dev, S.plan, 'cancel_loosen', { plan_id: id });
p = await view(S.plan, 'get_plan', { plan_id: id });
ok(!p.pending && p.cap === T(8_000_000), 'the dev cancels it; the cap stays where the Busted left it');

console.log(`\n${pass} passed, ${fail} failed. plan ${id} on ${S.plan}`);
fs.writeFileSync(new URL('../e2e-last.json', import.meta.url), JSON.stringify({ plan: id, at: new Date().toISOString(), pass, fail }, null, 2));
process.exit(fail ? 1 : 0);
