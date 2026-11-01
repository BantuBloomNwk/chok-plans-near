// The playground behind the demo page. A visitor gets their own sealed plan with 20M BUSDOG in it,
// or launches their own coin with a plan, and then gives the agent instructions. The agent tries
// whatever it's told with its only key, which can call request_release on the plan contract and
// nothing else; the chain and the sealed judge decide. Each plan's rules come from a master seed,
// so revealing one plan shows only that plan's rules.
//
//   NEAR_CREDENTIALS=~/.near-credentials SEED_FILE=~/.chok-near-seed PORT=8790 node server/demo.mjs

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const RPC = 'https://test.rpc.fastnear.com';
const S = JSON.parse(fs.readFileSync(new URL('../deployment.json', import.meta.url)));
const JUDGE = { hash: '7e694289acabfdada2048a79d98ddf0d844d853d3a3752a33ca84bcc14c95535' };
JUDGE.url = `https://chok-api.161-97-74-212.sslip.io/wasm/${JUDGE.hash}.wasm`;
const SEED = fs.readFileSync(process.env.SEED_FILE || path.join(os.homedir(), '.chok-near-seed'), 'utf8').trim();
const DATA = process.env.DATA_DIR || new URL('./data', import.meta.url).pathname;
fs.mkdirSync(DATA, { recursive: true });
const DB = path.join(DATA, 'playground.json');
const db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : { plans: {}, coins: [] };
const save = () => fs.writeFileSync(DB, JSON.stringify(db));

const files = new keyStores.UnencryptedFileSystemKeyStore(process.env.NEAR_CREDENTIALS || path.join(os.homedir(), '.near-credentials'));
const near = await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore: files });
const agentStore = new keyStores.InMemoryKeyStore();
await agentStore.setKey('testnet', S.agent, await files.getKey('testnet-agent', S.agent));
const agent = await (await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore: agentStore })).account(S.agent);
const dev = await near.account(S.dev);
const root = await near.account(S.root);
const TOKEN_WASM = fs.readFileSync(new URL('../target/wasm32-unknown-unknown/release/token.wasm', import.meta.url));

const tokens = (n) => (BigInt(Math.round(n)) * 1_000_000n).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (acct, contractId, methodName, args, deposit = '0', gas = '300000000000000') => acct.functionCall({ contractId, methodName, args, attachedDeposit: BigInt(deposit), gas: BigInt(gas) });
const view = (contractId, methodName, args) => dev.viewFunction({ contractId, methodName, args });

// the same derivation as the judge: this plan's rules and commitment from the master seed
function rulesFor(planId) {
  const h = crypto.createHash('sha256').update(`chok-rules-v1|${SEED}|${planId}`).digest();
  const n = BigInt(h.readUInt32LE(0));
  const max = ((2_000_000n + n % 2_000_001n) * 1_000_000n).toString();
  const gap = 20 + (h[4] % 21);
  const salt = crypto.createHash('sha256').update(`chok-salt-v1|${SEED}|${planId}`).digest('hex');
  const commitment = crypto.createHash('sha256').update(`chok-sealed-v1|${max}|0|${gap}|${salt}`).digest('hex');
  return { max_per_release: max, earliest: 0, min_gap_secs: gap, salt, commitment };
}

// one plan creation at a time, so the id the commitment was made for is the id the plan gets
let queue = Promise.resolve();
const serial = (f) => { const p = queue.then(f, f); queue = p.catch(() => {}); return p; };

const PUBLIC_CAP = 10_000_000, IN_PLAN = 20_000_000;
async function makePlan(coin, amount = IN_PLAN, cap = PUBLIC_CAP) {
  return serial(async () => {
    const id = await view(S.plan, 'next_plan_id', {});
    const r = rulesFor(id);
    await call(dev, S.plan, 'create_plan', {
      token: coin, holder: S.agent, beneficiary: S.dev, cap: tokens(cap), period_secs: '60', start_in_secs: '0', notice_secs: '300', penalty_bps: 2000,
      sealed: { commitment: r.commitment, judge_url: JUDGE.url, judge_hash: JUDGE.hash, outlayer: 'outlayer.testnet', secrets_owner: S.dev, secrets_profile: 'playground' },
    }, utils.format.parseNearAmount('0.05'));
    await call(dev, coin, 'ft_transfer_call', { receiver_id: S.plan, amount: tokens(amount), msg: String(id) }, '1', '150000000000000');
    db.plans[id] = { coin, made: Date.now(), revealed: false };
    save();
    return { plan: id, coin, commitment: r.commitment, cap, inPlan: amount };
  });
}

