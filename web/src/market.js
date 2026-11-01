// The market: every coin launched here trades on a bonding curve on NEAR. Everything on this
// section is read from the chain: the market contract keeps every trade, each pool names its coin's
// plan, and the plan contract keeps that plan's log. Every buy and sell is signed by the visitor's
// own wallet.

import { createTerminal } from './terminal/terminal.js';
import { renderHead, renderStats, renderTabs } from './terminal/panels.js';
import { sampleMarket } from './terminal/sample.js';

const API = 'https://near-play.161-97-74-212.sslip.io';
const RPC = 'https://test.rpc.fastnear.com';
const YOCTO = 10n ** 24n;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const acctLink = (a) => `https://testnet.nearblocks.io/address/${a}`;

async function view(contract, method, args) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'optimistic', account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) } }) });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(j.error?.cause?.name || j.result.error);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
}
async function nearBalance(account) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'optimistic', account_id: account } }) });
  const j = await r.json();
  return BigInt(j.result?.amount ?? 0);
}

// NEAR amounts, and prices with the zeros counted: 0.0₈3 NEAR is 0.000000003
const near = (y, dp = 3) => { const n = Number(BigInt(y)) / 1e24; return n === 0 ? '0' : n < 0.001 ? n.toExponential(2) : n.toLocaleString(undefined, { maximumFractionDigits: dp }); };
function price(y) {
  const n = Number(BigInt(y)) / 1e24;
  if (!n) return '0';
  if (n >= 0.01) return n.toPrecision(4);
  const zeros = Math.floor(-Math.log10(n));
  const digits = Math.round(n * 10 ** (zeros + 3)).toString().replace(/0+$/, '') || '0';
  return `0.0<sub>${zeros}</sub>${digits}`;
}
const toks = (raw) => { const n = Number(BigInt(raw) / 1_000_000n); return n >= 1e9 ? `${+(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : n.toLocaleString(); };
const ago = (ms) => { const s = Math.max(1, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
const short = (a) => (a.length > 22 ? `${a.slice(0, 10)}…${a.slice(-9)}` : a);

let MARKET = null, PLANS = null, coins = [], picked = null, side = 'buy', meta = {};

async function load() {
  const info = await (await fetch(`${API}/near/info`)).json();
  MARKET = info.market; PLANS = info.plan;
  const pools = await view(MARKET, 'list_pools', { from: 0, limit: 100 });
  await Promise.all(pools.map(async (p) => { meta[p.token] ??= await view(p.token, 'ft_metadata', {}).catch(() => ({ name: p.token, symbol: '?' })); }));
  coins = pools.sort((a, b) => b.listed_at - a.listed_at);
  list();
  const want = new URLSearchParams(location.hash.slice(1)).get('coin');
  if (!picked && SAMPLE) open('sample');
  else if (!picked && coins.length) open(coins.find((c) => c.token === want)?.token ?? coins[0].token);
}

function list() {
  const demo = SAMPLE ? `<button class="mk-coin${picked === 'sample' ? ' on' : ''}" data-coin="sample"><span class="mk-sym">$DANDOG</span><span class="mk-name">Sample data</span></button>` : '';
  if (!coins.length && !SAMPLE) { $('mk-list').innerHTML = '<p class="muted">No coins listed yet. Launch one below and it shows up here.</p>'; return; }
  $('mk-list').innerHTML = demo + coins.map((p) => {
    const m = meta[p.token];
    const mcap = BigInt(p.price) * 1_000_000_000n;
    return `<button class="mk-coin${picked === p.token ? ' on' : ''}" data-coin="${esc(p.token)}">
      <span class="mk-sym">$${esc(m.symbol)}</span><span class="mk-name">${esc(m.name)}</span>
      <span class="mk-px">${price(p.price)} <i>NEAR</i></span>
      <span class="mk-sub">cap ${near(mcap, 1)} NEAR · ${p.trades} trades</span>
      <span class="mk-bar"><i style="width:${p.sold_bps / 100}%"></i></span><span class="mk-sub">${(p.sold_bps / 100).toFixed(1)}% of the curve sold</span>
    </button>`;
  }).join('');
}

async function open(token) {
  picked = token;
  history.replaceState(null, '', `#coin=${encodeURIComponent(token)}`);
  list();
  $('mk-detail').hidden = false;
  await detail();
}

