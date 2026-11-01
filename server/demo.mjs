// The playground behind the demo page. A visitor gets their own sealed plan with 20M BUSDOG in it,
// or launches a coin with a plan, and then gives the agent instructions. The agent tries whatever
// it's told with its only key, which can call request_release on the plan contract and nothing
// else; the chain and the sealed judge decide. Each plan's rules come from a master seed, so
// revealing one plan shows only that plan's rules. Each plan and hired agent answers only to whoever
// got its ticket when it was made.
//
//   NEAR_CREDENTIALS=~/.near-credentials SEED_FILE=~/.chok-near-seed PORT=8790 node server/demo.mjs

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { connect, keyStores, KeyPair, utils, transactions } from 'near-api-js';
import { think, attestation, MODEL } from '../agent/brain.mjs';

const RPC = 'https://test.rpc.fastnear.com';
const S = JSON.parse(fs.readFileSync(new URL('../deployment.json', import.meta.url)));
const JUDGE = { hash: S.judges[0] };
JUDGE.url = `https://chok-plans-near.netlify.app/judge/${JUDGE.hash}.wasm`;
const SEED = fs.readFileSync(process.env.SEED_FILE || path.join(os.homedir(), '.chok-near-seed'), 'utf8').trim();
const DATA = process.env.DATA_DIR || new URL('./data', import.meta.url).pathname;
fs.mkdirSync(DATA, { recursive: true });
// one file per plan contract: a new contract starts its plan ids again
const DB = path.join(DATA, `playground-${S.plan.split('.')[0]}.json`);
const db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : { plans: {} };
const save = () => fs.writeFileSync(DB, JSON.stringify(db));

const files = new keyStores.UnencryptedFileSystemKeyStore(process.env.NEAR_CREDENTIALS || path.join(os.homedir(), '.near-credentials'));
const near = await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore: files });
const agentStore = new keyStores.InMemoryKeyStore();
await agentStore.setKey('testnet', S.agent, await files.getKey('testnet-agent', S.agent));
const agent = await (await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore: agentStore })).account(S.agent);
const dev = await near.account(S.dev);
// the model key is optional: without it (or if NEAR AI is down) the agent falls back to a plain rule parser
const AI_KEY = (() => { try { return fs.readFileSync(process.env.AI_KEY_FILE || path.join(os.homedir(), '.near-ai-key'), 'utf8').trim(); } catch { return ''; } })();
let brainLive = false; // true once the model has actually answered since the server started

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
// the demo coin has a fixed supply, so say so plainly when the dev has run out instead of a wasm trap
async function needCoins(n, coin = S.coin) {
  const have = BigInt(await view(coin, 'ft_balance_of', { account_id: S.dev }));
  if (have < BigInt(tokens(n))) throw Object.assign(new Error('The playground is out of demo coins for a moment. Try again in a few minutes.'), { status: 503 });
}
const sealedFor = (id, commitment) => ({ commitment, judge_url: JUDGE.url, judge_hash: JUDGE.hash, outlayer: S.outlayer, secrets_owner: S.dev, secrets_profile: 'playground' });
const ticket = () => crypto.randomBytes(18).toString('base64url');
const hashed = (t) => crypto.createHash('sha256').update(String(t || '')).digest('hex');
const sameHash = (a, b) => a && b && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// what each playground plan starts with for its judge and its log: about a dozen judged requests
const PLAN_ATTACH = '0.08', BUDGET_TOPUP = '0.05', BUDGET_LOW = 12_000_000_000_000_000_000_000n;

