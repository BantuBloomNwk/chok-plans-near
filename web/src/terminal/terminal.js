// A trading terminal chart that knows nothing about any one chain. Give it trades, the accounts that
// count as the dev, and marks for events on the plan; it draws candles, volume, indicators and a
// bubble for every trader, with the dev marked apart. Candles and axes come from KLineChart
// (Apache-2.0, no logo); the bubbles, stamps, legend and toolbar are ours.
//
//   const t = createTerminal(el, { symbol: 'DANDOG', quote: 'NEAR', supply: 1e9, venue: 'CHOK', link });
//   t.setMarket({ trades, marks, devs: new Set([...]), me, start: { t, price } });
import { init, dispose, registerIndicator } from 'klinecharts';
import { PERIODS, fold, pickPeriod, fmtPrice, fmtCompact, foldZeros, pct, short, precisionFor } from './data.js';
import './terminal.css';

const UP = '#3fbf86', DOWN = '#ec4b3b', DEV = '#f2c230', GRID = 'rgba(120,100,90,.14)', TEXT = '#9c8d7b', SURFACE = '#0f0909', RULE = '#3b2b28';
const PANE = 'candle_pane';
const keep = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(`terminal.${k}`)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`terminal.${k}`, JSON.stringify(v)); } catch { /* private window */ } },
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A face for an account, from its name alone: the same wallet looks the same everywhere, no network.
const faces = new Map();
function hash(text) { let h = 2166136261; for (const c of text) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export function face(who, size = 44) {
  const key = `${who}|${size}`;
  if (faces.has(key)) return faces.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const h = hash(who), hue = h % 360;
  const fill = g.createLinearGradient(0, 0, size, size);
  fill.addColorStop(0, `hsl(${hue} 62% 46%)`);
  fill.addColorStop(1, `hsl(${(hue + 40 + (h >>> 9) % 60) % 360} 58% 27%)`);
  g.fillStyle = fill;
  g.fillRect(0, 0, size, size);
  g.fillStyle = '#fff';
  g.font = `800 ${Math.round(size * 0.56)}px "Baloo 2", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText((who.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase(), size / 2, size * 0.54);
  faces.set(key, c);
  return c;
}

function disc(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); }

function drawBubble(ctx, b) {
  const { x, y, r, trade, isDev, isMe } = b;
  const ring = trade.buy ? UP : DOWN;
  ctx.save();
  ctx.setLineDash([]); // the library leaves its own dash on the context
  disc(ctx, x, y, r + 2.5); ctx.fillStyle = SURFACE; ctx.fill();
  ctx.save(); disc(ctx, x, y, r); ctx.clip(); ctx.drawImage(face(trade.who), x - r, y - r, r * 2, r * 2); ctx.restore();
  disc(ctx, x, y, r); ctx.lineWidth = isDev ? 3 : 2; ctx.strokeStyle = isDev ? DEV : isMe ? '#f8eedb' : ring; ctx.stroke();
  // the arrow says buy or sell without relying on colour, including on a dev's yellow ring
  const ax = x + r * 0.78, ay = y + r * 0.78;
  disc(ctx, ax, ay, 5.5); ctx.fillStyle = ring; ctx.fill();
  ctx.fillStyle = trade.buy ? '#06210f' : '#fff';
  ctx.beginPath();
  if (trade.buy) { ctx.moveTo(ax, ay - 3); ctx.lineTo(ax + 3, ay + 2); ctx.lineTo(ax - 3, ay + 2); }
  else { ctx.moveTo(ax, ay + 3); ctx.lineTo(ax + 3, ay - 2); ctx.lineTo(ax - 3, ay - 2); }
  ctx.closePath(); ctx.fill();
  if (isDev) {
    // the dev wears a crown
    const cy = y - r - 3, w = 7;
    ctx.fillStyle = DEV; ctx.strokeStyle = SURFACE; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - w, cy + 4); ctx.lineTo(x - w, cy - 3); ctx.lineTo(x - w / 2, cy); ctx.lineTo(x, cy - 5); ctx.lineTo(x + w / 2, cy); ctx.lineTo(x + w, cy - 3); ctx.lineTo(x + w, cy + 4);
    ctx.closePath(); ctx.stroke(); ctx.fill();
  }
  ctx.restore();
}

function drawStamp(ctx, s) {
  const color = s.mark.kind === 'busted' ? DOWN : DEV;
  ctx.save();
  ctx.strokeStyle = color; ctx.setLineDash([3, 3]); ctx.globalAlpha = 0.45; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(s.x, s.y + 12); ctx.lineTo(s.x, s.bottom); ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.setLineDash([]);
  ctx.translate(s.x, s.y); ctx.rotate(s.mark.kind === 'busted' ? -0.1 : 0);
  ctx.font = '800 10px "JetBrains Mono", ui-monospace, monospace';
  const w = ctx.measureText(s.mark.label).width + 12;
  ctx.fillStyle = SURFACE; ctx.fillRect(-w / 2, -9, w, 18);
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.strokeRect(-w / 2, -9, w, 18);
  if (s.mark.kind === 'busted') ctx.strokeRect(-w / 2 + 2.5, -6.5, w - 5, 13);
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(s.mark.label, 0, 0.5);
  ctx.restore();
  s.w = w;
}

// The bubbles live in one custom indicator on the candle pane, so they scroll and zoom with the
// candles and only the ones in view are ever drawn.
registerIndicator({
  name: 'CHOK_MARKERS',
  series: 'price',
  figures: [],
  calc: () => [],
  createTooltipDataSource: () => ({ name: '', calcParamsText: '', legends: [], features: [] }),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    indicator.extendData?.paint(ctx, chart, bounding, xAxis, yAxis);
    return true;
  },
});

// VWAP over what is on the chart, from the real tokens and money in each candle.
registerIndicator({
  name: 'VWAP',
  shortName: 'VWAP',
  series: 'price',
  figures: [{ key: 'vwap', title: 'VWAP: ', type: 'line' }],
  styles: { lines: [{ color: '#9a86ff', size: 1 }] },
  calc: (bars) => {
    let money = 0, tokens = 0;
    return bars.map((b) => {
      money += b.volume || 0; tokens += b.tokens || 0;
      return { vwap: tokens ? (money / tokens) * (b.scale || 1) : b.close };
    });
  },
});

const ICON = {
  cursor: '<path d="M5 3l14 8-6 2-2 6z"/>',
  segment: '<path d="M5 19L19 5"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/>',
  rayLine: '<path d="M5 19L21 3"/><circle cx="5" cy="19" r="2"/>',
  horizontalStraightLine: '<path d="M2 12h20"/><circle cx="12" cy="12" r="2"/>',
  verticalStraightLine: '<path d="M12 2v20"/><circle cx="12" cy="12" r="2"/>',
  parallelStraightLine: '<path d="M3 15L15 3M9 21L21 9"/>',
  fibonacciLine: '<path d="M3 5h18M3 10h18M3 14h18M3 19h18"/>',
  brush: '<path d="M4 20c3 0 4-1 4-3s2-3 3-3 3 1 3 3-2 3-4 3-6 0-6 0zM13 13L20 4"/>',
  clear: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  now: '<path d="M5 12h13M13 7l5 5-5 5M21 5v14"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

const TOOLS = [
  ['cursor', 'Pointer'], ['segment', 'Trend line'], ['rayLine', 'Ray'], ['horizontalStraightLine', 'Horizontal line'], ['verticalStraightLine', 'Vertical line'],
  ['parallelStraightLine', 'Parallel channel'], ['fibonacciLine', 'Fibonacci levels'], ['brush', 'Brush'],
];
const TYPES = [['candle_solid', 'Candles'], ['candle_up_stroke', 'Hollow'], ['ohlc', 'Bars'], ['area', 'Line']];
const STUDIES = [
  ['VOL', 'Volume', 'pane'], ['VWAP', 'VWAP', 'main'], ['MA', 'Moving average', 'main'], ['EMA', 'Exponential MA', 'main'], ['BOLL', 'Bollinger bands', 'main'],
  ['RSI', 'RSI', 'pane'], ['MACD', 'MACD', 'pane'],
];
const MARKERS = [['big', 'Big trades + dev'], ['all', 'All traders'], ['dev', 'Dev only'], ['off', 'Off']];
const RANGES = [['15m', 900], ['1h', 3600], ['6h', 21600], ['1D', 86400], ['All', null]];

export function createTerminal(root, opts) {
  const o = { quote: 'NEAR', supply: 1_000_000_000, venue: 'CHOK', symbol: '', link: () => null, ...opts };
  const st = {
    period: null,
    show: keep.get('show', 'mcap'),
    type: keep.get('type', 'candle_solid'),
    markers: keep.get('markers', 'big'),
    axis: keep.get('axis', 'normal'),
    studies: keep.get('studies', ['VOL']),
    trades: [], marks: [], devs: new Set(), me: null, start: null, bars: [], live: null, capped: false, hits: [], paneIds: {},
  };

  root.classList.add('term');
  root.innerHTML = `
    <div class="term-bar">
      <div class="term-seg" data-g="period" role="group" aria-label="Timeframe">${PERIODS.map((p) => `<button data-v="${p.id}">${p.id}</button>`).join('')}</div>
      <div class="term-seg" data-g="type" role="group" aria-label="Chart type">${TYPES.map(([v, l]) => `<button data-v="${v}">${l}</button>`).join('')}</div>
      <details class="term-menu" data-menu="studies"><summary>Indicators</summary><div>${STUDIES.map(([v, l]) => `<label><input type="checkbox" data-study="${v}"> ${l}</label>`).join('')}</div></details>
      <details class="term-menu" data-menu="markers"><summary>Chart markers</summary><div>${MARKERS.map(([v, l]) => `<label><input type="radio" name="term-markers-${o.symbol}" data-markers="${v}"> ${l}</label>`).join('')}</div></details>
      <div class="term-toggle" data-g="show" role="group" aria-label="Show price or market cap"><button data-v="price">Price</button><i>/</i><button data-v="mcap">MCap</button></div>
      <span class="term-grow"></span>
      <button class="term-ic" data-a="now" title="Back to the latest candle">${svg('now')}</button>
      <button class="term-ic" data-a="shot" title="Save a picture of the chart">${svg('camera')}</button>
      <button class="term-ic" data-a="full" title="Full screen">${svg('full')}</button>
    </div>
    <div class="term-body">
      <div class="term-rail" role="toolbar" aria-label="Drawing tools">${TOOLS.map(([v, l]) => `<button data-tool="${v}" title="${l}" aria-label="${l}">${svg(v)}</button>`).join('')}<button data-tool="clear" title="Remove all drawings (right-click removes one)" aria-label="Remove all drawings">${svg('clear')}</button></div>
      <div class="term-plot">
        <div class="term-legend"></div>
        <div class="term-canvas"></div>
        <div class="term-tip" hidden></div>
      </div>
    </div>
    <div class="term-foot">
      <div class="term-seg plain" data-g="range" role="group" aria-label="Range">${RANGES.map(([l]) => `<button data-v="${l}">${l}</button>`).join('')}</div>
      <span class="term-grow"></span>
      <span class="term-clock"></span>
      <div class="term-seg plain" data-g="axis" role="group" aria-label="Price scale"><button data-v="percentage">%</button><button data-v="logarithm">log</button><button data-v="normal">auto</button></div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const plot = $('.term-plot');

  const valueOf = (price) => (st.show === 'mcap' ? price * o.supply : price);
  const title = () => (st.show === 'mcap' ? `Market cap (${o.quote})` : `Price (${o.quote})`);

  const chart = init($('.term-canvas'), {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    decimalFold: { format: (v) => foldZeros(v) },
    thousandsSeparator: { sign: ',' },
    styles: {
      grid: { horizontal: { color: GRID }, vertical: { color: GRID } },
      candle: {
        type: st.type,
        bar: { upColor: UP, downColor: DOWN, noChangeColor: '#6b5a50', upBorderColor: UP, downBorderColor: DOWN, noChangeBorderColor: '#6b5a50', upWickColor: UP, downWickColor: DOWN, noChangeWickColor: '#6b5a50', compareRule: 'current_open' },
        area: { lineColor: UP, lineSize: 2, value: 'close', backgroundColor: [{ offset: 0, color: 'rgba(63,191,134,.02)' }, { offset: 1, color: 'rgba(63,191,134,.28)' }] },
        priceMark: {
          show: true,
          high: { show: false }, low: { show: false },
          last: { show: true, upColor: UP, downColor: DOWN, noChangeColor: '#6b5a50', line: { show: true, style: 'dashed', dashedValue: [2, 3], size: 1 }, text: { show: true, size: 11, family: '"JetBrains Mono", ui-monospace, monospace', color: '#06140c', paddingLeft: 5, paddingRight: 5, paddingTop: 3, paddingBottom: 3, borderRadius: 3 } },
        },
        tooltip: { showRule: 'none', title: { show: false }, legend: { template: [] } },
      },
      indicator: {
        ohlc: { compareRule: 'current_open', upColor: 'rgba(63,191,134,.55)', downColor: 'rgba(236,75,59,.55)', noChangeColor: 'rgba(107,90,80,.55)' },
        bars: [{ upColor: 'rgba(63,191,134,.55)', downColor: 'rgba(236,75,59,.55)', noChangeColor: 'rgba(107,90,80,.4)' }],
        lines: [{ color: DEV }, { color: '#9a86ff' }, { color: '#63b7ff' }, { color: '#ff8fb1' }, { color: '#7be0d2' }],
        tooltip: { title: { color: TEXT, size: 11, family: '"JetBrains Mono", ui-monospace, monospace' }, legend: { color: TEXT, size: 11, family: '"JetBrains Mono", ui-monospace, monospace' } },
        lastValueMark: { show: false },
      },
      xAxis: { axisLine: { color: RULE }, tickLine: { color: RULE }, tickText: { color: TEXT, size: 11, family: '"JetBrains Mono", ui-monospace, monospace' } },
      yAxis: { axisLine: { color: RULE }, tickLine: { color: RULE }, tickText: { color: TEXT, size: 11, family: '"JetBrains Mono", ui-monospace, monospace' } },
      separator: { color: RULE },
      crosshair: {
        horizontal: { line: { color: '#6b5a50', dashedValue: [3, 3] }, text: { backgroundColor: RULE, borderColor: RULE, color: '#f8eedb', size: 11 } },
        vertical: { line: { color: '#6b5a50', dashedValue: [3, 3] }, text: { backgroundColor: RULE, borderColor: RULE, color: '#f8eedb', size: 11 } },
      },
      overlay: {
        line: { color: DEV }, point: { color: DEV, borderColor: 'rgba(242,194,48,.35)', activeColor: DEV, activeBorderColor: 'rgba(242,194,48,.35)' },
        text: { color: DEV }, rect: { color: 'rgba(242,194,48,.08)', borderColor: DEV }, polygon: { color: 'rgba(242,194,48,.08)', borderColor: DEV },
      },
    },
  });
  chart.setOffsetRightDistance(70);

  // the bubbles and stamps, drawn on the candle pane each time it paints
  const painter = {
    paint(ctx, c, bounding, xAxis, yAxis) {
      st.hits = [];
      const vis = c.getVisibleRange();
      const list = c.getDataList();
      if (!list.length) return;
      const from = list[Math.max(0, vis.from)]?.timestamp ?? 0, to = list[Math.min(list.length - 1, vis.to)]?.timestamp ?? 0;
      const size = st.period.secs * 1000;
      const inView = (t) => { const b = Math.floor(t / size) * size; return b >= from && b <= to; };
      const px = (t) => xAxis.convertTimestampToPixel(Math.floor(t / size) * size);

      // stamps along the top, for what the dev's plan did
      if (st.markers !== 'off') {
        const rows = [-Infinity, -Infinity]; // two rows of stamps; one that fits neither waits for a zoom in
        for (const mark of st.marks) {
          if (!inView(mark.t)) continue;
          const x = px(mark.t);
          const row = rows.findIndex((end) => x - end >= 74);
          if (row < 0) continue;
          rows[row] = x;
          const s = { x, y: row ? 34 : 14, bottom: bounding.height, mark };
          drawStamp(ctx, s);
          st.hits.push({ x, y: s.y, r: 16, mark });
        }
      }
      if (st.markers === 'off') return;

      let picks = st.trades.filter((t) => inView(t.t));
      const isDev = (t) => st.devs.has(t.who), isMe = (t) => t.who === st.me;
      const biggest = picks.slice().sort((a, b) => b.quote - a.quote);
      if (st.markers === 'dev') picks = picks.filter((t) => isDev(t) || isMe(t));
      else {
        // too many faces is noise: the biggest trades win, and the dev and you are always drawn
        const room = st.markers === 'big' ? 12 : Math.max(14, Math.floor(bounding.width / 18));
        const keepers = new Set(biggest.slice(0, room));
        picks = picks.filter((t) => keepers.has(t) || isDev(t) || isMe(t));
      }
      // dev and you last, so nothing covers them
      picks.sort((a, b) => Number(isDev(a) || isMe(a)) - Number(isDev(b) || isMe(b)) || a.t - b.t);
      const placed = [];
      for (const trade of picks) {
        const dev = isDev(trade);
        const r = dev ? 12 : 10;
        const x = px(trade.t);
        let y = yAxis.convertToPixel(valueOf(trade.price));
        // buys step down from the price and sells step up, until they stop covering each other
        const dir = trade.buy ? 1 : -1;
        y = Math.max(r + 2, Math.min(bounding.height - r - 2, y + dir * (r + 5)));
        for (let n = 0; n < 12 && placed.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + r - 2); n++) y = Math.max(r + 2, Math.min(bounding.height - r - 2, y + dir * (r + 2)));
        const b = { x, y, r, trade, isDev: dev, isMe: isMe(trade) };
        placed.push(b);
        drawBubble(ctx, b);
        st.hits.push({ x, y, r: r + 3, trade, isDev: dev, isMe: b.isMe });
      }
    },
  };
  chart.createIndicator({ name: 'CHOK_MARKERS', paneId: PANE, extendData: painter }, true);

  function legend(bar) {
    const b = bar ?? st.bars[st.bars.length - 1];
    if (!b) { $('.term-legend').innerHTML = ''; return; }
    const prec = chart.getSymbol()?.pricePrecision ?? 2;
    const f = (v) => (st.show === 'mcap' ? fmtCompact(v) : foldZeros(v.toFixed(prec).replace(/0+$/, '')));
    const change = b.close - b.open, up = change >= 0, cls = up ? 'up' : 'down';
    $('.term-legend').innerHTML = `<div class="l1"><b>${esc(o.symbol)}/${esc(o.quote)}</b> ${esc(title())} · ${esc(st.period?.id ?? '')} · ${esc(o.venue)}
      <span class="ohlc ${cls}">O<em>${f(b.open)}</em> H<em>${f(b.high)}</em> L<em>${f(b.low)}</em> C<em>${f(b.close)}</em> <em>${f(change)} (${pct(b.open ? (change / b.open) * 100 : 0)})</em></span>${st.capped ? ' <span class="muted">showing the latest 4,000 candles</span>' : ''}</div>
      <div class="l2">Volume <em class="${cls}">${fmtCompact(b.volume ?? 0)} ${esc(o.quote)}</em></div>`;
  }

  function compute() {
    const now = Date.now();
    const { bars, capped } = fold(st.trades, { secs: st.period.secs, valueOf, start: st.start, now });
    const scale = st.show === 'mcap' ? o.supply : 1;
    for (const b of bars) b.scale = scale;
    st.capped = capped;
    return bars;
  }

  function symbol() {
    const values = st.bars.length ? st.bars.map((b) => b.low) : [valueOf(st.start?.price ?? 1)];
    chart.setSymbol({ ticker: `${o.symbol}/${o.quote}`, pricePrecision: precisionFor(values), volumePrecision: 3 });
  }

  chart.setDataLoader({
    getBars: ({ type, callback }) => { callback(type === 'init' ? st.bars : [], false); },
    subscribeBar: ({ callback }) => { st.live = callback; },
    unsubscribeBar: () => { st.live = null; },
  });

  // show about this many seconds, ending now
  function fit(seconds) {
    const w = plot.clientWidth - 90;
    const bars = st.bars.length || 1;
    const count = seconds ? Math.min(bars, seconds / st.period.secs) : bars;
    chart.setBarSpace(Math.max(2, Math.min(24, w / Math.max(count, 8))));
    chart.scrollToRealTime();
  }

  function reload(fitAfter = null) {
    if (!st.start) return;
    st.bars = compute();
    symbol();
    chart.setPeriod({ type: st.period.type, span: st.period.span });
    chart.resetData();
    fit(fitAfter);
    legend();
    paintBar();
  }

  function paintBar() {
    root.querySelectorAll('[data-g="period"] button').forEach((b) => b.classList.toggle('on', b.dataset.v === st.period?.id));
    root.querySelectorAll('[data-g="type"] button').forEach((b) => b.classList.toggle('on', b.dataset.v === st.type));
    root.querySelectorAll('[data-g="show"] button').forEach((b) => b.classList.toggle('on', b.dataset.v === st.show));
    root.querySelectorAll('[data-g="axis"] button').forEach((b) => b.classList.toggle('on', b.dataset.v === st.axis));
    root.querySelectorAll('[data-markers]').forEach((b) => { b.checked = b.dataset.markers === st.markers; });
    root.querySelectorAll('[data-study]').forEach((b) => { b.checked = st.studies.includes(b.dataset.study); });
    $('[data-menu="markers"] summary').textContent = `Markers: ${MARKERS.find(([v]) => v === st.markers)[1]}`;
  }

  function setStudy(name, on) {
    const def = STUDIES.find(([v]) => v === name);
    if (on) {
      if (st.paneIds[name]) return;
      const base = { name };
      if (name === 'VOL') base.calcParams = [];
      if (def[2] === 'main') st.paneIds[name] = chart.createIndicator({ ...base, paneId: PANE }, true);
      else st.paneIds[name] = chart.createIndicator(base, false);
      if (def[2] === 'pane') { const id = chart.getIndicators({ name }).at(0)?.paneId; if (id) chart.setPaneOptions({ id, height: name === 'VOL' ? 80 : 100, minHeight: 50 }); }
    } else if (st.paneIds[name]) {
      chart.removeIndicator({ name });
      delete st.paneIds[name];
    }
  }

  function setAxis(name) {
    st.axis = name;
    keep.set('axis', name);
    chart.overrideYAxis({ paneId: PANE, name });
    paintBar();
  }

  // pick up a tool: one drawing, then back to the pointer
  function tool(name) {
    root.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === name));
    if (name === 'cursor') return;
    if (name === 'clear') { chart.removeOverlay({ groupId: 'drawing' }); tool('cursor'); return; }
    chart.createOverlay({
      name, groupId: 'drawing',
      onDrawEnd: () => { tool('cursor'); return true; },
      onRightClick: ({ overlay }) => { chart.removeOverlay({ id: overlay.id }); return true; },
    });
  }

  // the card under the pointer
  function tip(ev) {
    const pane = chart.getDom(PANE, 'main');
    const el = $('.term-tip');
    if (!pane) return;
    const r = pane.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const hit = st.hits.slice().reverse().find((h) => Math.hypot(h.x - mx, h.y - my) <= h.r);
    plot.classList.toggle('over', !!hit);
    if (!hit) { el.hidden = true; st.over = null; return; }
    st.over = hit;
    if (hit.mark) {
      el.innerHTML = `<b class="${hit.mark.kind === 'busted' ? 'down' : 'dev'}">${esc(hit.mark.label)}</b><div>${esc(hit.mark.note ?? '')}</div><div class="muted">${new Date(hit.mark.t).toLocaleString()}</div>`;
    } else {
      const t = hit.trade;
      el.innerHTML = `<div class="who"><canvas width="44" height="44"></canvas><div><b class="mono">${esc(short(t.who))}</b>${hit.isDev ? '<span class="dev tag">DEV</span>' : ''}${hit.isMe ? '<span class="tag">YOU</span>' : ''}<div class="${t.buy ? 'up' : 'down'}">${t.buy ? 'Bought' : 'Sold'} ${fmtCompact(t.tokens)} ${esc(o.symbol)}</div></div></div>
        <dl><dt>${esc(o.quote)}</dt><dd>${fmtCompact(t.quote, 4)}</dd><dt>Price</dt><dd>${fmtPrice(t.price)}</dd><dt>Market cap</dt><dd>${fmtCompact(t.price * o.supply)}</dd><dt>When</dt><dd>${new Date(t.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</dd></dl>`;
      el.querySelector('canvas').getContext('2d').drawImage(face(t.who), 0, 0);
    }
    el.hidden = false;
    const p = plot.getBoundingClientRect();
    const x = ev.clientX - p.left, y = ev.clientY - p.top;
    el.style.left = `${Math.min(x + 16, p.width - el.offsetWidth - 8)}px`;
    el.style.top = `${Math.max(8, Math.min(y + 12, p.height - el.offsetHeight - 8))}px`;
  }
  plot.addEventListener('mousemove', tip);
  plot.addEventListener('mouseleave', () => { $('.term-tip').hidden = true; legend(); });
  plot.addEventListener('click', () => { const href = st.over?.trade && o.link(st.over.trade.who); if (href) window.open(href, '_blank', 'noopener'); });
  plot.addEventListener('contextmenu', (e) => e.preventDefault());

  // the crosshair reports only where it is, so ask which candle that is
  chart.subscribeAction('onCrosshairChange', (d) => {
    if (d?.x == null) return;
    const point = chart.convertFromPixel([{ x: d.x }], { paneId: PANE });
    const at = Array.isArray(point) ? point[0] : point;
    legend(chart.getDataList()[at?.dataIndex]);
  });

  root.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const g = b.closest('[data-g]')?.dataset.g;
    if (g === 'period') { st.period = PERIODS.find((p) => p.id === b.dataset.v); reload(); }
    if (g === 'type') { st.type = b.dataset.v; keep.set('type', st.type); chart.setStyles({ candle: { type: st.type } }); paintBar(); }
    if (g === 'show') { st.show = b.dataset.v; keep.set('show', st.show); reload(); }
    if (g === 'axis') setAxis(b.dataset.v);
    if (g === 'range') {
      const secs = RANGES.find(([l]) => l === b.dataset.v)[1];
      st.period = pickPeriod(secs ?? Math.max(60, (Date.now() - st.start.t) / 1000));
      reload(secs);
    }
    if (b.dataset.tool) tool(b.dataset.tool);
    if (b.dataset.a === 'now') chart.scrollToRealTime(200);
    if (b.dataset.a === 'full') { if (document.fullscreenElement) document.exitFullscreen(); else root.requestFullscreen?.(); }
    if (b.dataset.a === 'shot') {
      const a = document.createElement('a');
      a.href = chart.getConvertPictureUrl(true, 'png', SURFACE);
      a.download = `${o.symbol}-${st.period.id}.png`;
      a.click();
    }
  });
  root.addEventListener('change', (e) => {
    if (e.target.dataset.study) {
      const name = e.target.dataset.study;
      st.studies = e.target.checked ? [...st.studies, name] : st.studies.filter((x) => x !== name);
      keep.set('studies', st.studies);
      setStudy(name, e.target.checked);
    }
    if (e.target.dataset.markers) { st.markers = e.target.dataset.markers; keep.set('markers', st.markers); chart.setStyles({}); paintBar(); nudge(); e.target.closest('details').open = false; }
  });
  // a click outside a menu closes it
  const closeMenus = (e) => root.querySelectorAll('details[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
  document.addEventListener('click', closeMenus);

  // redraw the marker indicator without touching the data
  function nudge() { chart.overrideIndicator({ name: 'CHOK_MARKERS', extendData: painter }); }

  const tz = () => { const off = -new Date().getTimezoneOffset() / 60; return `UTC${off >= 0 ? '+' : ''}${off}`; };
  const clock = setInterval(() => { $('.term-clock').textContent = `${new Date().toLocaleTimeString([], { hour12: false })} ${tz()}`; }, 1000);
  const onFull = () => setTimeout(() => chart.resize(), 60);
  document.addEventListener('fullscreenchange', onFull);
  const ro = new ResizeObserver(() => chart.resize());
  ro.observe(plot);

  for (const s of st.studies) setStudy(s, true);
  if (st.axis !== 'normal') chart.overrideYAxis({ paneId: PANE, name: st.axis });
  paintBar();

  return {
    chart,
    setMarket({ trades, marks = [], devs = new Set(), me = null, start }) {
      const first = !st.start;
      const sig = (list) => `${list.length}:${list[list.length - 1]?.t ?? 0}`;
      const changed = sig(trades) !== sig(st.trades) || marks.length !== st.marks.length || me !== st.me;
      Object.assign(st, { trades: trades.slice().sort((a, b) => a.t - b.t), marks, devs, me, start });
      if (first) {
        st.period = pickPeriod(Math.max(60, (Date.now() - start.t) / 1000));
        reload();
        return;
      }
      if (!changed && st.bars.length && st.bars[st.bars.length - 1].timestamp === Math.floor(Date.now() / (st.period.secs * 1000)) * (st.period.secs * 1000)) return;
      const next = compute();
      const prev = st.bars;
      st.bars = next;
      // only the tail moves as trades arrive, so feed it in and leave the view where the reader put it
      if (st.live && next[0]?.timestamp === prev[0]?.timestamp) {
        let i = Math.max(0, prev.length - 1);
        while (i > 0 && prev[i] && prev[i].close !== next[i]?.close) i--;
        for (; i < next.length; i++) st.live(next[i]);
      } else { symbol(); chart.resetData(); }
      legend();
      nudge();
    },
    destroy() {
      clearInterval(clock);
      ro.disconnect();
      document.removeEventListener('click', closeMenus);
      document.removeEventListener('fullscreenchange', onFull);
      dispose(chart);
      root.innerHTML = '';
    },
  };
}
