// "Be the dev": connect a NEAR testnet wallet and do it yourself. Your wallet signs every step,
// so the plan, the Busted stamps and the agent's one key are all yours on chain. The page reads
// its state back from the chain each time (some wallets leave the page and come back), never
// from what a wallet returns.

import './polyfill.js';
import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupModal } from '@near-wallet-selector/modal-ui';
import '@near-wallet-selector/modal-ui/styles.css';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { setupHereWallet } from '@near-wallet-selector/here-wallet';
import { setupIntearWallet } from '@near-wallet-selector/intear-wallet';
import { actionCreators } from '@near-js/transactions';
import { PublicKey } from '@near-js/crypto';
import S from '../../deployment.json';
import { makeRules, commitmentOf, storeSecretArgs, newProfile } from './seal.js';

const API = 'https://near-play.161-97-74-212.sslip.io';
const RPC = 'https://test.rpc.fastnear.com';
const { plan: PLAN, coin: BUSDOG, launcher: LAUNCHER } = S;
const TGAS = (n) => BigInt(n) * 10n ** 12n;
const NEAR = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
const tokens = (n) => (BigInt(Math.round(n)) * 1_000_000n).toString();
const M = (raw) => { const n = Number(BigInt(raw) / 1000000n) / 1e6; return n >= 1 ? `${+n.toFixed(2)}M` : Math.round(n * 1e6).toLocaleString(); };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const explorer = (kind, id) => `https://testnet.nearblocks.io/${kind}/${id}`;
const keep = { get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.cause?.name || j.error.message);
  return j.result;
}
async function view(contract, method, args) {
  const res = await rpc('query', { request_type: 'call_function', finality: 'optimistic', account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result)));
}
const keysOf = (account) => rpc('query', { request_type: 'view_access_key_list', finality: 'optimistic', account_id: account }).then((r) => r.keys).catch(() => null);
async function post(path, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: 'The playground did not answer.' }));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

let selector, modal, me = null;
const fc = (methodName, args, gas = 100, deposit = 0n) => actionCreators.functionCall(methodName, args, TGAS(gas), deposit);

async function send(transactions, label, say = status) {
  const wallet = await selector.wallet();
  say(`${label}: approve it in your wallet…`);
  try {
    // browser wallets leave the page and come back; injected ones answer here
    await wallet.signAndSendTransactions({ transactions: transactions.map((t) => ({ signerId: me, ...t })) });
    say(`${label}: done.`);
  } catch (e) { say(`${label}: ${e.message || e}`, true); throw e; }
  await new Promise((r) => setTimeout(r, 2500));
  await render();
}

// the market section uses the same wallet
window.cpn = {
  get me() { return me; },
  connect: () => modal.show(),
  send: (txs, label, say) => send(txs, label, say),
  fc, NEAR,
};
function status(text, bad = false) { const el = $('dev-status'); el.textContent = text; el.className = bad ? 'err' : 'muted'; }

// everything about this account, read from the chain
async function state() {
  const plans = await view(PLAN, 'plans_of', { account: me });
  // the coins you launched are the tokens of your plans, on the chain, not this browser's memory
  const coins = [...new Set([BUSDOG, ...plans.map(([, p]) => p.token)])];
  const balances = await Promise.all(coins.map((c) => view(c, 'ft_balance_of', { account_id: me }).catch(() => '0')));
  const agents = (keep.get(`cpn.agents.${me}`) || []).map((a) => (typeof a === 'string' ? { agent: a } : a));
  return { plans, coins: coins.map((c, i) => ({ coin: c, balance: balances[i] })), agents };
}