async function makePlan() {
  return serial(async () => {
    await needCoins(IN_PLAN);
    const id = await view(S.plan, 'next_plan_id', {});
    const r = rulesFor(id);
    const made = await call(dev, S.plan, 'create_plan', {
      token: S.coin, holder: S.agent, beneficiary: S.dev, cap: tokens(PUBLIC_CAP), min_cap: tokens(PUBLIC_CAP / 10), period_secs: '60', start_in_secs: '0', notice_secs: '300', penalty_bps: 2000,
      sealed: sealedFor(id, r.commitment), loosen_allowed: false,
    }, utils.format.parseNearAmount(PLAN_ATTACH));
    const got = JSON.parse(Buffer.from(made.status.SuccessValue, 'base64').toString());
    // someone's wallet got in first, so this plan's rules were committed for the wrong id
    if (got !== id) throw Object.assign(new Error('Someone else made a plan at the same moment. Try again.'), { status: 409 });
    await call(dev, S.coin, 'ft_transfer_call', { receiver_id: S.plan, amount: tokens(IN_PLAN), msg: String(id) }, '1', '150000000000000');
    const t = ticket();
    db.plans[id] = { coin: S.coin, made: Date.now(), revealed: false, ticket: hashed(t) };
    save();
    return { plan: id, coin: S.coin, commitment: r.commitment, cap: PUBLIC_CAP, inPlan: IN_PLAN, ticket: t };
  });
}

// a plan the playground's own agent holds keeps its judge paid for
async function keepFunded(planId, p) {
  if (BigInt(p.budget) < BUDGET_LOW) await call(dev, S.plan, 'fund_judge', { plan_id: planId }, utils.format.parseNearAmount(BUDGET_TOPUP)).catch(() => {});
}

// the dev account pays for visitors, so top it up from NEAR's testnet helper before it runs out
const REFILL_BELOW = BigInt(utils.format.parseNearAmount('5'));
const nearOf = async (id) => BigInt((await (await near.account(id)).getAccountBalance()).available);
async function refill() {
  if (await nearOf(S.dev) >= REFILL_BELOW) return;
  const id = `chokfill${Date.now().toString(36)}.testnet`;
  const kp = KeyPair.fromRandom('ed25519');
  const res = await fetch('https://helper.nearprotocol.com/account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }) });
  if (!res.ok) { console.log(`the testnet helper said ${res.status}; dev is low`); return; }
  const mem = new keyStores.InMemoryKeyStore();
  await mem.setKey('testnet', id, kp);
  await sleep(4000);
  await (await (await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore: mem })).account(id)).deleteAccount(S.dev);
}
setInterval(() => refill().catch((e) => console.log('refill', e.message)), 30 * 60_000);
setTimeout(() => refill().catch((e) => console.log('refill', e.message)), 60_000);

// Bring coins home from playground plans nobody has touched for an hour, by the rules: the agent
// asks for exactly what each plan's sealed rules and public cap allow, the judge clears it and it
// goes to the dev. Runs when the dev is low, so the playground never runs dry.
async function recycle() {
  if (BigInt(await view(S.coin, 'ft_balance_of', { account_id: S.dev })) >= BigInt(tokens(200_000_000))) return;
  const plans = await view(S.plan, 'plans_of', { account: S.agent });
  const now = BigInt(Date.now()) * 1_000_000n;
  for (const [id, p] of plans) {
    const idle = !db.plans[id] || Date.now() - db.plans[id].made > 3_600_000;
    // only the playground's own BUSDOG plans: a launched coin's dev bag moves only when someone asks
    if (p.token !== S.coin || p.holder !== S.agent || p.awaiting || BigInt(p.balance) === 0n || !idle) continue;
    await keepFunded(id, p);
    const r = rulesFor(id);
    const room = now - BigInt(p.period_start) >= BigInt(p.period_ns) ? BigInt(p.cap) : BigInt(p.cap) - BigInt(p.released_in_period);
    const amount = ([BigInt(r.max_per_release), room, BigInt(p.balance)].reduce((a, b) => (a < b ? a : b)) / 1_000_000n) * 1_000_000n;
    if (amount > 0n) await call(agent, S.plan, 'request_release', { plan_id: id, amount: amount.toString() }).catch(() => {});
  }
}
setInterval(() => recycle().catch(() => {}), 10 * 60_000);
setTimeout(() => recycle().catch(() => {}), 30_000);