async function detail() {
  if (!picked) return;
  if (picked === 'sample') { showSample(); return; }
  const [p, trades, keys] = await Promise.all([
    view(MARKET, 'get_pool', { token: picked }),
    view(MARKET, 'get_trades', { token: picked, from: 0, limit: 500 }),
    fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_access_key_list', finality: 'optimistic', account_id: picked } }) }).then((r) => r.json()).then((j) => j.result?.keys?.length ?? null),
  ]);
  const m = meta[picked];
  const planId = p.plan;
  const plan = await view(PLANS, 'get_plan', { plan_id: planId }).catch(() => null);
  const devs = new Set([p.creator, plan?.beneficiary].filter(Boolean));
  // what the plan did, from its own log on chain, as stamps on the chart
  const log = await view(PLANS, 'get_log', { plan_id: planId, from: 0, limit: 200 }).catch(() => []);
  const marks = log.filter((e) => e.kind === 'busted' || e.kind === 'released').map((e) => e.kind === 'busted'
    ? { t: Number(e.at_ms), kind: 'busted', label: 'BUSTED', note: `The plan refused ${toks(e.amount)}${e.reason ? ` (${e.reason})` : ''}, and the cap is now ${toks(e.cap)}.` }
    : { t: Number(e.at_ms), kind: 'released', label: `PLAN +${toks(e.amount)}`, note: 'The plan let this out, inside its rules.' });
  showTerminal({ token: picked, symbol: m.symbol, name: m.name, trades: toTrades(trades), marks, devs, me: window.cpn?.me ?? null, start: { t: Number(p.listed_at), price: startPrice(p) } });
  $('mk-chain').innerHTML = `<a href="${acctLink(picked)}" target="_blank" rel="noreferrer" class="mono">${esc(short(picked))}</a>
    <span>${keys === 0 ? '✓ the coin has no keys, so nobody can change it' : keys == null ? '' : `⚠ the coin still has ${keys} key(s)`}</span>
    <span><b>${near(p.real_near)}</b> NEAR in the pool</span>
    <span><b>${(p.sold_bps / 100).toFixed(1)}%</b> of the curve sold</span>
    <span>creator <span class="mono">${esc(short(p.creator))}</span> earns the 1% fee</span>`;
  const fmtPeriod = (ns) => { const secs = Number(ns) / 1e9; return secs >= 3600 ? `${+(secs / 3600).toFixed(1)}h` : secs >= 60 ? `${+(secs / 60).toFixed(1)} min` : `${secs}s`; };
  $('mk-bag').innerHTML = plan ? `<b>The dev's bag is in plan #${planId}</b>
      <div class="mk-facts"><span><b>${toks(plan.balance)}</b> still locked</span><span><b>${toks(plan.released_total)}</b> let out so far</span><span><b>${plan.busted}</b> Busted</span><span>cap <b>${toks(plan.cap)}</b> every ${fmtPeriod(plan.period_ns)}</span><span>never below <b>${toks(plan.min_cap)}</b></span></div>
      <p class="muted">${plan.loosen_allowed ? 'The cap can be loosened after a public notice.' : 'Launched to never loosen.'} This coin was minted straight into the market and this plan in one transaction, so the dev never held their share loose. They can only sell what the plan lets out, and sells from the dev's own account are marked.</p>` : '';
  if (p.creator === window.cpn?.me && BigInt(p.fees_owed) > 0n) $('mk-bag').innerHTML += `<button class="btn ghost" id="mk-claim">Claim ${near(p.fees_owed)} NEAR in fees</button>`;
  await panel(p);
}

// What the terminal charts: the contract's trade records as plain numbers. Prices are NEAR per whole
// token, and quote is the NEAR side of the trade.
const SUPPLY = 1_000_000_000;
const yocto = (y) => Number(BigInt(y)) / 1e24;
const toTrades = (list) => list.map((t) => ({ t: Number(t.at_ms), buy: t.buy, who: t.trader, quote: yocto(t.near), tokens: Number(BigInt(t.tokens) / 1000n) / 1000, price: yocto(t.price) }));
const startPrice = (p) => yocto(BigInt(3_000_000) * 10n ** 18n * 1_000_000n / (BigInt(p.sale_supply) * 5n / 4n));
let term = null, termFor = null, sample = null;
// ?sample on the URL shows the terminal on made-up trades, labelled as such
const SAMPLE = new URLSearchParams(location.search).has('sample');
function showSample() {
  sample ??= { ...sampleMarket(), sample: true };
  showTerminal(sample);
  $('mk-chain').innerHTML = '<span class="tag y">Sample data</span><span>These trades are made up, to show the chart at full density. None of them happened on chain.</span>';
  $('mk-bag').innerHTML = '';
}
const panels = { window: '24h', tab: 'trades' };

function showTerminal(m) {
  if (termFor !== m.token) {
    term?.destroy();
    term = createTerminal($('mk-chart'), { symbol: m.symbol, quote: 'NEAR', supply: SUPPLY, venue: 'CHOK', link: (a) => (m.sample ? null : acctLink(a)) });
    termFor = m.token;
  }
  term.setMarket(m);
  renderHead($('mk-head'), { ...m, quote: 'NEAR', supply: SUPPLY });
  renderTabs($('mk-tabs'), { ...m, quote: 'NEAR', supply: SUPPLY, link: (a) => (m.sample ? null : acctLink(a)) }, panels);
  renderStats($('mk-stats'), m.trades, 'NEAR', panels);
}

