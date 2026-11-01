// node --test web/src/terminal/data.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fold, stats, positions, foldZeros, fmtPrice, pickPeriod, precisionFor } from './data.js';
import { sampleMarket } from './sample.js';

const t0 = 1_700_000_000_000 - (1_700_000_000_000 % 60_000);
const tr = (min, price, buy = true, who = 'a', quote = 1, tokens = 10) => ({ t: t0 + min * 60_000, price, buy, who, quote, tokens });
const opts = { secs: 60, valueOf: (p) => p, start: { t: t0, price: 1 }, now: t0 + 5 * 60_000 };

test('candles open where the last closed, and quiet minutes are flat', () => {
  const { bars } = fold([tr(0, 2), tr(0.5, 3), tr(3, 1.5, false)], opts);
  assert.equal(bars.length, 6);
  assert.deepEqual([bars[0].open, bars[0].high, bars[0].low, bars[0].close, bars[0].volume], [1, 3, 1, 3, 2]);
  assert.deepEqual([bars[1].open, bars[1].close, bars[1].volume], [3, 3, 0]);
  assert.deepEqual([bars[3].open, bars[3].low, bars[3].close], [3, 1.5, 1.5]);
  assert.equal(bars[5].close, 1.5);
});

test('a timeframe only regroups trades: volume and the last close never change', () => {
  const m = sampleMarket();
  const now = m.trades.at(-1).t + 1000;
  const total = m.trades.reduce((a, x) => a + x.quote, 0);
  for (const secs of [60, 300, 900, 3600, 14400, 86400]) {
    const { bars } = fold(m.trades, { secs, valueOf: (p) => p, start: m.start, now });
    assert.ok(Math.abs(bars.reduce((a, b) => a + b.volume, 0) - total) < 1e-9, `volume at ${secs}s`);
    assert.equal(bars.at(-1).close, m.trades.at(-1).price);
    for (const b of bars) assert.ok(b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close));
  }
});

test('market cap is the price times the supply, on every candle', () => {
  const { bars } = fold([tr(1, 2e-9)], { ...opts, valueOf: (p) => p * 1e9, start: { t: t0, price: 1e-9 } });
  assert.equal(bars.at(-1).close, 2);
  assert.equal(bars[0].open, 1);
});

test('a huge span at a tiny timeframe is capped, not a frozen tab', () => {
  const { bars, capped } = fold([], { secs: 1, valueOf: (p) => p, start: { t: t0, price: 1 }, now: t0 + 86_400_000, maxBars: 1000 });
  assert.equal(bars.length, 1000);
  assert.equal(capped, true);
});

test('stats count each side and each wallet once', () => {
  const s = stats([tr(0, 1, true, 'a', 2), tr(1, 2, true, 'a', 3), tr(2, 1, false, 'b', 1)], null);
  assert.deepEqual([s.buys, s.sells, s.buyVol, s.sellVol, s.buyers, s.sellers, s.change], [2, 1, 5, 1, 1, 1, 0]);
});

test('stats change compares with the last price before the window', () => {
  const now = t0 + 120 * 60_000;
  const s = stats([tr(0, 1), tr(119, 3)], 3_600_000, now);
  assert.equal(s.change, 200);
});

test('positions work out profit from what was spent, got and still held', () => {
  const [a] = positions([tr(0, 1, true, 'a', 10, 100), tr(1, 1, false, 'a', 6, 40)], 0.2, 1000);
  assert.equal(a.tokens, 60);
  assert.equal(a.share, 6);
  assert.ok(Math.abs(a.pnl - (6 + 12 - 10)) < 1e-9);
});

test('prices fold their zeros and count them right', () => {
  assert.equal(foldZeros('0.000000006391'), '0.0₈6391');
  assert.equal(foldZeros('0.0123'), '0.0123');
  assert.equal(fmtPrice(6.391e-9), '0.0₈6391');
  assert.equal(pickPeriod(3600).id, '1m');
  assert.equal(precisionFor([6.39e-9]), 11);
  assert.equal(precisionFor([3]), 2);
  assert.equal(foldZeros('90.000'), '90.000');
});