// agents that visitors hire: the server makes the key pair and keeps the secret half so the agent can
// act for them; the visitor's wallet creates the agent account with that public key as its only key,
// a function-call key for request_release on the plan contract. No full-access key ever exists.
const AGENTS = path.join(DATA, 'agents');
fs.mkdirSync(AGENTS, { recursive: true });
const agentFile = (id) => path.join(AGENTS, `${id}.json`);
async function agentAccount(id) {
  if (id === S.agent) return agent;
  const f = agentFile(id);
  if (!fs.existsSync(f)) throw new Error('not an agent this playground made');
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey('testnet', id, KeyPair.fromString(JSON.parse(fs.readFileSync(f, 'utf8')).secret));
  return (await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore: ks })).account(id);
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

// every ask on a plan, newest first, each with its transaction so anyone can check it on chain
function logIt(planId, r) {
  db.logs ??= {};
  const list = (db.logs[planId] ??= []);
  list.unshift({ at: Date.now(), kind: r.kind, amount: r.amount ?? null, to: r.to ?? null, outcome: r.outcome, reason: r.reason ?? r.error ?? r.why ?? null, tx: r.tx ?? null });
  list.length = Math.min(list.length, 60);
  save();
  return r;
}

async function attempt(planId, coin, x, who = agent) {
  return logIt(planId, await tryIt(planId, coin, x, who));
}

