// The demo coin has a fixed supply, and every playground plan locks 20M of it. This brings tokens
// home from old playground plans the only way anyone can: the agent asks for releases that follow
// each plan's own sealed rules, and the judge clears them. Releases go to the dev, who funds the
// next visitors' plans. One release per plan per run.
//
//   node scripts/recycle.mjs [rounds]
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { connect, keyStores } from 'near-api-js';

const S = JSON.parse(fs.readFileSync(new URL('../deployment.json', import.meta.url)));
const SEED = fs.readFileSync(path.join(os.homedir(), '.chok-near-seed'), 'utf8').trim();
const RPC = 'https://test.rpc.fastnear.com';
const files = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), '.near-credentials'));
const near = await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore: files });
const agentStore = new keyStores.InMemoryKeyStore();
await agentStore.setKey('testnet', S.agent, await files.getKey('testnet-agent', S.agent));
const agent = await (await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore: agentStore })).account(S.agent);
const dev = await near.account(S.dev);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const view = (methodName, args) => dev.viewFunction({ contractId: S.plan, methodName, args });

// the same per-plan max and gap the judge derives from the seed (see server/demo.mjs)
function rules(planId) {
  const h = crypto.createHash('sha256').update(`chok-rules-v1|${SEED}|${planId}`).digest();
  return { max: (2_000_000n + BigInt(h.readUInt32LE(0)) % 2_000_001n) * 1_000_000n, gap: 20 + (h[4] % 21) };
}

const rounds = Number(process.argv[2] || 1);
const balance = async () => BigInt(await dev.viewFunction({ contractId: S.coin, methodName: 'ft_balance_of', args: { account_id: S.dev } }));
console.log(`dev holds ${Number(await balance() / 1_000_000n) / 1e6}M`);
for (let round = 0; round < rounds; round++) {
  const plans = (await view('list_plans', { from: 0, limit: 100 })).filter(([, p]) => p.holder === S.agent && BigInt(p.balance) > 0n && !p.awaiting);
  const now = BigInt(Date.now()) * 1_000_000n;
  // one transaction at a time from the agent's single key, but the judge works on them in parallel
  const sent = [];
  for (const [id, p] of plans) {
    const r = rules(id);
    const periodLeft = now - BigInt(p.period_start) >= BigInt(p.period_ns) ? BigInt(p.cap) : BigInt(p.cap) - BigInt(p.released_in_period);
    let amount = [r.max, periodLeft, BigInt(p.balance)].reduce((a, b) => (a < b ? a : b));
    amount = (amount / 1_000_000n) * 1_000_000n;
    if (amount <= 0n) continue;
    try {
      await agent.functionCall({ contractId: S.plan, methodName: 'request_release', args: { plan_id: id, amount: amount.toString() }, gas: 300_000_000_000_000n });
      sent.push(id);
    } catch (e) { console.log(`plan ${id}: ${String(e.message).slice(0, 80)}`); }
  }
  console.log(`round ${round + 1}: asked on ${sent.length} plans`);
  if (round < rounds - 1) await sleep(45_000);
}
await sleep(15_000);
console.log(`dev now holds ${Number(await balance() / 1_000_000n) / 1e6}M`);