// what this browser knows about a sealed plan's rules, and what's left to do with them
function sealedBlock(id, p) {
  if (!p.sealed) return '';
  const mine = sealedStore()[p.sealed.commitment];
  if (p.revealed) return `<p class="small"><b>Sealed, now revealed:</b> at most ${M(p.revealed.max_per_release)} a release, ${p.revealed.min_gap_secs}s apart. The contract checked them against the commitment.</p>`;
  if (!mine) return `<p class="muted small"><b>Sealed.</b> The rules aren't in this browser. Commitment <span class="mono">${esc(p.sealed.commitment.slice(0, 16))}…</span></p>`;
  const rules = `at most ${M(mine.rules.max_per_release)} a release, ${mine.rules.min_gap_secs}s apart`;
  if (!mine.stored) return `<p class="small"><b>One more step.</b> Your wallet stores your rules (${rules}), encrypted here for OutLayer's enclave. Until then every ask fails safely.</p><button class="btn d-seal">Seal the rules</button>`;
  return `<p class="small"><b>Sealed by you:</b> ${rules}. Only this browser and the enclave know that. Lose them and you can't reveal, though the plan keeps working.</p><div class="dev-actions"><button class="btn ghost d-save">Save my rules</button><button class="btn ghost d-reveal">Reveal them on chain</button></div>`;
}