async function tryIt(planId, coin, x, who) {
  const t0 = Date.now();
  try {
    if (x.kind === 'transfer') {
      const out = await call(who, coin, 'ft_transfer', { receiver_id: x.to, amount: tokens(x.amount || 1_000_000) });
      return { ...x, outcome: 'went through', tx: out.transaction.hash };
    }
    if (x.kind === 'loosen') {
      const out = await call(who, S.plan, 'propose_loosen', { plan_id: planId, cap: tokens(x.cap || 1_000_000_000) });
      return { ...x, outcome: 'went through', tx: out.transaction.hash };
    }
    if (!(x.amount >= 1)) return { ...x, outcome: 'not tried', why: 'amount must be at least 1 token' };
    const before = await view(S.plan, 'get_plan', { plan_id: planId });
    const out = await call(who, S.plan, 'request_release', { plan_id: planId, amount: tokens(x.amount) });
    let p = await view(S.plan, 'get_plan', { plan_id: planId });
    for (let i = 0; i < 45 && p.awaiting; i++) { await sleep(1500); p = await view(S.plan, 'get_plan', { plan_id: planId }); }
    const logs = out.receipts_outcome.flatMap((r) => r.outcome.logs).filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice(11)));
    const judged = logs.some((e) => e.event === 'sent_to_judge');
    let reason = logs.find((e) => e.event === 'busted')?.data[0].reason ?? null;
    if (!reason && p.busted > before.busted) reason = 'refused by a sealed rule';
    const outcome = p.releases > before.releases ? 'released' : p.busted > before.busted ? 'busted' : 'no verdict';
    if (outcome === 'busted' && judged) {
      // the verdict's own reason is in the callback receipt; read the final tree for it
      const tx = await near.connection.provider.txStatus(out.transaction.hash, who.accountId, 'FINAL').catch(() => null);
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

const planView = (p) => ({ balance: Number(BigInt(p.balance) / 1_000_000n), publicCapPerPeriod: Number(BigInt(p.cap) / 1_000_000n), periodSecs: Number(BigInt(p.period_ns) / 1_000_000_000n), releasedThisPeriod: Number(BigInt(p.released_in_period) / 1_000_000n), releases: p.releases, busted: p.busted, sealed: !!p.sealed });

// the model if we have one, the rule parser if not; either way every try goes through attempt()
async function ask(planId, coin, text, who) {
  const p = await view(S.plan, 'get_plan', { plan_id: planId });
  if (p.sealed && who === agent) await keepFunded(planId, p);
  let fallback = 'no model key on this server';
  if (AI_KEY) {
    try {
      const results = [];
      const run = await think({
        key: AI_KEY, text,
        readPlan: async () => planView(await view(S.plan, 'get_plan', { plan_id: planId })),
        act: async (x) => { const r = await attempt(planId, coin, x, who); results.push(r); return r; },
      });
      brainLive = true;
      return { mode: 'model', ...run, results };
    } catch (e) {
      brainLive = false;
      fallback = String(e.message || e).slice(0, 160);
    }
  }
  const tries = understand(text, planView(p).balance).slice(0, 5);
  const results = [];
  for (const x of tries) results.push(await attempt(planId, coin, x, who));
  return { mode: 'rules', fallback, understood: tries, results };
}

// Every coin comes from the launcher, which has no keys: one call makes the coin, puts 80% on sale
// and the dev's 20% in its plan. The playground's own coins get a sealed plan its agent holds. A
// visitor's coin is theirs: they get the releases and the 1% fee, and they set the plan's terms.
const LAUNCH_ATTACH_EXTRA = BigInt(utils.format.parseNearAmount('0.06'));
async function launchCost() {
  const cost = BigInt(await view(S.launcher, 'launch_cost', {})) + LAUNCH_ATTACH_EXTRA;
  if (await nearOf(S.dev) < cost + BigInt(utils.format.parseNearAmount('0.2'))) throw Object.assign(new Error('Launching is paused for a moment while the playground tops up its testnet NEAR. A wallet with 2.4 NEAR can launch right now.'), { status: 503 });
  return cost;
}
const coinIdOf = (out) => JSON.parse(Buffer.from(out.status.SuccessValue, 'base64').toString());

async function launchCoin(name, symbol) {
  return serial(async () => {
    const cost = await launchCost();
    const id = await view(S.plan, 'next_plan_id', {});
    const r = rulesFor(id);
    const out = await call(dev, S.launcher, 'launch', { name: name.slice(0, 32), symbol, terms: { holder: S.agent, cap: tokens(20_000_000), min_cap: tokens(2_000_000), period_secs: '60', start_in_secs: '0', notice_secs: '300', penalty_bps: 2000, sealed: sealedFor(id, r.commitment), loosen_allowed: false } }, cost.toString());
    const coin = coinIdOf(out);
    let pool = null;
    for (let i = 0; i < 10 && !pool; i++) { await sleep(1000); pool = await view(S.market, 'get_pool', { token: coin }); }
    if (!pool) throw new Error('The coin was made but did not list.');
    if (pool.plan !== id) throw Object.assign(new Error('Someone else launched at the same moment. Try again.'), { status: 409 });
    const t = ticket();
    db.plans[id] = { coin, made: Date.now(), revealed: false, ticket: hashed(t) };
    save();
    return { plan: id, coin, commitment: r.commitment, cap: 20_000_000, inPlan: 200_000_000, name, symbol: symbol.toUpperCase(), ticket: t };
  });
}

// a visitor without enough testnet NEAR: we pay, and the coin is still all theirs
async function sponsorLaunch(owner, name, symbol, t) {
  const cost = await launchCost();
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.floor(n) : d; };
  const capM = num(t.capMillions, 1, 200, 20), bps = num(t.penaltyBps, 1, 5000, 2000);
  const terms = { holder: acctId(t.holder || owner), cap: tokens(capM * 1e6), min_cap: tokens(Math.max(1, capM / 10) * 1e6), period_secs: '60', start_in_secs: '0', notice_secs: String(num(t.noticeSecs, 30, 86400, 120)), penalty_bps: bps, sealed: null, loosen_allowed: !!t.loosen };
  const out = await call(dev, S.launcher, 'launch', { name: name.slice(0, 32), symbol, terms, dev: owner }, cost.toString());
  return { coin: coinIdOf(out), name, symbol: symbol.toUpperCase(), owner };
}
const acctId = (v) => { const a = String(v || '').trim().toLowerCase(); if (!/^[a-z0-9_.-]{2,64}\.testnet$/.test(a)) throw Object.assign(new Error('a testnet account, like you.testnet'), { status: 400 }); return a; };