let quoteTimer = null;
async function panel(p) {
  if (!p) return;
  const me = window.cpn?.me;
  $('mk-side-buy').classList.toggle('on', side === 'buy');
  $('mk-side-sell').classList.toggle('on', side === 'sell');
  $('mk-unit').textContent = side === 'buy' ? 'NEAR' : `$${meta[picked].symbol}`;
  $('mk-presets').innerHTML = (side === 'buy' ? ['0.1', '0.5', '1', '2'] : ['25%', '50%', '100%']).map((v) => `<button class="chip" data-v="${v}">${v}${side === 'buy' ? ' NEAR' : ''}</button>`).join('');
  if (!me) { $('mk-go').textContent = 'Connect a wallet to trade'; $('mk-bal').textContent = 'Any NEAR testnet wallet works.'; return; }
  const [nb, tb] = await Promise.all([nearBalance(me), view(picked, 'ft_balance_of', { account_id: me }).catch(() => '0')]);
  $('mk-bal').innerHTML = `You have <b>${near(nb)}</b> NEAR and <b>${toks(tb)}</b> $${esc(meta[picked].symbol)}`;
  $('mk-bal').dataset.tokens = tb;
  $('mk-go').textContent = side === 'buy' ? `Buy $${meta[picked].symbol}` : `Sell $${meta[picked].symbol}`;
  quote();
}

function amountRaw() {
  const v = Number($('mk-amt').value);
  if (!(v > 0)) return 0n;
  return side === 'buy' ? BigInt(Math.round(v * 1e6)) * 10n ** 18n : BigInt(Math.floor(v)) * 1_000_000n;
}

async function quote() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(async () => {
    const amt = amountRaw();
    if (!amt || !picked) { $('mk-quote').textContent = ''; return; }
    try {
      const out = await view(MARKET, side === 'buy' ? 'quote_buy' : 'quote_sell', side === 'buy' ? { token: picked, deposit: amt.toString() } : { token: picked, amount: amt.toString() });
      $('mk-quote').innerHTML = side === 'buy' ? `You get about <b>${toks(out)}</b> $${esc(meta[picked].symbol)}` : `You get about <b>${near(out, 4)}</b> NEAR`;
      $('mk-quote').dataset.out = out;
    } catch (e) { $('mk-quote').textContent = e.message; }
  }, 250);
}

function say(text, bad = false) { $('mk-msg').textContent = text; $('mk-msg').className = bad ? 'err' : 'muted'; }

async function trade() {
  const w = window.cpn;
  if (!w?.me) { w?.connect(); return; }
  const amt = amountRaw();
  const out = BigInt($('mk-quote').dataset.out || '0');
  if (!amt || !out) { say('Put in an amount first.', true); return; }
  // 2% slippage: if the price moves more than that before your trade lands, nothing happens
  const min = (out * 98n / 100n).toString();
  const sym = meta[picked].symbol;
  if (side === 'buy') await w.send([{ receiverId: MARKET, actions: [w.fc('buy', { token: picked, min_out: min }, 200, amt)] }], `Buying $${sym}`, say);
  else await w.send([{ receiverId: picked, actions: [w.fc('ft_transfer_call', { receiver_id: MARKET, amount: amt.toString(), msg: JSON.stringify({ sell: { min_out: min } }) }, 150, 1n)] }], `Selling $${sym}`, say);
  $('mk-amt').value = '';
  await refresh();
}

async function refresh() {
  if (!MARKET) return;
  const pools = await view(MARKET, 'list_pools', { from: 0, limit: 100 }).catch(() => null);
  if (pools) { for (const p of pools) if (!meta[p.token]) meta[p.token] = await view(p.token, 'ft_metadata', {}).catch(() => ({ name: p.token, symbol: '?' })); coins = pools.sort((a, b) => b.listed_at - a.listed_at); list(); }
  await detail().catch(() => {});
}

$('mk-list').onclick = (e) => { const b = e.target.closest('.mk-coin'); if (b) open(b.dataset.coin); };
$('mk-side-buy').onclick = () => { side = 'buy'; $('mk-amt').value = ''; detail(); };
$('mk-side-sell').onclick = () => { side = 'sell'; $('mk-amt').value = ''; detail(); };
$('mk-amt').oninput = quote;
$('mk-presets').onclick = (e) => {
  const v = e.target.closest('.chip')?.dataset.v;
  if (!v) return;
  $('mk-amt').value = v.endsWith('%') ? Math.floor(Number(BigInt($('mk-bal').dataset.tokens || '0') / 1_000_000n) * parseInt(v) / 100) : v;
  quote();
};
$('mk-go').onclick = () => trade().catch(() => {});
$('mk-bag').onclick = async (e) => {
  if (e.target.id !== 'mk-claim') return;
  await window.cpn.send([{ receiverId: MARKET, actions: [window.cpn.fc('claim_fees', { token: picked }, 50)] }], 'Claiming your fees', say).catch(() => {});
  refresh();
};
window.addEventListener('cpn-wallet', () => detail().catch(() => {}));
window.cpnMarketRefresh = refresh;
window.cpnMarketOpen = (coin) => open(coin).catch(() => {});
load().catch((e) => { $('mk-list').innerHTML = `<p class="err">${esc(e.message)}</p>`; });
setInterval(() => refresh().catch(() => {}), 10_000);