function planRow([id, p], agents) {
  const byAgent = p.holder !== me;
  const opensIn = Math.max(0, Math.round((Number(p.not_before) - Date.now() * 1e6) / 1e9));
  return `<div class="card dev-plan" data-plan="${id}">
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><h3>Plan #${id}</h3><span class="tag ${byAgent ? 'p' : 'y'}">${byAgent ? 'held by your agent' : 'held by you'}</span></div>
    <p class="muted small">${esc(p.token)} · holder <span class="mono">${esc(p.holder)}</span></p>
    <div class="stats">
      <div class="stat"><b>${M(p.cap)}</b><span>Cap a period</span></div>
      <div class="stat"><b>${M(p.balance)}</b><span>In the plan</span></div>
      <div class="stat good"><b>${p.releases}</b><span>Released</span></div>
      <div class="stat bad"><b>${p.busted}</b><span>Busted</span></div>
    </div>
    <p class="muted small">The cap stops at ${M(p.min_cap)}, however often it's Busted. Budget for its log and judge: ${(Number(BigInt(p.budget) / 10n ** 21n) / 1000).toFixed(3)} NEAR.${p.log_skipped ? ` <b>${p.log_skipped} event(s) aren't in its log because the budget ran out.</b>` : ''} <button class="btn ghost d-topup">Top up</button></p>
    ${sealedBlock(id, p)}
    ${opensIn ? `<p class="muted small">Nothing can leave for another ${opensIn}s.</p>` : ''}
    ${p.pending_holder ? `<p class="small"><b>New holder pending:</b> <span class="mono">${esc(p.pending_holder.holder)}</span> at ${new Date(Number(p.pending_holder.effective_at) / 1e6).toLocaleTimeString()}.</p>` : ''}
    ${p.pending ? `<p class="small"><b>Loosening pending:</b> cap to ${M(p.pending.cap)} at ${new Date(Number(p.pending.effective_at) / 1e6).toLocaleTimeString()}. Everyone can see it.</p>` : ''}
    <div class="dev-actions">
      <label>Put tokens in<input class="d-in" inputmode="numeric" placeholder="tokens, e.g. 20000000"></label><button class="btn ghost d-deposit">Deposit</button>
      ${byAgent ? `<button class="btn d-agent">Command your agent</button>` : `<label>Release<input class="d-amt" inputmode="numeric" placeholder="tokens, e.g. 50000000"></label><button class="btn d-release">Ask to release</button>`}
      ${p.beneficiary === me ? (p.pending_holder ? (Date.now() * 1e6 >= Number(p.pending_holder.effective_at) ? '<button class="btn ghost d-holder-apply">Make the new holder official</button>' : '<button class="btn ghost d-holder-cancel">Cancel the new holder</button>') : '<button class="btn ghost d-holder">Replace the holder</button>') : ''}
      ${!p.loosen_allowed ? '<p class="muted small" style="grid-column:1/-1">Launched to never loosen: no one can ever raise this cap.</p>' : p.pending ? `<button class="btn ghost d-cancel">Cancel the loosening</button>` : `<button class="btn ghost d-loosen">Propose a looser cap</button>`}
    </div>
  </div>`;
}

async function render() {
  $('dev-connect').textContent = me ? `${me} · disconnect` : 'Connect a NEAR testnet wallet';
  $('dev-steps').hidden = !me;
  if (!me) return;
  try {
    const s = await state();
    $('dev-balances').innerHTML = s.coins.map((c) => `<div class="chk"><span class="tick ${BigInt(c.balance) > 0n ? 'ok' : ''}">$</span><div><b>${M(c.balance)}</b> <span class="mono">${esc(c.coin)}</span>${c.coin === BUSDOG ? '' : ` <a href="#trade" class="small d-open" data-coin="${esc(c.coin)}">open it in the market</a>`}</div></div>`).join('');
    // anyone can make a plan and then hand it to you as holder, so those wait under their own heading
    const mine = s.plans.filter(([, p]) => p.beneficiary === me).sort((a, b) => b[0] - a[0]);
    const naming = s.plans.filter(([, p]) => p.beneficiary !== me).sort((a, b) => b[0] - a[0]);
    $('dev-plans').innerHTML = (mine.length ? mine.map((x) => planRow(x, s.agents)).join('') : '<p class="muted">No plans yet. Make one above.</p>')
      + (naming.length ? `<details style="grid-column:1/-1"><summary class="muted">${naming.length} plan(s) someone else made that name you as holder</summary>${naming.map((x) => planRow(x, s.agents)).join('')}</details>` : '');
    // the agents you hired: show their keys straight from the chain
    const rows = await Promise.all(s.agents.map(async ({ agent: a }) => {
      const keys = await keysOf(a);
      const desc = keys ? keys.map((k) => (k.access_key.permission === 'FullAccess' ? 'FULL ACCESS' : `${k.access_key.permission.FunctionCall.method_names.join(', ')} on ${k.access_key.permission.FunctionCall.receiver_id}`)).join('; ') : 'not created yet';
      return `<div class="chk"><span class="tick ${keys && keys.every((k) => k.access_key.permission !== 'FullAccess') ? 'ok' : ''}">✓</span><div><a class="mono" href="${explorer('address', a)}" target="_blank" rel="noreferrer">${esc(a)}</a><div class="muted small">${keys ? keys.length : 0} key(s): ${esc(desc)}</div></div></div>`;
    }));
    $('dev-agents').innerHTML = rows.join('') || '<p class="muted small">No agent yet.</p>';
  } catch (e) { status(e.message, true); }
}

// the holder: you, or a fresh account under yours whose only key can call request_release on the
// plan contract. Our server makes that key so the agent can act for you, and only you get the ticket
// that lets anyone give it orders.
async function hireIfAsked() {
  const mode = document.querySelector('input[name="dev-holder"]:checked').value;
  if (mode !== 'agent') return { holder: me, txs: [] };
  const a = await post('/near/agent/new', { owner: me });
  keep.set(`cpn.agents.${me}`, [...(keep.get(`cpn.agents.${me}`) || []).map((x) => (typeof x === 'string' ? { agent: x } : x)), { agent: a.agent, ticket: a.ticket }]);
  return { holder: a.agent, txs: [{ receiverId: a.agent, actions: [
    actionCreators.createAccount(),
    actionCreators.transfer(NEAR(0.5)),
    actionCreators.addKey(PublicKey.fromString(a.publicKey), actionCreators.functionCallAccessKey(a.contract, [a.method], NEAR(0.45))),
  ] }] };
}
// Sealed rules made in this browser. They stay here (and in the file you can save), and go out only
// encrypted for OutLayer's enclave. Nothing about them reaches our server.
const sealedStore = () => keep.get(`cpn.sealed.${me}`) || {};
const keepSealed = (commitment, entry) => keep.set(`cpn.sealed.${me}`, { ...sealedStore(), [commitment]: { ...sealedStore()[commitment], ...entry } });
function newSealed() {
  if (!$('dev-seal').checked) return null;
  const max = Number($('dev-seal-max').value), gap = Number($('dev-seal-gap').value);
  if (!(max > 0)) throw new Error('How much can leave in one release, in millions?');
  if (!(gap >= 0)) throw new Error('How many seconds apart?');
  const rules = makeRules({ maxPerRelease: (BigInt(Math.round(max * 1e6)) * 1_000_000n).toString(), minGapSecs: Math.round(gap) });
  const commitment = commitmentOf(rules), profile = newProfile(), judgeHash = S.judges[0];
  keepSealed(commitment, { rules, profile, stored: false });
  return { commitment, judge_url: `https://chok-plans-near.netlify.app/judge/${judgeHash}.wasm`, judge_hash: judgeHash, outlayer: S.outlayer, secrets_owner: me, secrets_profile: profile };
}

