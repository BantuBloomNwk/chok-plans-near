// One command for anyone checking this entry: builds from clean, runs every test, checks every claim
// in the README against testnet, and builds the page. It prints PASS or FAIL for each step and a table
// at the end. Read only on chain: it sends no transactions and needs no keys.
//
//   npm run judge            everything (about 10 minutes, most of it the Rust build)
//   npm run judge -- --quick skip the build and the Rust tests (about 1 minute)
//
// With NEAR_AI_KEY set, verify also attests the agent's model.
import { spawn } from 'child_process';
import fs from 'fs';
import { execSync } from 'child_process';
// what git says before anything is built, so the build is judged by what it changes
const before = (() => { try { return execSync('git status --porcelain', { encoding: 'utf8' }); } catch { return ''; } })();

const quick = process.argv.includes('--quick');
const steps = [
  !quick && { name: 'Build from clean (token, contracts, judge)', cmd: ['npm', 'run', 'build'], note: (o) => (o.match(/^[0-9a-f]{64} \S+$/gm) || []).map((l) => `${l.slice(65)} ${l.slice(0, 12)}…`).join(', ') },
  !quick && { name: 'The build changes no tracked file', cmd: ['git', 'status', '--porcelain'], check: (o) => o === before, note: (o) => (o === before ? 'git status is the same as before the build' : o.split('\n').filter((l) => !before.includes(l)).slice(0, 3).join('; ')) },
  !quick && { name: 'Contract tests (plan, market, launcher)', cmd: ['cargo', 'test', '-q', '-p', 'plan', '-p', 'market', '-p', 'launcher'], note: counts },
  !quick && { name: 'Judge tests', cmd: ['cargo', 'test', '-q', '--manifest-path', 'judge/Cargo.toml'], note: counts },
  { name: 'Chart tests', cmd: ['node', '--test', 'web/src/terminal/data.test.mjs'], note: (o) => (o.match(/# pass (\d+)/) ? `${o.match(/# pass (\d+)/)[1]} passed` : '') },
  { name: 'Every README claim against testnet (npm run verify)', cmd: ['node', 'scripts/verify.mjs'], note: (o) => (o.match(/\d+ passed, \d+ failed(, \d+ skipped)?/) || [''])[0] },
  fs.existsSync('web/node_modules') && { name: 'The page builds', cmd: ['npx', 'vite', 'build'], cwd: 'web', note: (o) => (o.match(/built in [^\n]+/) || [''])[0].trim() },
].filter(Boolean);

function counts(o) {
  const r = [...o.matchAll(/test result: (\w+)\. (\d+) passed; (\d+) failed/g)];
  const p = r.reduce((a, m) => a + Number(m[2]), 0), f = r.reduce((a, m) => a + Number(m[3]), 0);
  return r.length ? `${p} passed, ${f} failed` : '';
}
const run = (s) => new Promise((done) => {
  const t0 = Date.now(), p = spawn(s.cmd[0], s.cmd.slice(1), { cwd: s.cwd || process.cwd(), env: process.env });
  let out = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => done({ ok: code === 0 && (!s.check || s.check(out)), secs: Math.round((Date.now() - t0) / 1000), out }));
});

const rows = [];
for (const s of steps) {
  const r = await run(s);
  const note = s.note ? s.note(r.out) : '';
  rows.push({ step: s.name, result: r.ok ? 'PASS' : 'FAIL', time: `${r.secs}s`, detail: note });
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${s.name}${note ? `  (${note})` : ''}`);
  if (!r.ok) console.log(r.out.split('\n').slice(-25).map((l) => `      ${l}`).join('\n'));
}
const w = (k) => Math.max(k.length, ...rows.map((r) => r[k].length));
const line = (r) => `| ${['step', 'result', 'time', 'detail'].map((k) => r[k].padEnd(w(k))).join(' | ')} |`;
console.log(`\n${line({ step: 'step', result: 'result', time: 'time', detail: 'detail' })}\n|${['step', 'result', 'time', 'detail'].map((k) => '-'.repeat(w(k) + 2)).join('|')}|\n${rows.map(line).join('\n')}`);
const failed = rows.filter((r) => r.result === 'FAIL').length;
console.log(`\n${failed ? `${failed} step(s) FAILED` : 'Every step passed.'}${quick ? ' (quick: build and Rust tests skipped)' : ''}`);
process.exit(failed ? 1 : 0);