// what the visitor told the agent, turned into the things it will try, in order
function understand(text, balanceTokens) {
  const t = String(text || '').toLowerCase().slice(0, 400);
  const tries = [];
  const to = t.match(/(?:send|transfer|give|pay|move)[^\n]*?\bto\s+([a-z0-9_.-]+\.(?:testnet|near))/);
  if (to) tries.push({ kind: 'transfer', to: to[1] });
  if (/loosen|raise|increase|lift|remove (?:the )?(?:cap|limit)|unlock everything|change the (?:rules|cap)/.test(t)) tries.push({ kind: 'loosen' });
  if (/\b(all|everything|dump|entire|whole bag|max(?:imum)?|ignore)/.test(t)) tries.push({ kind: 'release', amount: balanceTokens, why: 'everything' });
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(m\b|million|k\b|thousand)?/g)) {
    if (tries.filter((x) => x.kind === 'release').length >= 4) break;
    const n = Number(m[1]) * (m[2]?.startsWith('m') ? 1e6 : m[2]?.startsWith('k') || m[2] === 'thousand' ? 1e3 : 1);
    if (n >= 1) tries.push({ kind: 'release', amount: Math.min(n, balanceTokens) });
  }
  if (!tries.length) tries.push({ kind: 'release', amount: Math.min(1_000_000, balanceTokens), why: 'no amount given, so 1M' });
  return tries;
}

async function attempt(planId, coin, x) {
  const t0 = Date.now();
  try {
    if (x.kind === 'transfer') {
      const out = await call(agent, coin, 'ft_transfer', { receiver_id: x.to, amount: tokens(1_000_000) });
      return { ...x, outcome: 'went through', tx: out.transaction.hash };
    }
    if (x.kind === 'loosen') {
      const out = await call(agent, S.plan, 'propose_loosen', { plan_id: planId, cap: tokens(1_000_000_000) });
      return { ...x, outcome: 'went through', tx: out.transaction.hash };
    }
    const before = await view(S.plan, 'get_plan', { plan_id: planId });
    const out = await call(agent, S.plan, 'request_release', { plan_id: planId, amount: tokens(x.amount) });
    let p = await view(S.plan, 'get_plan', { plan_id: planId });
    for (let i = 0; i < 45 && p.awaiting; i++) { await sleep(1500); p = await view(S.plan, 'get_plan', { plan_id: planId }); }
    const logs = out.receipts_outcome.flatMap((r) => r.outcome.logs).filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice(11)));
    const judged = logs.some((e) => e.event === 'sent_to_judge');
    let reason = logs.find((e) => e.event === 'busted')?.data[0].reason ?? null;
    if (!reason && p.busted > before.busted) reason = 'refused by a sealed rule';
    const outcome = p.releases > before.releases ? 'released' : p.busted > before.busted ? 'busted' : 'no verdict';
    if (outcome === 'busted' && judged) {
      // the verdict's own reason is in the callback receipt; read the final tree for it
      const tx = await near.connection.provider.txStatus(out.transaction.hash, S.agent, 'FINAL').catch(() => null);
      const ev = (tx?.receipts_outcome ?? []).flatMap((r) => r.outcome.logs).filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice(11))).find((e) => e.event === 'busted');
      if (ev) reason = ev.data[0].reason;
    }
    return { ...x, outcome, reason, judged, tx: out.transaction.hash, capAfter: Number(BigInt(p.cap) / 1_000_000n) / 1e6, secs: (Date.now() - t0) / 1000 };
  } catch (e) {
    // NEAR refusing the agent's key outright (it may only call request_release on the plan)
    const kind = String(e.type || e.message || '').match(/MethodNameMismatch|ReceiverMismatch|NotEnoughAllowance|[A-Z][A-Za-z]+Mismatch/)?.[0] || String(e.type || 'refused');
    return { ...x, outcome: 'refused by NEAR', error: kind, secs: (Date.now() - t0) / 1000 };
  }
}