// the launcher's limits, said here first so a launch isn't refused after a wallet prompt
const termsFromForm = () => {
  const f = { cap: Number($('dev-cap').value || 20), penalty: Number($('dev-penalty').value || 20), notice: Number($('dev-notice').value || 120), loosen: $('dev-loosen').checked };
  if (!(f.cap > 0 && f.cap <= 20)) throw new Error('The cap can be at most 20 million a minute: a tenth of your 200M share.');
  if (!(f.penalty >= 1 && f.penalty <= 50)) throw new Error('Each Busted has to cut the cap by 1% to 50%.');
  if (!(f.notice >= 60)) throw new Error('The public notice has to be at least 60 seconds.');
  return f;
};

// NEP-413: the wallet signs without a transaction, which is how we know the launch we pay for is yours
async function signLaunch(name, symbol, terms) {
  // the message names everything being launched, so what your wallet shows is what happens
  const bytes = new TextEncoder().encode(JSON.stringify([name, symbol.toUpperCase(), Number(terms.capMillions), Number(terms.penaltyBps), Number(terms.noticeSecs), !!terms.loosen, terms.holder || '']));
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 16);
  const message = `Launch ${symbol.toUpperCase()} ${digest} as ${me} | ${Date.now()}`;
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const callbackUrl = undefined;
  const wallet = await selector.wallet();
  let signed;
  try { signed = await wallet.signMessage({ message, recipient: LAUNCHER, nonce: Buffer.from(nonce) }); }
  catch (e) { throw new Error(`Your wallet wouldn't sign the message (${e.message || e}). You can claim testnet NEAR at https://docs.near.org/getting-started/faucet and launch from your own wallet.`); }
  if (!signed?.signature) throw new Error('Your wallet did not return a signature. You can claim testnet NEAR at https://docs.near.org/getting-started/faucet and launch from your own wallet.');
  return { publicKey: signed.publicKey, signature: signed.signature, message, nonce: Buffer.from(nonce).toString('base64'), recipient: LAUNCHER, callbackUrl: signed.callbackUrl ?? callbackUrl };
}

