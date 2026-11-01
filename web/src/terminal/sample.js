// Made-up trades for looking at the terminal at full density, used only with ?sample on the URL and
// labelled SAMPLE DATA on screen. Nothing here touches a chain. It walks the same constant-product
// curve the market contract uses (3 of the quote virtual, a quarter of the sale supply virtual).
export function sampleMarket(seedText = 'chok') {
  let seed = [...seedText].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const names = ['ada', 'bola', 'chidi', 'danfo', 'emeka', 'funke', 'gbenga', 'halima', 'ife', 'jide', 'kemi', 'lola', 'musa', 'ngozi', 'obi', 'pelumi', 'quadri', 'remi', 'sade', 'tunde', 'uche', 'wale', 'yemi', 'zainab'].map((n) => `${n}.testnet`);
  const dev = 'dandog-dev.testnet';
  const supply = 1_000_000_000, sale = 800_000_000;
  let x = 3, y = sale * 1.25;
  const now = Date.now(), start = now - 34 * 3_600_000;
  const trades = [], marks = [], held = new Map();
  let t = start, mood = 0.62, leg = 0;
  const trade = (buy, who, amount) => {
    if (buy) {
      const quote = amount, tokens = (y * quote) / (x + quote);
      x += quote; y -= tokens;
      held.set(who, (held.get(who) || 0) + tokens);
      trades.push({ t, buy, who, quote, tokens, price: x / y });
    } else {
      const tokens = amount, quote = (x * tokens) / (y + tokens);
      x -= quote; y += tokens;
      if (who !== dev) held.set(who, (held.get(who) || 0) - tokens);
      trades.push({ t, buy, who, quote, tokens, price: x / y });
    }
  };
  trade(true, dev, 0.15);
  for (let i = 0; i < 520; i++) {
    t += 30_000 + Math.floor(rnd() ** 2.4 * 900_000);
    if (t > now - 20_000) break;
    if (--leg <= 0) { mood = 0.3 + rnd() * 0.45; leg = 12 + Math.floor(rnd() * 40); }
    const who = names[Math.floor(rnd() * names.length)];
    const have = held.get(who) || 0;
    if (rnd() < mood || have <= 0) trade(true, who, 0.02 + rnd() ** 3 * 0.55);
    else trade(false, who, Math.min(have, have * (0.2 + rnd() * 0.8)));
    if (i % 90 === 45) {
      marks.push({ t, kind: 'released', label: 'PLAN +20M', note: 'The dev\'s plan let 20M out, under its public cap.' });
      t += 40_000;
      trade(false, dev, 6_000_000 + rnd() * 9_000_000);
    }
    if (i % 137 === 80) marks.push({ t, kind: 'busted', label: 'BUSTED', note: 'The dev asked for more than the cap. Refused, recorded, and the cap dropped 20%.' });
  }
  return { trades, marks, devs: new Set([dev]), supply, sale, start: { t: start, price: 3 / (sale * 1.25) }, token: 'sample', symbol: 'DANDOG', name: 'Danfo Dog (sample)' };
}