async function launchCoin(name, symbol) {
  const sym = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const label = `${sym.toLowerCase()}-${Date.now().toString(36)}`;
  const id = `${label}.${S.root}`;
  const kp = KeyPair.fromRandom('ed25519');
  await files.setKey('testnet', id, kp);
  const step = async (what, f) => { try { return await f(); } catch (e) { throw new Error(`${what}: ${String(e.message).slice(0, 160)}`); } };
  await step('creating the coin account', () => root.createAccount(id, kp.getPublicKey(), utils.format.parseNearAmount('2.35')));
  const coin = await near.account(id);
  await step('deploying the coin', () => coin.deployContract(TOKEN_WASM));
  await step('minting', () => call(coin, id, 'new', { owner: S.dev, total_supply: tokens(1_000_000_000), name: name.slice(0, 32), symbol: sym }));
  await step('registering the plan contract', () => call(dev, id, 'storage_deposit', { account_id: S.plan }, utils.format.parseNearAmount('0.01')));
  // the dev's bag, 20% of supply, goes into a sealed plan from the start
  const made = await step('making the plan', () => makePlan(id, 200_000_000, 20_000_000));
  db.coins.push({ coin: id, name, symbol: sym, plan: made.plan, at: Date.now() });
  save();
  return { ...made, name, symbol: sym };
}

// visitors share these limits: plans and coins cost testnet NEAR
const seen = new Map();
const allow = (key, n, ms) => { const now = Date.now(), list = (seen.get(key) || []).filter((t) => now - t < ms); if (list.length >= n) return false; list.push(now); seen.set(key, list); return true; };

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' }); res.end(JSON.stringify(body)); };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
  if (req.method === 'GET' && url.pathname === '/near/coins') return json(res, 200, db.coins.slice(-20).reverse());
  if (req.method === 'GET' && url.pathname === '/near/info') return json(res, 200, { plan: S.plan, agent: S.agent, dev: S.dev, coin: S.coin, judge: JUDGE, publicCap: PUBLIC_CAP, inPlan: IN_PLAN });
  if (req.method !== 'POST') return json(res, 404, { error: 'unknown path' });
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 4000) req.destroy(); });
  req.on('end', async () => {
    try {
      const body = JSON.parse(raw || '{}');
      if (url.pathname === '/near/plan') {
        if (!allow(`plan:${ip}`, 4, 3_600_000) || !allow('plan:all', 60, 86_400_000)) return json(res, 429, { error: 'That is enough plans for now. Try again in a while.' });
        return json(res, 200, await makePlan(S.coin));
      }
      if (url.pathname === '/near/coin') {
        const name = String(body.name || '').trim(), symbol = String(body.symbol || '').trim();
        if (!name || !/^[a-z0-9]{2,8}$/i.test(symbol)) return json(res, 400, { error: 'Give it a name and a ticker of 2 to 8 letters or numbers.' });
        if (!allow(`coin:${ip}`, 2, 3_600_000) || !allow('coin:all', 12, 86_400_000)) return json(res, 429, { error: 'That is enough new coins for today.' });
        return json(res, 200, await launchCoin(name, symbol));
      }
      const planId = Number(body.plan);
      const known = db.plans[planId];
      if (!known) return json(res, 404, { error: 'Not a playground plan.' });
      if (url.pathname === '/near/ask') {
        if (!allow(`ask:${ip}`, 30, 600_000)) return json(res, 429, { error: 'Slow down a little.' });
        const p = await view(S.plan, 'get_plan', { plan_id: planId });
        const tries = understand(body.text, Number(BigInt(p.balance) / 1_000_000n));
        const results = [];
        for (const x of tries.slice(0, 5)) results.push(await attempt(planId, known.coin, x));
        return json(res, 200, { understood: tries.slice(0, 5), results });
      }
      if (url.pathname === '/near/reveal') {
        known.revealed = true; save();
        const { commitment, ...rules } = rulesFor(planId);
        return json(res, 200, { plan: planId, rules, commitment });
      }
      json(res, 404, { error: 'unknown path' });
    } catch (e) { json(res, 500, { error: String(e.message || e).slice(0, 200) }); }
  });
}).listen(Number(process.env.PORT || 8790));
console.log(`playground on :${process.env.PORT || 8790}, plans on ${S.plan}, agent ${S.agent}`);
