// "Be the dev": connect a NEAR testnet wallet and do it yourself. Your wallet signs every step,
// so the plan, the Busted stamps and the agent's one key are all yours on chain. The page reads
// its state back from the chain each time (some wallets leave the page and come back), never
// from what a wallet returns.

import './polyfill.js';
import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupModal } from '@near-wallet-selector/modal-ui';
import '@near-wallet-selector/modal-ui/styles.css';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { setupHereWallet } from '@near-wallet-selector/here-wallet';
import { setupIntearWallet } from '@near-wallet-selector/intear-wallet';
import { actionCreators } from '@near-js/transactions';
import { PublicKey } from '@near-js/crypto';

const API = 'https://near-play.161-97-74-212.sslip.io';
const RPC = 'https://test.rpc.fastnear.com';
const PLAN = 'locked.chokplans-mvxhykzp.testnet';
const BUSDOG = 'coin.chokplans-mvxhykzp.testnet';
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

async function send(transactions, label) {
  const wallet = await selector.wallet();
  status(`${label}: approve it in your wallet…`);
  try {
    // browser wallets leave the page and come back; injected ones answer here
    await wallet.signAndSendTransactions({ transactions: transactions.map((t) => ({ signerId: me, ...t })) });
    status(`${label}: done.`);
  } catch (e) { status(`${label}: ${e.message || e}`, true); throw e; }
  await new Promise((r) => setTimeout(r, 2500));
  await render();
}
function status(text, bad = false) { const el = $('dev-status'); el.textContent = text; el.className = bad ? 'err' : 'muted'; }

// everything about this account, read from the chain
async function state() {
  const plans = (await view(PLAN, 'list_plans', { from: 0, limit: 500 })).filter(([, p]) => p.beneficiary === me || p.holder === me);
  const coins = [BUSDOG, ...(keep.get('cpn.mycoins') || [])];
  const balances = await Promise.all(coins.map((c) => view(c, 'ft_balance_of', { account_id: me }).catch(() => '0')));
  const agents = keep.get(`cpn.agents.${me}`) || [];
  return { plans, coins: coins.map((c, i) => ({ coin: c, balance: balances[i] })), agents };
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
    ${opensIn ? `<p class="muted small">Nothing can leave for another ${opensIn}s.</p>` : ''}
    ${p.pending ? `<p class="small"><b>Loosening pending:</b> cap to ${M(p.pending.cap)} at ${new Date(Number(p.pending.effective_at) / 1e6).toLocaleTimeString()}. Everyone can see it.</p>` : ''}
    <div class="dev-actions">
      <label>Put tokens in<input class="d-in" inputmode="numeric" placeholder="tokens, e.g. 20000000"></label><button class="btn ghost d-deposit">Deposit</button>
      ${byAgent ? `<button class="btn d-agent">Command your agent</button>` : `<label>Release<input class="d-amt" inputmode="numeric" placeholder="tokens, e.g. 50000000"></label><button class="btn d-release">Ask to release</button>`}
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
    $('dev-balances').innerHTML = s.coins.map((c) => `<div class="chk"><span class="tick ${BigInt(c.balance) > 0n ? 'ok' : ''}">$</span><div><b>${M(c.balance)}</b> <span class="mono">${esc(c.coin)}</span></div></div>`).join('');
    $('dev-token').innerHTML = s.coins.map((c) => `<option value="${esc(c.coin)}">${esc(c.coin)}</option>`).join('');
    $('dev-plans').innerHTML = s.plans.length ? s.plans.sort((a, b) => b[0] - a[0]).map((x) => planRow(x, s.agents)).join('') : '<p class="muted">No plans yet. Make one above.</p>';
    // the agents you hired: show their keys straight from the chain
    const rows = await Promise.all(s.agents.map(async (a) => {
      const keys = await keysOf(a);
      const desc = keys ? keys.map((k) => (k.access_key.permission === 'FullAccess' ? 'FULL ACCESS' : `${k.access_key.permission.FunctionCall.method_names.join(', ')} on ${k.access_key.permission.FunctionCall.receiver_id}`)).join('; ') : 'not created yet';
      return `<div class="chk"><span class="tick ${keys && keys.every((k) => k.access_key.permission !== 'FullAccess') ? 'ok' : ''}">✓</span><div><a class="mono" href="${explorer('address', a)}" target="_blank" rel="noreferrer">${esc(a)}</a><div class="muted small">${keys ? keys.length : 0} key(s): ${esc(desc)}</div></div></div>`;
    }));
    $('dev-agents').innerHTML = rows.join('') || '<p class="muted small">No agent yet.</p>';
  } catch (e) { status(e.message, true); }
}