// one call: the coin, 80% on sale, 20% in your plan. Your wallet signs and pays if it can.
async function launch() {
  const name = $('dev-cname').value.trim(), symbol = $('dev-csym').value.trim();
  if (!name || !/^[a-z0-9]{2,8}$/i.test(symbol)) return status('Give it a name and a ticker of 2 to 8 letters or numbers.', true);
  if (new TextEncoder().encode(name).length > 32) return status('That name is too long: 32 bytes at most, and some letters take two or three.', true);
  const f = termsFromForm();
  const sealed = newSealed();
  const { holder, txs } = await hireIfAsked();
  // a sealed launch pays for some judged requests up front
  const cost = BigInt(await view(LAUNCHER, 'launch_cost', {})) + (sealed ? NEAR(0.1) : 0n);
  const account = await rpc('query', { request_type: 'view_account', finality: 'optimistic', account_id: me });
  if (BigInt(account.amount) > cost + (txs.length ? NEAR(0.6) : NEAR(0.1))) {
    const capRaw = BigInt(Math.round(f.cap * 1e6)) * 1_000_000n;
    const terms = { holder, cap: capRaw.toString(), min_cap: (capRaw / 10n).toString(), period_secs: '60', start_in_secs: '0', notice_secs: String(f.notice), penalty_bps: Math.round(f.penalty * 100), sealed, loosen_allowed: f.loosen };
    await send([...txs, { receiverId: LAUNCHER, actions: [fc('launch', { name, symbol, terms }, 280, cost)] }], `Launching $${symbol.toUpperCase()}`);
  } else {
    if (sealed) throw new Error(`A sealed launch has to come from your own wallet, and it needs ${(Number(cost / 10n ** 21n) / 1000).toFixed(2)} NEAR. Testnet NEAR: https://docs.near.org/getting-started/faucet`);
    if (txs.length) await send(txs, 'Hiring your agent');
    status(`Your wallet is short of the ${(Number(cost / 10n ** 21n) / 1000).toFixed(2)} NEAR a launch costs. We'll pay if your wallet signs a message saying this launch is yours: it costs nothing.`);
    const terms = { capMillions: f.cap, penaltyBps: Math.round(f.penalty * 100), noticeSecs: f.notice, loosen: f.loosen, holder };
    const proof = await signLaunch(name, symbol, terms);
    status('Signed. Launching, about half a minute…');
    await post('/near/my-coin', { owner: me, name, symbol, proof, terms });
    status(`$${symbol.toUpperCase()} is live. 80% is on sale and your 20% is in its plan.`);
  }
  await new Promise((r) => setTimeout(r, 2500));
  await render();
  window.cpnMarketRefresh?.();
}

// a plan for tokens you already hold: the demo coin
async function makePlan() {
  const f = termsFromForm();
  const sealed = newSealed();
  const { holder, txs } = await hireIfAsked();
  const capRaw = BigInt(Math.round(f.cap * 1e6)) * 1_000_000n;
  txs.push({ receiverId: PLAN, actions: [fc('create_plan', { token: BUSDOG, holder, beneficiary: me, cap: capRaw.toString(), min_cap: (capRaw / 10n).toString(), period_secs: '60', start_in_secs: '0', notice_secs: String(f.notice), penalty_bps: Math.round(f.penalty * 100), sealed, loosen_allowed: f.loosen }, 100, NEAR(sealed ? 0.1 : 0.05))] });
  await send(txs, holder !== me ? 'Hiring your agent and making the plan' : 'Making your plan');
}

