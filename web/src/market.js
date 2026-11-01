// The market: every coin launched here trades on a bonding curve on NEAR. Everything on this
// section is read from the chain (the market contract keeps every trade), and every buy and sell
// is signed by the visitor's own wallet. The only thing from our server is which plan holds each
// coin's dev bag, and the chain is read for that plan's numbers too.

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
  return `0.0<sub>${zeros - 1}</sub>${digits}`;
}
const toks = (raw) => { const n = Number(BigInt(raw) / 1_000_000n); return n >= 1e9 ? `${+(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : n.toLocaleString(); };
const ago = (ms) => { const s = Math.max(1, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
const short = (a) => (a.length > 22 ? `${a.slice(0, 10)}…${a.slice(-9)}` : a);

let MARKET = null, PLANS = null, coins = [], picked = null, side = 'buy', meta = {}, known = {};

async function load() {
  const info = await (await fetch(`${API}/near/info`)).json();
  MARKET = info.market; PLANS = info.plan;
  for (const c of await (await fetch(`${API}/near/coins`)).json()) known[c.coin] = c;
  const pools = await view(MARKET, 'list_pools', { from: 0, limit: 100 });
  await Promise.all(pools.map(async (p) => { meta[p.token] ??= await view(p.token, 'ft_metadata', {}).catch(() => ({ name: p.token, symbol: '?' })); }));
  coins = pools.sort((a, b) => b.listed_at - a.listed_at);
  list();
  const want = new URLSearchParams(location.hash.slice(1)).get('coin');
  if (!picked && coins.length) open(coins.find((c) => c.token === want)?.token ?? coins[0].token);
}

function list() {
  if (!coins.length) { $('mk-list').innerHTML = '<p class="muted">No coins listed yet. Launch one below and it shows up here.</p>'; return; }
  $('mk-list').innerHTML = coins.map((p) => {
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
  const [p, trades, keys] = await Promise.all([
    view(MARKET, 'get_pool', { token: picked }),
    view(MARKET, 'get_trades', { token: picked, from: 0, limit: 500 }),
    fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_access_key_list', finality: 'optimistic', account_id: picked } }) }).then((r) => r.json()).then((j) => j.result?.keys?.length ?? null),
  ]);
  const m = meta[picked];
  const k = known[picked];
  // the dev's plan, found on chain: a plan holding this coin for its creator
  let planId = k?.plan ?? null, plan = null;
  if (planId == null) {
    const all = await view(PLANS, 'list_plans', { from: 0, limit: 500 }).catch(() => []);
    const hit = all.find(([, x]) => x.token === picked && x.beneficiary === p.creator);
    if (hit) [planId, plan] = hit;
  } else plan = await view(PLANS, 'get_plan', { plan_id: planId }).catch(() => null);
  const first = trades[0] ? BigInt(trades[0].price) : BigInt(p.price);
  const dayAgo = Date.now() - 86_400_000;
  const base = trades.filter((t) => Number(t.at_ms) < dayAgo).pop();
  const open24 = base ? BigInt(base.price) : first;
  const change = open24 ? (Number(BigInt(p.price) - open24) / Number(open24)) * 100 : 0;
  const devs = new Set([p.creator, plan?.beneficiary].filter(Boolean));

  $('mk-head').innerHTML = `<div><span class="mk-big">$${esc(m.symbol)}</span> <span class="muted">${esc(m.name)}</span></div>
    <div class="mk-px-big">${price(p.price)} <i>NEAR</i> <b class="${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '+' : ''}${change.toFixed(1)}%</b></div>
    <div class="mk-facts">
      <span><b>${near(BigInt(p.price) * 1_000_000_000n, 2)}</b> NEAR market cap</span>
      <span><b>${near(p.real_near)}</b> NEAR in the pool</span>
      <span><b>${near(p.volume_near)}</b> NEAR traded</span>
      <span><b>${(p.sold_bps / 100).toFixed(1)}%</b> of the curve sold</span>
    </div>
    <div class="mk-facts muted">
      <span><a href="${acctLink(picked)}" target="_blank" rel="noreferrer" class="mono">${esc(short(picked))}</a></span>
      <span>${keys === 0 ? '✓ the coin has no keys, so nobody can change it' : keys == null ? '' : `⚠ the coin still has ${keys} key(s)`}</span>
      <span>creator <span class="mono">${esc(short(p.creator))}</span> earns the 1% fee</span>
    </div>`;
  await chart(trades, p, devs);
  $('mk-tape').innerHTML = trades.length ? trades.slice().reverse().slice(0, 40).map((t) => `<li class="${t.buy ? 'buy' : 'sell'}${devs.has(t.trader) ? ' dev' : ''}">
      <span class="s">${t.buy ? 'BUY' : 'SELL'}</span><span class="w mono">${devs.has(t.trader) ? '<em>dev</em> ' : ''}${esc(short(t.trader))}</span>
      <span>${near(t.near)} NEAR</span><span>${toks(t.tokens)}</span><span class="muted">${ago(Number(t.at_ms))}</span></li>`).join('') : '<li class="muted">No trades yet. Be the first.</li>';
  $('mk-bag').innerHTML = plan ? `<b>The dev's bag is in plan #${planId}</b>
      <div class="mk-facts"><span><b>${toks(plan.balance)}</b> still locked</span><span><b>${toks(plan.released_total)}</b> let out so far</span><span><b>${plan.busted}</b> Busted</span><span>cap <b>${toks(plan.cap)}</b> a ${Number(plan.period_ns) / 1e9 >= 3600 ? 'hour' : 'minute'}</span></div>
      <p class="muted">${plan.loosen_allowed ? 'The cap can be loosened after a public notice.' : 'Launched to never loosen.'} The dev can only sell what the plan lets out, and every sell they make is marked on the tape.</p>`
    : k?.owner ? `<b>Launched from a visitor's wallet</b><p class="muted">The creator holds whatever they didn't list. Check the plans in "Be the dev" to see whether they locked it.</p>` : '';
  if (p.creator === window.cpn?.me && BigInt(p.fees_owed) > 0n) $('mk-bag').innerHTML += `<button class="btn ghost" id="mk-claim">Claim ${near(p.fees_owed)} NEAR in fees</button>`;
  await panel(p);
}

// The chart: market cap in NEAR (price times the billion supply), the way launchpads show it,
// as candles or a line, with volume underneath and the dev's own trades marked. Built from the
// trade records the market contract keeps.
const UP = '#3fbf86', DOWN = '#ec4b3b', DEV = '#f2c230';
let lw = null, chartFor = null, mode = null, step = 60;
// the chart library works in UTC; shift by the viewer's offset so its axis shows their own clock
const TZ = -new Date().getTimezoneOffset() * 60;
const mcap = (yoctoPerToken) => (Number(BigInt(yoctoPerToken)) / 1e24) * 1e9;
const fmtCap = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3));

function series(trades, p) {
  const start = { t: Math.floor(Number(p.listed_at) / 1000) + TZ, v: mcap(BigInt(3_000_000) * 10n ** 18n * 1_000_000n / (BigInt(p.sale_supply) * 5n / 4n)) };
  const pts = trades.map((t) => ({ t: Math.floor(Number(t.at_ms) / 1000) + TZ, v: mcap(t.price), vol: Number(BigInt(t.near)) / 1e24, buy: t.buy, trader: t.trader }));
  // candles: each opens where the last one closed, so there are no gaps in price
  const candles = [], volume = [];
  let last = start.v;
  for (const x of [{ ...start, vol: 0, open: true }, ...pts]) {
    const time = Math.floor(x.t / step) * step;
    let c = candles[candles.length - 1];
    if (!c || c.time !== time) { c = { time, open: last, high: last, low: last, close: last, vol: 0 }; candles.push(c); }
    c.high = Math.max(c.high, x.v); c.low = Math.min(c.low, x.v); c.close = x.v; c.vol += x.vol;
    last = x.v;
  }
  for (const c of candles) volume.push({ time: c.time, value: c.vol, color: c.close >= c.open ? 'rgba(63,191,134,.45)' : 'rgba(236,75,59,.45)' });
  // the line: one point per second, the last trade in it
  const line = [];
  for (const x of [start, ...pts]) { if (line.length && line[line.length - 1].time === x.t) line[line.length - 1].value = x.v; else if (!line.length || x.t > line[line.length - 1].time) line.push({ time: x.t, value: x.v }); }
  // per trade, for the line
  const tradeVol = [];
  for (const x of pts) { const v = { time: x.t, value: x.vol, color: x.buy ? 'rgba(63,191,134,.45)' : 'rgba(236,75,59,.45)' }; if (tradeVol.length && tradeVol[tradeVol.length - 1].time === x.t) tradeVol[tradeVol.length - 1].value += x.vol; else tradeVol.push(v); }
  return { candles, volume, line, pts, tradeVol };
}

async function chart(trades, p, devs) {
  const { createChart, CrosshairMode } = await import('lightweight-charts');
  const box = $('mk-chart');
  const fresh = chartFor !== picked;
  if (fresh) {
    if (lw) lw.chart.remove();
    box.innerHTML = '<div class="mk-tools"><div class="mk-seg" id="mk-mode"><button data-m="candles">Candles</button><button data-m="line">Line</button></div><div class="mk-seg" id="mk-step"><button data-s="60">1m</button><button data-s="300">5m</button><button data-s="900">15m</button><button data-s="3600">1h</button></div><span class="mk-unit muted">market cap, NEAR</span></div><div class="mk-readout" id="mk-readout"></div><div class="mk-canvas" id="mk-canvas"></div>';
    const c = createChart($('mk-canvas'), {
      autoSize: true,
      layout: { background: { color: '#0f0909' }, textColor: '#b9a990', fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 11 },
      grid: { vertLines: { color: 'rgba(59,43,40,.45)' }, horzLines: { color: 'rgba(59,43,40,.45)' } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#6b5a50', labelBackgroundColor: '#3b2b28' }, horzLine: { color: '#6b5a50', labelBackgroundColor: '#3b2b28' } },
      rightPriceScale: { borderColor: '#3b2b28', scaleMargins: { top: 0.12, bottom: 0.26 } },
      timeScale: { borderColor: '#3b2b28', timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 14, minBarSpacing: 3 },
      localization: { priceFormatter: fmtCap },
      handleScale: { axisPressedMouseMove: true }, handleScroll: true,
    });
    const priceFormat = { type: 'custom', formatter: fmtCap, minMove: 0.001 };
    const candle = c.addCandlestickSeries({ upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, priceFormat });
    const area = c.addAreaSeries({ lineColor: UP, lineWidth: 2, topColor: 'rgba(63,191,134,.28)', bottomColor: 'rgba(63,191,134,0)', priceFormat, lastValueVisible: true, crosshairMarkerRadius: 4 });
    const vol = c.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false });
    lw = { chart: c, candle, area, vol };
    chartFor = picked;
    mode = trades.length >= 8 ? 'candles' : 'line';
    $('mk-mode').onclick = (e) => { const m = e.target.dataset.m; if (m) { mode = m; detail(); } };
    $('mk-step').onclick = (e) => { const s = Number(e.target.dataset.s); if (s) { step = s; detail(); } };
    c.subscribeCrosshairMove((param) => readout(param));
  }
  const d = series(trades, p);
  lw.data = d;
  lw.candle.applyOptions({ visible: mode === 'candles' });
  lw.area.applyOptions({ visible: mode === 'line' });
  lw.candle.setData(d.candles.map(({ vol, ...c }) => c));
  lw.area.setData(d.line);
  lw.vol.setData(mode === 'candles' ? d.volume : d.tradeVol);
  // the dev's own trades, on whichever series is showing
  const marks = d.pts.filter((x) => devs.has(x.trader)).map((x) => ({ time: mode === 'candles' ? Math.floor(x.t / step) * step : x.t, position: x.buy ? 'belowBar' : 'aboveBar', color: DEV, shape: x.buy ? 'arrowUp' : 'arrowDown', text: x.buy ? 'dev bought' : 'dev sold' }));
  lw.candle.setMarkers(mode === 'candles' ? marks : []);
  lw.area.setMarkers(mode === 'line' ? marks : []);
  // the line turns red when the coin is below where it listed
  const up = d.line[d.line.length - 1].value >= d.line[0].value;
  lw.area.applyOptions({ lineColor: up ? UP : DOWN, topColor: up ? 'rgba(63,191,134,.4)' : 'rgba(236,75,59,.4)', bottomColor: 'rgba(0,0,0,0)' });
  for (const b of $('mk-mode').children) b.classList.toggle('on', b.dataset.m === mode);
  for (const b of $('mk-step').children) b.classList.toggle('on', Number(b.dataset.s) === step);
  $('mk-step').classList.toggle('off', mode !== 'candles');
  if (fresh) lw.chart.timeScale().fitContent();
  readout({});
}

// the numbers under the pointer, or the latest when the pointer is away
function readout(param) {
  const el = $('mk-readout');
  if (!lw?.data || !el) return;
  const d = lw.data;
  const t = param?.time;
  el.textContent = '';
  const add = (label, value, cls) => { const s = document.createElement('span'); const b = document.createElement('b'); b.textContent = value; if (cls) b.className = cls; s.append(label + ' ', b); el.append(s); };
  if (mode === 'candles') {
    const c = (t != null && d.candles.find((x) => x.time === t)) || d.candles[d.candles.length - 1];
    const cls = c.close >= c.open ? 'up' : 'down';
    add('O', fmtCap(c.open), cls); add('H', fmtCap(c.high), cls); add('L', fmtCap(c.low), cls); add('C', fmtCap(c.close), cls);
    add('Vol', `${c.vol.toFixed(3)} NEAR`);
    const ch = ((c.close - c.open) / c.open) * 100;
    add('', `${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%`, cls);
  } else {
    const x = (t != null && d.line.find((y) => y.time === t)) || d.line[d.line.length - 1];
    add('Market cap', `${fmtCap(x.value)} NEAR`);
    add('at', new Date((x.time - TZ) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  }
}

let quoteTimer = null;
async function panel(p) {
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
  if (side === 'buy') await w.send([{ receiverId: MARKET, actions: [w.fc('buy', { token: picked, min_out: min }, 150, amt)] }], `Buying $${sym}`, say);
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
load().catch((e) => { $('mk-list').innerHTML = `<p class="err">${esc(e.message)}</p>`; });
setInterval(() => refresh().catch(() => {}), 10_000);
