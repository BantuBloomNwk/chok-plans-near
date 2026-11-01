// The panels around the chart: the coin's headline numbers, the stats box, and the trades and
// holders tables. Same rule as the chart: they take plain trades and know no chain.
import { stats, positions, fmtCompact, fmtPrice, short } from './data.js';
import { face } from './terminal.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (ms) => { const s = Math.max(1, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };

// canvases can't be written as HTML, so faces are stamped in after each render
function stampFaces(el) {
  el.querySelectorAll('canvas[data-face]').forEach((c) => { c.width = c.height = 44; c.getContext('2d').drawImage(face(c.dataset.face), 0, 0); });
}
const acct = (who, link, tags = '') => {
  const href = link?.(who);
  const body = `<canvas data-face="${esc(who)}"></canvas>${esc(short(who))}`;
  return `<span class="acct">${href ? `<a href="${esc(href)}" target="_blank" rel="noreferrer" style="display:inline-flex;gap:7px;align-items:center;color:inherit">${body}</a>` : body}${tags}</span>`;
};

/** The headline: market cap first, the way a terminal reads. */
export function renderHead(el, m) {
  const last = m.trades[m.trades.length - 1]?.price ?? m.start.price;
  const ath = m.trades.reduce((a, t) => Math.max(a, t.price), m.start.price);
  const day = stats(m.trades, 86_400_000);
  const traders = new Set(m.trades.map((t) => t.who)).size;
  el.innerHTML = `<div class="tp-head">
    <div class="tp-id"><canvas data-face="${esc(m.token)}"></canvas><div><b>$${esc(m.symbol)}</b> <span class="muted">${esc(m.name)}</span><div style="font-size:.84rem">${fmtPrice(last)} <span class="muted">${esc(m.quote)} a token</span></div></div></div>
    <div class="tp-kv big"><span>Market cap</span><b>${fmtCompact(last * m.supply)} ${esc(m.quote)}</b></div>
    <div class="tp-kv"><span>24h vol</span><b>${fmtCompact(day.volume)}</b></div>
    <div class="tp-kv"><span>Traders</span><b>${traders}</b></div>
    <div class="tp-kv"><span>All-time high</span><b>${fmtCompact(ath * m.supply)}</b></div>
  </div>${m.planLine ?? ''}`;
  stampFaces(el);
}

const split = (a, b) => { const t = a + b || 1; return `<div class="tp-split"><i style="flex:${a / t}"></i><i style="flex:${b / t}"></i></div>`; };

/** Buys and sells, money and wallets, over a window the reader picks. */
export function renderStats(el, trades, quote, state) {
  const windows = [['5m', 300_000], ['1h', 3_600_000], ['24h', 86_400_000], ['All', null]];
  const s = stats(trades, windows.find(([k]) => k === state.window)?.[1] ?? null);
  el.innerHTML = `<div class="tp-stats"><div class="head"><b>Stats</b><div class="term-seg plain" data-stats>${windows.map(([k]) => `<button data-w="${k}" class="${k === state.window ? 'on' : ''}">${k}</button>`).join('')}</div></div>
    <div class="tp-change"><span class="muted">Price change</span><b class="${s.change >= 0 ? 'up' : 'down'}">${s.change >= 0 ? '↑' : '↓'} ${Math.abs(s.change).toFixed(1)}%</b></div>
    <div class="tp-change" style="margin-top:2px"><span class="muted">Volume</span><b>${fmtCompact(s.volume, 3)} ${esc(quote)}</b></div>
    <div class="tp-row"><div class="nums"><span class="up">${s.buys} <span>buys</span></span><span class="down">${s.sells} <span>sells</span></span></div>${split(s.buys, s.sells)}</div>
    <div class="tp-row"><div class="nums"><span class="up">${fmtCompact(s.buyVol, 3)} <span>buy vol</span></span><span class="down">${fmtCompact(s.sellVol, 3)} <span>sell vol</span></span></div>${split(s.buyVol, s.sellVol)}</div>
    <div class="tp-row"><div class="nums"><span class="up">${s.buyers} <span>buyers</span></span><span class="down">${s.sellers} <span>sellers</span></span></div>${split(s.buyers, s.sellers)}</div></div>`;
  el.querySelector('[data-stats]').onclick = (e) => { const w = e.target.dataset.w; if (w) { state.window = w; renderStats(el, trades, quote, state); } };
}

/** The tape and the holders, under the chart. */
export function renderTabs(el, m, state) {
  const last = m.trades[m.trades.length - 1]?.price ?? m.start.price;
  const pos = positions(m.trades, last, m.supply);
  const holding = pos.filter((p) => p.tokens > 0);
  const tag = (who) => `${m.devs.has(who) ? ' <em>DEV</em>' : ''}${who === m.me ? ' <em class="you">YOU</em>' : ''}`;
  const tape = m.trades.slice().reverse().slice(0, 200).map((t) => `<tr class="${m.devs.has(t.who) ? 'dev' : ''}"><td>${acct(t.who, m.link, tag(t.who))}</td><td class="${t.buy ? 'up' : 'down'}"><b>${t.buy ? 'Buy' : 'Sell'}</b></td><td>${fmtCompact(t.quote, 4)}</td><td>${fmtCompact(t.tokens)}</td><td>${fmtCompact(t.price * m.supply)}</td><td class="muted">${ago(t.t)}</td></tr>`).join('');
  const holders = holding.map((p) => `<tr class="${m.devs.has(p.who) ? 'dev' : ''}"><td>${acct(p.who, m.link, tag(p.who))}</td><td>${fmtCompact(p.tokens)}</td><td>${p.share.toFixed(2)}%</td><td>${fmtCompact(p.value, 3)}</td><td class="${p.pnl >= 0 ? 'up' : 'down'}">${p.pnl >= 0 ? '+' : ''}${fmtCompact(p.pnl, 3)}</td></tr>`).join('');
  const q = esc(m.quote);
  const scroll = el.querySelector('.tp-wrap')?.scrollTop ?? 0;
  el.innerHTML = `<div class="tp-tabs" role="tablist"><button data-t="trades" class="${state.tab === 'trades' ? 'on' : ''}">Trades<i>${m.trades.length}</i></button><button data-t="holders" class="${state.tab === 'holders' ? 'on' : ''}">Holders<i>${holding.length}</i></button></div>
    <div class="tp-wrap">${state.tab === 'trades'
      ? `<table class="tp-table"><thead><tr><th>Trader</th><th>Side</th><th>${q}</th><th>${esc(m.symbol)}</th><th>MCap</th><th>Age</th></tr></thead><tbody>${tape || '<tr><td colspan="6" class="muted">No trades yet. Be the first.</td></tr>'}</tbody></table>`
      : `<table class="tp-table"><thead><tr><th>Holder</th><th>Held</th><th>% supply</th><th>Worth (${q})</th><th>Gain or loss (${q})</th></tr></thead><tbody>${holders || '<tr><td colspan="5" class="muted">Nobody holds any from the market yet.</td></tr>'}</tbody></table><p class="tp-note">Worked out from market trades. Tokens someone was sent directly don't show here, and the plan's locked bag isn't a holder.</p>`}</div>`;
  el.querySelector('.tp-tabs').onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) { state.tab = b.dataset.t; renderTabs(el, m, state); el.querySelector('.tp-wrap').scrollTop = 0; } };
  el.querySelector('.tp-wrap').scrollTop = scroll;
  stampFaces(el);
}