async function onPlanClick(e) {
  const card = e.target.closest('.dev-plan'); if (!card) return;
  const id = Number(card.dataset.plan);
  const p = await view(PLAN, 'get_plan', { plan_id: id });
  if (e.target.classList.contains('d-deposit')) {
    const n = Number(card.querySelector('.d-in').value); if (!(n > 0)) return status('How many tokens?', true);
    await send([{ receiverId: p.token, actions: [fc('ft_transfer_call', { receiver_id: PLAN, amount: tokens(n), msg: String(id) }, 150, 1n)] }], 'Putting tokens in');
  }
  if (e.target.classList.contains('d-release')) {
    const n = Number(card.querySelector('.d-amt').value); if (!(n > 0)) return status('How many tokens?', true);
    await send([{ receiverId: PLAN, actions: [fc('request_release', { plan_id: id, amount: tokens(n) }, p.sealed ? 280 : 100)] }], 'Asking to release');
  }
  if (e.target.classList.contains('d-loosen')) {
    const n = Number(prompt('New cap a period, in millions (it must be bigger than now):', String(Number(BigInt(p.cap) / 10n ** 12n) * 2)));
    if (n > 0) await send([{ receiverId: PLAN, actions: [fc('propose_loosen', { plan_id: id, cap: tokens(n * 1e6) }, 50)] }], 'Proposing a looser cap');
  }
  if (e.target.classList.contains('d-cancel')) await send([{ receiverId: PLAN, actions: [fc('cancel_loosen', { plan_id: id }, 50)] }], 'Cancelling the loosening');
  if (e.target.classList.contains('d-agent')) window.cpnUseAgent?.({ plan: id, agent: p.holder, coin: p.token, ticket: (keep.get(`cpn.agents.${me}`) || []).find((a) => a.agent === p.holder)?.ticket });
  const secret = p.sealed && sealedStore()[p.sealed.commitment];
  if (e.target.classList.contains('d-seal') && secret) {
    status('Encrypting your rules here…');
    const args = await storeSecretArgs({ rules: secret.rules, planId: id, judgeHash: p.sealed.judge_hash, planContract: PLAN, owner: me, profile: p.sealed.secrets_profile, api: '/outlayer' });
    await send([{ receiverId: S.outlayer, actions: [fc('store_secrets', args, 100, NEAR(0.1))] }], 'Storing your sealed rules');
    keepSealed(p.sealed.commitment, { stored: true });
    await render();
  }
  if (e.target.classList.contains('d-save') && secret) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ plan: id, contract: PLAN, commitment: p.sealed.commitment, ...secret }, null, 2)], { type: 'application/json' }));
    a.download = `chok-sealed-plan-${id}.json`;
    a.click();
  }
  if (e.target.classList.contains('d-reveal') && secret) {
    const r = secret.rules;
    await send([{ receiverId: PLAN, actions: [fc('reveal', { plan_id: id, max_per_release: r.max_per_release, earliest: String(r.earliest), min_gap_secs: String(r.min_gap_secs), salt: r.salt }, 100)] }], 'Revealing your rules');
  }
  if (e.target.classList.contains('d-topup')) await send([{ receiverId: PLAN, actions: [fc('fund_judge', { plan_id: id }, 30, NEAR(0.05))] }], 'Topping up the plan');
  if (e.target.classList.contains('d-holder')) {
    const who = (prompt('Which account should hold this plan? It takes over after the public notice, and you can cancel until then.') || '').trim();
    if (who) await send([{ receiverId: PLAN, actions: [fc('propose_holder', { plan_id: id, holder: who }, 50, NEAR(0.002))] }], 'Proposing a new holder');
  }
  if (e.target.classList.contains('d-holder-cancel')) await send([{ receiverId: PLAN, actions: [fc('cancel_holder', { plan_id: id }, 50)] }], 'Cancelling the new holder');
  if (e.target.classList.contains('d-holder-apply')) await send([{ receiverId: PLAN, actions: [fc('apply_holder', { plan_id: id }, 50)] }], 'Making the new holder official');
}

async function main() {
  selector = await setupWalletSelector({ network: 'testnet', modules: [setupMeteorWallet(), setupHereWallet(), setupIntearWallet()] });
  modal = setupModal(selector, { contractId: PLAN });
  const sync = () => { me = selector.store.getState().accounts[0]?.accountId ?? null; render(); window.dispatchEvent(new Event('cpn-wallet')); };
  selector.store.observable.subscribe(sync);
  sync();
  $('dev-connect').onclick = async () => { if (me) { await (await selector.wallet()).signOut(); me = null; render(); } else modal.show(); };
  $('dev-faucet').onclick = async () => { status('Sending you 25M BUSDOG…'); try { await post('/near/faucet', { account: me }); status('25M BUSDOG sent.'); render(); } catch (e) { status(e.message, true); } };
  $('dev-mycoin').onclick = () => launch().catch((e) => status(e.message, true));
  $('dev-make').onclick = () => makePlan().catch((e) => status(e.message, true));
  $('dev-balances').onclick = (e) => { const b = e.target.closest('.d-open'); if (b) window.cpnMarketOpen?.(b.dataset.coin); };
  $('dev-plans').onclick = (e) => onPlanClick(e).catch((err) => status(err.message, true));
  setInterval(() => me && render(), 8000);
}
main();