// visitors share these limits: plans and coins cost testnet NEAR
const COINS_A_DAY = Number(process.env.COINS_A_DAY || 40);
const seen = new Map();
const allow = (key, n, ms) => { const now = Date.now(), list = (seen.get(key) || []).filter((t) => now - t < ms); if (list.length >= n) return false; list.push(now); seen.set(key, list); return true; };

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' }); res.end(JSON.stringify(body)); };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
  if (req.method === 'GET' && url.pathname === '/near/log') return json(res, 200, (db.logs ?? {})[Number(url.searchParams.get('plan'))] ?? []);
  if (req.method === 'GET' && url.pathname === '/near/info') return json(res, 200, { plan: S.plan, agent: S.agent, dev: S.dev, coin: S.coin, judge: JUDGE, publicCap: PUBLIC_CAP, inPlan: IN_PLAN, market: S.market, launcher: S.launcher, brain: { model: AI_KEY ? MODEL : null, live: brainLive } });
  // the model's attestation with a fresh nonce (it is redone every ten minutes), for the Verified panel
  if (req.method === 'GET' && url.pathname === '/near/attestation') {
    if (!AI_KEY) return json(res, 200, { model: null, checks: [] });
    return void attestation(AI_KEY).then((a) => json(res, 200, { model: a.model, nonce: a.nonce, passed: a.passed, checks: a.checks })).catch((e) => json(res, 502, { error: String(e.message).slice(0, 160) }));
  }
  if (req.method === 'GET' && url.pathname === '/near/health') {
    const lows = { [S.dev]: REFILL_BELOW, [S.agent]: BigInt(utils.format.parseNearAmount('0.5')) };
    return void Promise.all(Object.keys(lows).map(async (a) => [a, await nearOf(a)])).then((list) => json(res, 200, { balances: Object.fromEntries(list.map(([a, b]) => [a, utils.format.formatNearAmount(b.toString(), 3)])), low: list.filter(([a, b]) => b < lows[a]).map(([a]) => a) })).catch((e) => json(res, 500, { error: String(e.message) }));
  }
  if (req.method !== 'POST') return json(res, 404, { error: 'unknown path' });
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 4000) req.destroy(); });
  req.on('end', async () => {
    try {
      const body = JSON.parse(raw || '{}');
      if (url.pathname === '/near/plan') {
        if (!allow(`plan:${ip}`, 4, 3_600_000) || !allow('plan:all', 400, 86_400_000)) return json(res, 429, { error: 'That is enough plans for now. Try again in a while.' });
        return json(res, 200, await makePlan(S.coin));
      }
      if (url.pathname === '/near/coin') {
        const name = String(body.name || '').trim(), symbol = String(body.symbol || '').trim();
        if (!name || !/^[a-z0-9]{2,8}$/i.test(symbol)) return json(res, 400, { error: 'Give it a name and a ticker of 2 to 8 letters or numbers.' });
        if (!allow(`coin:${ip}`, 3, 3_600_000) || !allow('coin:all', COINS_A_DAY, 86_400_000)) return json(res, 429, { error: 'That is enough new coins for today.' });
        return json(res, 200, await launchCoin(name, symbol));
      }
      const acct = acctId;
      if (url.pathname === '/near/faucet') {
        const to = acct(body.account);
        if (!allow(`faucet:${ip}`, 3, 3_600_000) || !allow(`faucet:${to}`, 2, 86_400_000)) return json(res, 429, { error: 'That is enough BUSDOG for now.' });
        await needCoins(50_000_000);
        await call(dev, S.coin, 'storage_deposit', { account_id: to }, utils.format.parseNearAmount('0.0125'));
        const out = await call(dev, S.coin, 'ft_transfer', { receiver_id: to, amount: tokens(50_000_000) }, '1');
        return json(res, 200, { coin: S.coin, amount: 50_000_000, tx: out.transaction.hash });
      }
      if (url.pathname === '/near/agent/new') {
        const owner = acct(body.owner);
        if (!allow(`agent:${ip}`, 6, 3_600_000)) return json(res, 429, { error: 'That is enough agents for now.' });
        const id = `agent${Date.now().toString(36)}.${owner}`;
        const kp = KeyPair.fromRandom('ed25519');
        const t = ticket();
        fs.writeFileSync(agentFile(id), JSON.stringify({ owner, secret: kp.toString(), ticket: hashed(t), at: Date.now() }), { mode: 0o600 });
        return json(res, 200, { agent: id, publicKey: kp.getPublicKey().toString(), contract: S.plan, method: 'request_release', ticket: t });
      }
      if (url.pathname === '/near/my-coin') {
        const owner = acct(body.owner), name = String(body.name || '').trim(), symbol = String(body.symbol || '').trim();
        if (!name || !/^[a-z0-9]{2,8}$/i.test(symbol)) return json(res, 400, { error: 'Give it a name and a ticker of 2 to 8 letters or numbers.' });
        if (!allow(`coin:${ip}`, 3, 3_600_000) || !allow('coin:all', COINS_A_DAY, 86_400_000)) return json(res, 429, { error: 'That is enough new coins for today.' });
        return json(res, 200, await sponsorLaunch(owner, name, symbol, body.terms || {}));
      }
      const planId = Number(body.plan);
      if (url.pathname === '/near/ask' && body.agent) {
        // a visitor's own agent on a visitor's own plan
        if (!allow(`ask:${ip}`, 30, 600_000)) return json(res, 429, { error: 'Slow down a little.' });
        // agent ids are public on chain, so knowing one proves nothing: the ticket from when it was hired does
        const id = String(body.agent);
        const f = agentFile(id);
        if (path.basename(f) !== `${id}.json` || !fs.existsSync(f) || !sameHash(JSON.parse(fs.readFileSync(f, 'utf8')).ticket, hashed(body.ticket))) return json(res, 403, { error: 'Only whoever hired this agent can give it orders.' });
        const who = await agentAccount(id);
        const p = await view(S.plan, 'get_plan', { plan_id: planId });
        if (!p || p.holder !== who.accountId) return json(res, 400, { error: 'That agent does not hold that plan.' });
        return json(res, 200, await ask(planId, p.token, body.text, who));
      }
      const known = db.plans[planId];
      if (!known) return json(res, 404, { error: 'Not a playground plan.' });
      if (!sameHash(known.ticket, hashed(body.ticket))) return json(res, 403, { error: 'This plan belongs to someone else. Get your own.' });
      if (url.pathname === '/near/ask') {
        if (!allow(`ask:${ip}`, 30, 600_000)) return json(res, 429, { error: 'Slow down a little.' });
        return json(res, 200, await ask(planId, known.coin, body.text, agent));
      }
      if (url.pathname === '/near/reveal') {
        const { commitment, ...rules } = rulesFor(planId);
        // the contract checks the rules against the commitment itself and records them
        const p = await view(S.plan, 'get_plan', { plan_id: planId });
        let tx = null;
        if (!p.revealed) {
          const out = await call(dev, S.plan, 'reveal', { plan_id: planId, max_per_release: rules.max_per_release, earliest: String(rules.earliest), min_gap_secs: String(rules.min_gap_secs), salt: rules.salt });
          tx = out.transaction.hash;
        }
        known.revealed = true; save();
        const after = await view(S.plan, 'get_plan', { plan_id: planId });
        return json(res, 200, { plan: planId, rules, commitment, onChain: !!after.revealed, tx });
      }
      json(res, 404, { error: 'unknown path' });
    } catch (e) { json(res, e.status || 500, { error: /unreachable|ExecutionError/.test(String(e.message)) ? 'NEAR refused that one. Try again in a minute.' : String(e.message || e).slice(0, 200) }); }
  });
}).listen(Number(process.env.PORT || 8790));
console.log(`playground on :${process.env.PORT || 8790}, plans on ${S.plan}, agent ${S.agent}, brain ${AI_KEY ? MODEL : 'rule parser'}`);
