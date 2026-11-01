// The numbers behind the terminal: candles, stats, positions and formatting. Nothing here knows
// about NEAR, the DOM or a chart library, so it runs in node tests and moves to any chain as is.
//
// A trade is { t: ms, buy: bool, who: string, quote: number, tokens: number, price: number },
// where quote is the money side of the trade and price is the quote per whole token after it.

export const PERIODS = [
  { id: '1s', secs: 1, type: 'second', span: 1 },
  { id: '15s', secs: 15, type: 'second', span: 15 },
  { id: '1m', secs: 60, type: 'minute', span: 1 },
  { id: '5m', secs: 300, type: 'minute', span: 5 },
  { id: '15m', secs: 900, type: 'minute', span: 15 },
  { id: '1h', secs: 3600, type: 'hour', span: 1 },
  { id: '4h', secs: 14400, type: 'hour', span: 4 },
  { id: 'D', secs: 86400, type: 'day', span: 1 },
];

/** The smallest timeframe that shows the whole span in about `bars` candles or fewer. */
export function pickPeriod(spanSecs, bars = 150) {
  return PERIODS.find((p) => spanSecs / p.secs <= bars) ?? PERIODS[PERIODS.length - 1];
}

/**
 * Candles over continuous time. A candle with no trades is flat at the last close, so the axis
 * tells the truth about how long nothing happened, and each candle opens where the last closed.
 * `valueOf` turns a price into what is charted (the price, or the market cap).
 */
export function fold(trades, { secs, valueOf, start, now, maxBars = 4000 }) {
  const size = secs * 1000;
  const floor = (t) => Math.floor(t / size) * size;
  const sorted = trades.slice().sort((a, b) => a.t - b.t);
  const firstT = sorted.length ? Math.min(start.t, sorted[0].t) : start.t;
  const lastT = Math.max(now, sorted.length ? sorted[sorted.length - 1].t : now, start.t);
  const end = floor(lastT);
  const begin = Math.max(floor(firstT), end - (maxBars - 1) * size);
  const capped = floor(firstT) < begin;
  const bars = [];
  let i = 0;
  let close = valueOf(start.price);
  for (; i < sorted.length && sorted[i].t < begin; i++) close = valueOf(sorted[i].price);
  for (let ts = begin; ts <= end; ts += size) {
    const bar = { timestamp: ts, open: close, high: close, low: close, close, volume: 0, tokens: 0, turnover: 0 };
    for (; i < sorted.length && sorted[i].t < ts + size; i++) {
      const x = sorted[i], v = valueOf(x.price);
      bar.high = Math.max(bar.high, v);
      bar.low = Math.min(bar.low, v);
      bar.close = v;
      bar.volume += x.quote;
      bar.tokens += x.tokens;
      bar.turnover += x.quote;
    }
    close = bar.close;
    bars.push(bar);
  }
  return { bars, capped };
}

/** What a stats panel shows for trades in the last `windowMs` (all of them if it is null). */
export function stats(trades, windowMs, now = Date.now()) {
  const from = windowMs == null ? -Infinity : now - windowMs;
  const inside = trades.filter((t) => t.t >= from);
  const before = trades.filter((t) => t.t < from).pop();
  const buys = inside.filter((t) => t.buy), sells = inside.filter((t) => !t.buy);
  const sum = (list) => list.reduce((a, t) => a + t.quote, 0);
  const firstPrice = before?.price ?? inside[0]?.price ?? null;
  const lastPrice = inside[inside.length - 1]?.price ?? firstPrice;
  return {
    buys: buys.length, sells: sells.length,
    buyVol: sum(buys), sellVol: sum(sells), volume: sum(inside),
    buyers: new Set(buys.map((t) => t.who)).size, sellers: new Set(sells.map((t) => t.who)).size,
    change: firstPrice ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0,
  };
}

/** Each account's position, worked out from its trades alone, biggest holder first. */
export function positions(trades, price, supply) {
  const by = new Map();
  for (const t of trades) {
    const p = by.get(t.who) ?? { who: t.who, tokens: 0, spent: 0, got: 0, trades: 0 };
    p.tokens += t.buy ? t.tokens : -t.tokens;
    if (t.buy) p.spent += t.quote; else p.got += t.quote;
    p.trades++;
    by.set(t.who, p);
  }
  return [...by.values()].map((p) => {
    const tokens = Math.max(0, p.tokens), value = tokens * price;
    return { ...p, tokens, value, share: supply ? (tokens / supply) * 100 : 0, pnl: p.got + value - p.spent };
  }).sort((a, b) => b.tokens - a.tokens || b.trades - a.trades);
}

const SUB = '₀₁₂₃₄₅₆₇₈₉';
const sub = (n) => String(n).split('').map((d) => SUB[d]).join('');

/** 0.000000006391 reads as 0.0₈6391: the small number is how many zeros follow the point. */
export function foldZeros(text) {
  const m = /^(-?0)\.(0{3,})(\d+)$/.exec(String(text));
  return m ? `${m[1]}.0${sub(m[2].length)}${m[3]}` : String(text);
}

export function fmtPrice(n) {
  if (!n) return '0';
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  const zeros = Math.floor(-Math.log10(n));
  return foldZeros(n.toFixed(zeros + 4).replace(/0+$/, ''));
}

export function fmtCompact(n, dp) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${+(n / 1e3).toFixed(1)}K`;
  if (dp != null) return (+n.toFixed(dp)).toLocaleString();
  if (a >= 100) return (+n.toFixed(0)).toLocaleString();
  if (a >= 1) return String(+n.toFixed(2));
  if (a === 0) return '0';
  return String(+n.toPrecision(3));
}

export const pct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
export const short = (a) => (a.length > 20 ? `${a.slice(0, 9)}…${a.slice(-8)}` : a);

/** Digits after the point needed to show about three significant figures of the smallest value. */
export function precisionFor(values) {
  const least = values.filter((v) => v > 0).reduce((a, b) => Math.min(a, b), Infinity);
  if (!isFinite(least) || least >= 100) return 2;
  return Math.min(16, Math.max(2, Math.ceil(-Math.log10(least)) + 2));
}
