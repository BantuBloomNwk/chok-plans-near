// CHOK plans as an MCP server, so your own AI can hold a plan. It speaks MCP over stdio and talks to
// NEAR testnet directly: no server of ours sits in between, and nothing is sent anywhere else.
//
//   node mcp/setup.mjs --account you.testnet      once, to make your agent and its plan
//   claude mcp add chok-plans -e CHOK_AGENT=<agent> -e CHOK_PLAN=<id> -- node mcp/server.mjs
//
// The agent signs with the one key setup made for it, which can only call request_release on the
// plan contract. The server refuses to start with any other kind of key. So whatever your model is
// talked into, the most it can do is ask, and the plan decides. `chok_send_tokens` is here on
// purpose: it really tries to move tokens from the agent's account, and NEAR refuses it.
// stdout carries the protocol, so anything a library prints goes to stderr instead
for (const k of ['log', 'info', 'warn', 'debug']) console[k] = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { connect, keyStores, providers } from 'near-api-js';

const S = JSON.parse(fs.readFileSync(new URL('../deployment.json', import.meta.url)));
const AGENT = process.env.CHOK_AGENT, DEFAULT_PLAN = process.env.CHOK_PLAN != null ? Number(process.env.CHOK_PLAN) : null;
const say = (m) => process.stderr.write(`chok-plans: ${m}\n`); // stdout is the protocol, so logs go to stderr
const rpc = new providers.JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
const view = async (method, args, account = S.plan) => JSON.parse(Buffer.from((await rpc.query({ request_type: 'call_function', finality: 'optimistic', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') })).result).toString());
const M = (raw) => Number(BigInt(raw || 0) / 1_000_000n) / 1e6;
const T = (millions) => (BigInt(Math.round(Number(millions) * 1e6)) * 1_000_000n).toString();

// the agent's key: it must be a function-call key for request_release on the plan contract, and nothing more
let agent = null, keyNote = 'no agent set (CHOK_AGENT); reading only';
if (AGENT) {
  const store = new keyStores.UnencryptedFileSystemKeyStore(process.env.NEAR_CREDENTIALS || path.join(os.homedir(), '.near-credentials'));
  const kp = await store.getKey('testnet', AGENT);
  if (!kp) { say(`no key for ${AGENT} in ~/.near-credentials/testnet`); process.exit(1); }
  const ak = await rpc.query({ request_type: 'view_access_key', finality: 'final', account_id: AGENT, public_key: kp.getPublicKey().toString() });
  const fc = ak.permission?.FunctionCall;
  if (!fc || fc.receiver_id !== S.plan || fc.method_names.join() !== 'request_release') { say(`refusing to run: ${AGENT}'s key must be a function-call key for request_release on ${S.plan} only`); process.exit(1); }
  const near = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore: store });
  agent = await near.account(AGENT);
  keyNote = `${AGENT}, whose only key can call request_release on ${S.plan}`;
}

const planView = async (id) => {
  const p = await view('get_plan', { plan_id: id });
  if (!p) return { error: `no plan #${id}` };
  const log = await view('get_log', { plan_id: id, from: Math.max(0, (p.releases + p.busted + (p.tightenings || 0) + (p.loosenings || 0)) - 8), limit: 8 }).catch(() => []);
  return { plan_id: id, token: p.token, holder: p.holder, beneficiary: p.beneficiary, held_millions: M(p.balance), cap_millions_per_period: M(p.cap), floor_millions: M(p.min_cap), period_secs: Number(p.period_ns) / 1e9, released_this_period_millions: M(p.released_in_period), released_total_millions: M(p.released_total), busted: p.busted, releases: p.releases, sealed: !!p.sealed, loosen_allowed: p.loosen_allowed !== false,
    recent: log.map((e) => ({ kind: e.kind, amount_millions: e.amount ? M(e.amount) : null, reason: e.reason || null, cap_after_millions: e.cap ? M(e.cap) : null, at: new Date(Number(e.at_ms)).toISOString() })) };
};
const outcome = (e) => { const m = String(e?.message || ''); const panic = /panicked at[^,]*,?\s*(.*)|Smart contract panicked: (.*)/.exec(m); return String(panic ? (panic[1] || panic[2]) : e?.type || e?.kind?.ExecutionError || m || e).replace(/\s+/g, ' ').slice(0, 240); };
const explorer = (h) => `https://testnet.nearblocks.io/txns/${h}`;

const TOOLS = [
  { name: 'chok_plan', title: 'Read a plan', description: 'A plan on NEAR testnet as it stands: what it holds, its public cap per period, its floor, how often it was Busted, and its recent log. Read from the chain.',
    inputSchema: { type: 'object', properties: { plan_id: { type: 'integer', minimum: 0 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: 'chok_list_plans', title: 'List plans', description: 'Every plan on the plan contract, a page at a time, with each one\'s cap and how often it was Busted.',
    inputSchema: { type: 'object', properties: { from: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: 'chok_request_release', title: 'Ask the plan for a release', description: 'Asks the plan to release tokens to its beneficiary, signed with the agent\'s one key. Inside the public cap it is released; over it, the plan says Busted, writes it down and tightens the cap. Amounts are in millions of tokens.',
    inputSchema: { type: 'object', properties: { plan_id: { type: 'integer', minimum: 0 }, amount_millions: { type: 'number', exclusiveMinimum: 0 } }, required: ['amount_millions'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  { name: 'chok_send_tokens', title: 'Send tokens from the agent', description: 'Tries to send tokens straight from the agent\'s account to any account. It is here so you can watch it fail: the agent\'s only key can call request_release on the plan contract, so NEAR refuses this before anything runs.',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, amount_millions: { type: 'number', exclusiveMinimum: 0 } }, required: ['to', 'amount_millions'], additionalProperties: false },
    annotations: { readOnlyHint: false, openWorldHint: true } },
];

async function call(name, a) {
  if (name === 'chok_plan') { const id = a.plan_id ?? DEFAULT_PLAN; if (id == null) return { error: 'give plan_id' }; return planView(id); }
  if (name === 'chok_list_plans') {
    const page = await view('list_plans', { from: a.from ?? 0, limit: a.limit ?? 20 });
    return { plans: page.map(([id, p]) => ({ plan_id: id, holder: p.holder, held_millions: M(p.balance), cap_millions_per_period: M(p.cap), busted: p.busted, releases: p.releases })) };
  }
  if (!agent) return { error: 'no agent key: run node mcp/setup.mjs and set CHOK_AGENT' };
  if (name === 'chok_request_release') {
    const id = a.plan_id ?? DEFAULT_PLAN; if (id == null) return { error: 'give plan_id' };
    const before = await view('get_plan', { plan_id: id });
    try {
      const r = await agent.functionCall({ contractId: S.plan, methodName: 'request_release', args: { plan_id: id, amount: T(a.amount_millions) }, gas: 100_000_000_000_000n });
      // the verdict comes from the transaction's own events, which can't lag behind the way a read can
      const ev = r.receipts_outcome.flatMap((o) => o.outcome.logs).filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice(11))).filter((e) => e.standard === 'chok-plans');
      const v = ev.find((e) => ['busted', 'released'].includes(e.event));
      const data = v?.data?.[0] || {};
      return { outcome: v ? v.event.toUpperCase() : 'no verdict yet', asked_millions: a.amount_millions, reason: data.reason || null, cap_before_millions: M(before.cap), cap_after_millions: (data.cap_after ?? data.cap) != null ? M(data.cap_after ?? data.cap) : null, transaction: explorer(r.transaction.hash) };
    } catch (e) { return { outcome: 'REFUSED BY NEAR', error: outcome(e), asked_millions: a.amount_millions }; }
  }
  if (name === 'chok_send_tokens') {
    try {
      const r = await agent.functionCall({ contractId: S.coin, methodName: 'ft_transfer', args: { receiver_id: a.to, amount: T(a.amount_millions) }, gas: 30_000_000_000_000n });
      return { outcome: 'SENT (this should never happen)', transaction: explorer(r.transaction.hash) };
    } catch (e) { return { outcome: 'REFUSED BY NEAR', error: outcome(e), why: `The agent's only key can call request_release on ${S.plan}. It cannot sign anything else, whatever the model was told.` }; }
  }
  return { error: `no tool ${name}` };
}

// MCP over stdio: one JSON-RPC message per line
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
say(`ready; agent: ${keyNote}`);
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'not JSON' } }); }
  if (msg.id === undefined) return; // a notification
  const ok = (result) => send({ jsonrpc: '2.0', id: msg.id, result }), bad = (code, message) => send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  try {
    if (msg.method === 'initialize') return ok({ protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'chok-plans', title: 'CHOK plans on NEAR', version: '1.0.0' } });
    if (msg.method === 'ping') return ok({});
    if (msg.method === 'tools/list') return ok({ tools: TOOLS });
    if (msg.method === 'tools/call') {
      const t = TOOLS.find((x) => x.name === msg.params?.name); if (!t) return bad(-32602, `no tool ${msg.params?.name}`);
      const out = await call(t.name, msg.params.arguments || {});
      return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], structuredContent: out, isError: !!out.error && !out.outcome });
    }
    return bad(-32601, `method ${msg.method} is not offered`);
  } catch (e) { bad(-32000, String(e.message || e).slice(0, 200)); }
});