async function makePlan() {
  const token = $('dev-token').value, cap = Number($('dev-cap').value || 10), penalty = Number($('dev-penalty').value || 20), notice = Number($('dev-notice').value || 120);
  const holderMode = document.querySelector('input[name="dev-holder"]:checked').value;
  const txs = [];
  let holder = me;
  if (holderMode === 'agent') {
    // a fresh account under yours whose only key can call request_release on the plan contract
    const a = await post('/near/agent/new', { owner: me });
    holder = a.agent;
    txs.push({ receiverId: a.agent, actions: [
      actionCreators.createAccount(),
      actionCreators.transfer(NEAR(0.5)),
      actionCreators.addKey(PublicKey.fromString(a.publicKey), actionCreators.functionCallAccessKey(a.contract, [a.method], NEAR(0.45))),
    ] });
    keep.set(`cpn.agents.${me}`, [...(keep.get(`cpn.agents.${me}`) || []), a.agent]);
  }
  txs.push({ receiverId: PLAN, actions: [fc('create_plan', { token, holder, beneficiary: me, cap: tokens(cap * 1e6), period_secs: '60', start_in_secs: '0', notice_secs: String(notice), penalty_bps: Math.round(penalty * 100), sealed: null, loosen_allowed: $('dev-loosen').checked }, 100, NEAR(0.05))] });
  await send(txs, holderMode === 'agent' ? 'Hiring your agent and making the plan' : 'Making your plan');
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
    await send([{ receiverId: PLAN, actions: [fc('request_release', { plan_id: id, amount: tokens(n) }, 100)] }], 'Asking to release');
  }
  if (e.target.classList.contains('d-loosen')) {
    const n = Number(prompt('New cap a period, in millions (it must be bigger than now):', String(Number(BigInt(p.cap) / 10n ** 12n) * 2)));
    if (n > 0) await send([{ receiverId: PLAN, actions: [fc('propose_loosen', { plan_id: id, cap: tokens(n * 1e6) }, 50)] }], 'Proposing a looser cap');
  }
  if (e.target.classList.contains('d-cancel')) await send([{ receiverId: PLAN, actions: [fc('cancel_loosen', { plan_id: id }, 50)] }], 'Cancelling the loosening');
  if (e.target.classList.contains('d-agent')) window.cpnUseAgent?.({ plan: id, agent: p.holder, coin: p.token });
}

async function main() {
  selector = await setupWalletSelector({ network: 'testnet', modules: [setupMyNearWallet(), setupMeteorWallet(), setupHereWallet(), setupIntearWallet()] });
  modal = setupModal(selector, { contractId: PLAN });
  const sync = () => { me = selector.store.getState().accounts[0]?.accountId ?? null; render(); };
  selector.store.observable.subscribe(sync);
  sync();
  $('dev-connect').onclick = async () => { if (me) { await (await selector.wallet()).signOut(); me = null; render(); } else modal.show(); };
  $('dev-faucet').onclick = async () => { status('Sending you 50M BUSDOG…'); try { await post('/near/faucet', { account: me }); status('50M BUSDOG sent.'); render(); } catch (e) { status(e.message, true); } };
  $('dev-mycoin').onclick = async () => {
    status('Deploying your coin, minted to you. About half a minute…');
    try {
      const c = await post('/near/my-coin', { owner: me, name: $('dev-cname').value.trim(), symbol: $('dev-csym').value.trim() });
      keep.set('cpn.mycoins', [...(keep.get('cpn.mycoins') || []), c.coin]);
      status(`$${c.symbol} is live and the whole billion is in your wallet.`); render();
    } catch (e) { status(e.message, true); }
  };
  $('dev-make').onclick = () => makePlan().catch(() => {});
  $('dev-plans').onclick = (e) => onPlanClick(e).catch(() => {});
  setInterval(() => me && render(), 8000);
}
main();
