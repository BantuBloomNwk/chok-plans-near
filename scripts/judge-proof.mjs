// Proof for a judge's verdict, checked by anyone, trusting neither us nor OutLayer:
//   1. OutLayer's public record for the transaction names the judge the plan pins
//   2. its input hash is the request our plan contract sent, read from the chain
//   3. its output hash is the answer the judge gave, read from the chain, and the verdict on chain says the same
//   4. Intel's signature on the TDX quote checks out
//   5. the quote's commitment is these exact fields (OutLayer's own preimage, ported from outlayer-verify)
//   6. the machine's measurements are a build OutLayer's register contract approves
// What it doesn't prove: that the plan contract checked any of this. It trusts the answer that came back
// through outlayer.testnet; this is the check anyone can make afterwards.
import crypto from 'crypto';
import { getCollateralAndVerify } from '@phala/dcap-qvl';

const API = 'https://testnet-api.outlayer.ai/attestations/by-tx';
const ARCHIVE = 'https://archival-rpc.testnet.fastnear.com';
const REGISTER = 'worker.outlayer.testnet';
const V1_CUTOFF = 1_769_784_939;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
const le64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const leu64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

/** The 32 bytes a worker commits to inside the quote's report_data. */
export function taskHash(a) {
  const h = crypto.createHash('sha256');
  h.update(a.task_type); h.update(le64(a.task_id));
  for (const f of [a.repo_url, a.commit_hash, a.build_target, a.wasm_hash, a.input_hash]) if (f != null) h.update(f);
  h.update(a.output_hash);
  if (a.block_height != null) h.update(leu64(a.block_height));
  if (a.timestamp >= V1_CUTOFF) {
    for (const f of [a.caller_account_id, a.project_id, a.secrets_ref]) if (f != null) h.update(f);
    h.update(le64(a.timestamp));
    if (a.attached_usd != null) h.update(String(a.attached_usd));
  }
  return h.digest('hex');
}

const rpc = async (method, params) => {
  for (let i = 0; i < 3; i++) {
    const j = await (await fetch(ARCHIVE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json().catch(() => ({}));
    if (j.result) return j.result;
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
};

/** Checks one judged transaction. Returns a list of { name, pass, detail }. */
export async function proveVerdict(txHash, { pinned }) {
  const out = [], add = (name, pass, detail = '') => out.push({ name, pass: !!pass, detail });
  const res = await fetch(`${API}/${txHash}`);
  if (!res.ok) { add('OutLayer has a public record for it', false, `HTTP ${res.status}`); return out; }
  const a = await res.json();
  add('the judge that ran is the one the plan pins', a.wasm_hash === pinned && a.executed_wasm_sha256 === pinned, a.wasm_hash?.slice(0, 16));

  const st = await rpc('EXPERIMENTAL_tx_status', [txHash, a.caller_account_id]);
  if (!st) { add('the transaction can be read from an archive', false, 'RPC did not answer'); return out; }
  const calls = st.receipts.flatMap((rc) => (rc.receipt?.Action?.actions ?? []).map((x) => x.FunctionCall).filter(Boolean));
  const req = calls.find((f) => f.method_name === 'request_execution');
  const input = req && JSON.parse(Buffer.from(req.args, 'base64').toString()).input_data;
  add('it judged exactly the request the plan contract sent', input != null && sha(input) === a.input_hash, input ? input.slice(0, 80) : 'no request found');

  let answer = null;
  for (const o of st.receipts_outcome) {
    const sv = o.outcome.status?.SuccessValue;
    if (!sv) continue;
    const txt = Buffer.from(sv, 'base64').toString();
    try { const j = JSON.parse(txt); if (j && typeof j === 'object' && 'cleared' in j && sha(JSON.stringify(sorted(j))) === a.output_hash) answer = j; } catch { /* not the answer */ }
  }
  add('its answer is the one recorded, and the verdict on chain says the same', answer && (() => {
    const events = st.receipts_outcome.flatMap((o) => o.outcome.logs).filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice(11)).event);
    return answer.cleared ? events.includes('released') : events.includes('busted');
  })(), answer ? JSON.stringify(answer).slice(0, 90) : 'no matching answer on chain');

  const quote = Buffer.from(a.tdx_quote, 'base64');
  let verified = null;
  try {
    verified = await getCollateralAndVerify(quote);
    add('Intel signed the quote', ['UpToDate', 'SWHardeningNeeded', 'ConfigurationAndSWHardeningNeeded'].includes(verified.status), verified.status);
  } catch (e) { add('Intel signed the quote', false, String(e.message).slice(0, 100)); }
  add('the quote commits to exactly these fields', quote.subarray(568, 600).toString('hex') === taskHash(a), `task ${a.task_id}`);

  // a TDX v4 quote: 48-byte header, then MRTD and the four RTMRs inside the TD report
  const m = (at) => quote.subarray(at, at + 48).toString('hex');
  const measurements = { mrtd: m(184), rtmr0: m(376), rtmr1: m(424), rtmr2: m(472), rtmr3: m(520) };
  const view = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: REGISTER, method_name: 'is_measurements_approved', args_base64: Buffer.from(JSON.stringify({ measurements })).toString('base64') });
  const approved = view ? JSON.parse(Buffer.from(view.result).toString()) : null;
  add('the machine is a build OutLayer approves', approved === true, approved === null ? 'register contract did not answer' : String(approved));
  return out.map((c) => ({ ...c, link: `https://app.outlayer.ai/attestation/${a.id}` }));
}
