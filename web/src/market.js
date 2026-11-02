// The market: every coin launched here trades on a bonding curve on NEAR. Everything on this
// section is read from the chain: the market contract keeps every trade, each pool names its coin's
// plan, and the plan contract keeps that plan's log. Every buy and sell is signed by the visitor's
// own wallet.

import { createTerminal } from './terminal/terminal.js';
import { renderHead, renderStats, renderTabs, tickAges } from './terminal/panels.js';
import { sampleMarket } from './terminal/sample.js';

const API = 'https://near-play.161-97-74-212.sslip.io';
const YOCTO = 10n ** 24n;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const acctLink = (a) => `https://testnet.nearblocks.io/address/${a}`;

async function view(contract, method, args) {
  const j = await window.nearRpc('query', { request_type: 'call_function', finality: 'optimistic', account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  if (j.error || j.result?.error) throw new Error(j.error?.cause?.name || j.result.error);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
}
async function nearBalance(account) {
  const j = await window.nearRpc('query', { request_type: 'view_account', finality: 'optimistic', account_id: account });
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
const fmtSecs = (s) => (s >= 86400 ? `${+(s / 86400).toFixed(1)} days` : s >= 3600 ? `${+(s / 3600).toFixed(1)} hours` : s >= 60 ? `${+(s / 60).toFixed(1)} min` : `${Math.round(s)}s`);
const untilText = (ns) => { const s = (Number(ns) - Date.now() * 1e6) / 1e9; return s > 0 ? fmtSecs(s) : 'moments, once anyone applies it'; };
const short = (a) => (a.length > 22 ? `${a.slice(0, 10)}…${a.slice(-9)}` : a);

let MARKET = null, PLANS = null, coins = [], picked = null, side = 'buy', meta = {}, showAll = false;

// every pool, however many there are
async function allPools() {
  const all = [];
  for (let from = 0; ; from += 100) {
    const page = await view(MARKET, 'list_pools', { from, limit: 100 });
    all.push(...page);
    if (page.length < 100) return all;
  }
}
// the newest `limit` things a contract keeps a count of
const fromEnd = (count, limit) => ({ from: Math.max(0, Number(count) - limit), limit });

async function load() {
  const info = await (await fetch(`${API}/near/info`)).json();
  MARKET = info.market; PLANS = info.plan;
  const pools = await allPools();
  await Promise.all(pools.map(async (p) => { meta[p.token] ??= await view(p.token, 'ft_metadata', {}).catch(() => ({ name: p.token, symbol: '?' })); }));
  coins = pools.sort((a, b) => b.listed_at - a.listed_at);
  list();
  const want = new URLSearchParams(location.hash.slice(1)).get('coin');
  if (!picked && SAMPLE) open('sample');
  // the busiest coin, not the newest: anyone can launch, so the newest could be anything, or empty
  else if (!picked && coins.length) {
    const best = coins.filter((c) => !/^test-/.test(c.token)).sort((a, b) => b.trades - a.trades)[0] ?? coins[0];
    open(coins.find((c) => c.token === want)?.token ?? best.token);
  }
}

function list() {
  // a coin with barely any trades waits behind the toggle, so the list opens on coins worth looking at
  const live = (p) => (p.trades >= 3 && !/^test-/.test(p.token)) || p.creator === window.cpn?.me;
  const shown = showAll ? coins : coins.filter((p) => live(p) || p.token === picked);
  const hidden = coins.length - shown.length;
  const demo = SAMPLE ? `<button class="mk-coin${picked === 'sample' ? ' on' : ''}" data-coin="sample"><span class="mk-sym">$DANDOG</span><span class="mk-name">Sample data</span></button>` : '';
  if (!coins.length && !SAMPLE) { $('mk-list').innerHTML = '<p class="muted">No coins listed yet. Launch one below and it shows up here.</p>'; return; }
  const more = hidden ? `<button class="mk-coin mk-more" data-all="1"><span class="mk-sym">+${hidden}</span><span class="mk-name">Show quiet and test coins</span></button>` : '';
  $('mk-list').innerHTML = demo + shown.map((p) => {
    const m = meta[p.token];
    const mcap = BigInt(p.price) * 1_000_000_000n;
    return `<button class="mk-coin${picked === p.token ? ' on' : ''}" data-coin="${esc(p.token)}">
      <span class="mk-sym">$${esc(m.symbol)}</span><span class="mk-name">${esc(m.name)}</span>
      <span class="mk-px">${price(p.price)} <i>NEAR</i></span>
      <span class="mk-sub">cap ${near(mcap, 1)} NEAR · ${p.trades} trades</span>
      <span class="mk-bar"><i style="width:${p.sold_bps / 100}%"></i></span><span class="mk-sub">${(p.sold_bps / 100).toFixed(1)}% of the curve sold</span>
    </button>`;
  }).join('') + more;
}

async function open(token) {
  picked = token;
  history.replaceState(null, '', `#coin=${encodeURIComponent(token)}`);
  list();
  $('mk-detail').hidden = false;
  await detail();
}

let busy = false, again = false, shownSig = null, chainKeys = {}, cached = null;
// One tick reads the pool and its plan, and goes on only if something changed: the tape keeps its
// scroll, and a text selection survives. `force` is for the reader changing something themselves.
async function detail(force = false) {
  if (!picked) return;
  if (picked === 'sample') { showSample(); return; }
  if (busy) { again ||= force; return; }
  busy = true;
  try { await detailOf(picked, force); } finally { busy = false; if (again) { again = false; detail(true); } }
}
async function detailOf(token, force) {
  const p = await view(MARKET, 'get_pool', { token });
  const plan = await view(PLANS, 'get_plan', { plan_id: p.plan }).catch(() => null);
  if (picked !== token) return; // they picked another coin while this was on its way
  const me = window.cpn?.me ?? '';
  const sig = JSON.stringify([token, me, p.trades, p.real_near, p.fees_owed, plan]);
  if (sig === shownSig && cached?.token === token) {
    term?.setMarket(cached.market); // new empty candles as time passes, nothing else
    if (force) await panel(p);
    return;
  }
  chainKeys[token] ??= await window.nearRpc('query', { request_type: 'view_access_key_list', finality: 'optimistic', account_id: token }).then((j) => j.result?.keys?.length ?? null);
  const trades = await view(MARKET, 'get_trades', { token, ...fromEnd(p.trades, 2000) });
  if (picked !== token) return;
  shownSig = sig;
  const keys = chainKeys[token];
  const planId = p.plan;
  const m = meta[picked];
  const devs = new Set([p.creator, plan?.beneficiary].filter(Boolean));
  // what the plan did, from its own log on chain, as stamps on the chart
  const log = plan ? await view(PLANS, 'get_log', { plan_id: planId, ...fromEnd(plan.log_len, 300) }).catch(() => []) : [];
  const marks = log.filter((e) => e.kind === 'busted' || e.kind === 'released').map((e) => e.kind === 'busted'
    ? { t: Number(e.at_ms), kind: 'busted', label: 'BUSTED', note: `The plan refused ${toks(e.amount)}${e.reason ? ` (${e.reason})` : ''}, and the cap is now ${toks(e.cap)}.` }
    : { t: Number(e.at_ms), kind: 'released', label: `PLAN +${toks(e.amount)}`, note: 'The plan let this out, inside its rules.' });
  const secs = (ns) => Number(ns) / 1e9;
  const every = plan ? `${toks(plan.cap)} every ${fmtSecs(secs(plan.period_ns))}` : '';
  const pending = plan?.pending ? `<span class="pending">Cap rising to ${toks(plan.pending.cap)} in ${untilText(plan.pending.effective_at)}</span>` : '';
  const noticeText = plan ? fmtSecs(secs(plan.notice_ns)) : '';
  const loosenTag = plan ? (plan.loosen_allowed ? `<span class="can" title="The dev can raise the cap, after this public notice. Then more can leave.">Can loosen after ${noticeText}</span>` : '<span class="never" title="Nobody can ever raise this cap.">Never loosens</span>') : '';
  const pendingHolder = plan?.pending_holder ? `<span class="pending">New holder in ${untilText(plan.pending_holder.effective_at)}</span>` : '';
  const planLine = plan ? `<div class="tp-plan"><span>Dev's bag <b>${toks(plan.balance)}</b> locked</span><span><b>${every}</b></span><span class="busted"><b>${plan.busted}</b> Busted</span>${loosenTag}${pending}${pendingHolder}<span class="tp-curve"><span>${(p.sold_bps / 100).toFixed(1)}% sold</span><i><u style="width:${p.sold_bps / 100}%"></u></i></span></div>` : '';
  cached = null;
  showTerminal({ planLine, planLog: log, token: picked, symbol: m.symbol, name: m.name, trades: toTrades(trades), marks, devs, me: window.cpn?.me ?? null, start: { t: Number(p.listed_at), price: startPrice(p) } });
  $('mk-chain').innerHTML = `<a href="${acctLink(picked)}" target="_blank" rel="noreferrer" class="mono">${esc(short(picked))}</a>
    <span>${keys === 0 ? '✓ the coin has no keys, so nobody can change it' : keys == null ? '' : `⚠ the coin still has ${keys} key(s)`}</span>
    <span><b>${near(p.real_near)}</b> NEAR in the pool</span>
    <span><b>${(p.sold_bps / 100).toFixed(1)}%</b> of the curve sold</span>
    <span>creator <span class="mono">${esc(short(p.creator))}</span> earns the 1% fee</span>`;
  // how quickly the whole bag could leave at this cap: terms decide what a plan is worth
  const drain = plan ? Number(BigInt(plan.balance) / (BigInt(plan.cap) || 1n)) * secs(plan.period_ns) : 0;
  $('mk-bag').innerHTML = plan ? `<b>The dev's bag is in plan #${planId}</b>
      <div class="mk-facts"><span><b>${toks(plan.balance)}</b> still locked</span><span><b>${toks(plan.released_total)}</b> let out so far</span><span><b>${plan.busted}</b> Busted</span><span>cap <b>${every}</b></span><span>never below <b>${toks(plan.min_cap)}</b></span><span>notice <b>${fmtSecs(secs(plan.notice_ns))}</b></span><span>holder <span class="mono">${esc(short(plan.holder))}</span></span></div>
      ${plan.pending ? `<p><b>Pending:</b> the cap goes to ${toks(plan.pending.cap)} in ${untilText(plan.pending.effective_at)}, unless the dev cancels.</p>` : ''}
      ${plan.pending_holder ? `<p><b>Pending:</b> <span class="mono">${esc(short(plan.pending_holder.holder))}</span> becomes the holder in ${untilText(plan.pending_holder.effective_at)}, unless the dev cancels.</p>` : ''}
      ${plan.log_skipped ? `<p><b>${plan.log_skipped} event(s) aren't in this plan's log</b> because its budget ran out. They're still NEP-297 events on chain. <button class="btn ghost" id="mk-topup">Top up its budget</button></p>` : ''}
      <p class="muted">At this cap the whole bag could be out in about ${fmtSecs(drain)}. ${plan.loosen_allowed ? `<b>This dev chose to allow loosening:</b> after ${noticeText} of public notice they can raise the cap as far as they like, and then much more can leave at once.` : 'Launched to never loosen, so nobody can ever raise this cap.'} This coin was minted straight into the market and this plan in one transaction, so the dev never held their share loose. Asking for more than the cap is refused, and sells from the dev's own account are marked. A wallet they buy with separately isn't in any plan, on this or any launchpad.</p>` : '';
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
  if (!m.sample) cached = { token: m.token, market: m };
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
// live ages and windows keep moving between trades, without touching the rest of the tape
setInterval(() => { if (!document.hidden) tickAges($('mk-tabs')); }, 5000);

let quoteTimer = null;
async function panel(p) {
  if (!p) return;
  const me = window.cpn?.me;
  $('mk-side-buy').classList.toggle('on', side === 'buy');
  $('mk-side-sell').classList.toggle('on', side === 'sell');
  $('mk-unit').textContent = side === 'buy' ? 'NEAR' : `$${meta[picked].symbol}`;
  $('mk-presets').innerHTML = (side === 'buy' ? ['0.1', '0.5', '1', '2'] : ['25%', '50%', '100%']).map((v) => `<button class="chip" data-v="${v}">${v}${side === 'buy' ? ' NEAR' : ''}</button>`).join('');
  if (!me) { $('mk-go').textContent = 'Connect a wallet to trade'; $('mk-bal').innerHTML = 'Works with <a href="https://wallet.meteorwallet.app" target="_blank" rel="noreferrer">Meteor</a> on testnet.'; return; }
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
    } catch (e) { $('mk-quote').textContent = e.network ? 'Waiting for the network…' : 'No price for that amount.'; }
  }, 250);
}

function say(text, bad = false) { $('mk-msg').textContent = text; $('mk-msg').className = bad ? 'err' : 'muted'; }

async function trade() {
  const w = window.cpn;
  if (!w?.me) { w?.connect(); return; }
  const amt = amountRaw();
  if (!amt) { say('Put in an amount first.', true); return; }
  // quote now, for exactly this side and amount, not whatever the screen last showed
  const buying = side === 'buy';
  say('Getting the price…');
  const out = BigInt(await view(MARKET, buying ? 'quote_buy' : 'quote_sell', buying ? { token: picked, deposit: amt.toString() } : { token: picked, amount: amt.toString() }));
  if (!out) { say(buying ? 'That\'s too small to buy anything.' : 'That\'s too small to sell: it would be worth under about 0.003 NEAR.', true); return; }
  // 2% slippage: if the price moves more than that before your trade lands, nothing happens
  const min = (out * 98n / 100n).toString();
  const sym = meta[picked].symbol;
  if (buying) await w.send([{ receiverId: MARKET, actions: [w.fc('buy', { token: picked, min_out: min }, 250, amt)] }], `Buying $${sym}`, say);
  else await w.send([{ receiverId: picked, actions: [w.fc('ft_transfer_call', { receiver_id: MARKET, amount: amt.toString(), msg: JSON.stringify({ sell: { min_out: min } }) }, 150, 1n)] }], `Selling $${sym}`, say);
  $('mk-amt').value = '';
  $('mk-quote').textContent = '';
  shownSig = null;
  await refresh();
}

let tick = 0;
async function refresh() {
  if (!MARKET) return;
  // the coin list changes slowly, so it's read one tick in six
  if (tick++ % 6 === 0) {
    const pools = await allPools().catch(() => null);
    if (pools) {
      for (const p of pools) if (!meta[p.token]) meta[p.token] = await view(p.token, 'ft_metadata', {}).catch(() => ({ name: p.token, symbol: '?' }));
      const next = pools.sort((a, b) => b.listed_at - a.listed_at);
      if (JSON.stringify(next) !== JSON.stringify(coins)) { coins = next; list(); }
    }
  }
  await detail().catch(() => {});
}

$('mk-list').onclick = (e) => {
  const b = e.target.closest('.mk-coin');
  if (b?.dataset.all) { showAll = true; list(); } else if (b) open(b.dataset.coin);
};
// the buttons answer at once; what depends on the chain follows
const lightSides = () => { $('mk-side-buy').classList.toggle('on', side === 'buy'); $('mk-side-sell').classList.toggle('on', side === 'sell'); };
$('mk-side-buy').onclick = () => { side = 'buy'; lightSides(); $('mk-amt').value = ''; $('mk-quote').textContent = ''; detail(true); };
$('mk-side-sell').onclick = () => { side = 'sell'; lightSides(); $('mk-amt').value = ''; $('mk-quote').textContent = ''; detail(true); };
$('mk-amt').oninput = quote;
$('mk-presets').onclick = (e) => {
  const v = e.target.closest('.chip')?.dataset.v;
  if (!v) return;
  $('mk-amt').value = v.endsWith('%') ? Math.floor(Number(BigInt($('mk-bal').dataset.tokens || '0') / 1_000_000n) * parseInt(v) / 100) : v;
  quote();
};
let trading = false;
$('mk-go').onclick = () => {
  if (trading) return;
  trading = true;
  $('mk-go').disabled = true;
  trade().catch((e) => { if (e.network) say(e.message, true); }).finally(() => { trading = false; $('mk-go').disabled = false; });
};
$('mk-bag').onclick = async (e) => {
  if (e.target.id === 'mk-topup') {
    if (!window.cpn?.me) { window.cpn?.connect(); return; }
    const id = coins.find((c) => c.token === picked)?.plan;
    await window.cpn.send([{ receiverId: PLANS, actions: [window.cpn.fc('fund_judge', { plan_id: id }, 30, window.cpn.NEAR(0.05))] }], 'Topping up the plan', say).catch(() => {});
    return refresh();
  }
  if (e.target.id !== 'mk-claim') return;
  await window.cpn.send([{ receiverId: MARKET, actions: [window.cpn.fc('claim_fees', { token: picked }, 50)] }], 'Claiming your fees', say).catch(() => {});
  refresh();
};
window.addEventListener('cpn-wallet', () => detail(true).catch(() => {}));
window.cpnMarketRefresh = refresh;
window.cpnMarketOpen = (coin) => open(coin).catch(() => {});
// a slow start tries again by itself rather than leaving an error on screen
const start = () => load().catch(() => { $('mk-list').innerHTML = '<p class="muted">Waiting for the network…</p>'; setTimeout(start, 4000); });
start();
// close to live while someone is watching, and nothing while the tab is hidden
setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 2_500);
$('mk-jump')?.addEventListener('click', () => document.querySelector('.mk-trade')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
