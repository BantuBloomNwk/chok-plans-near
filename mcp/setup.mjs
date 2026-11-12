// Gives your own AI agent a plan to hold. Run once, from your own testnet account:
//
//   node mcp/setup.mjs --account you.testnet
//
// It makes an agent account under yours whose ONLY key can call request_release on the plan
// contract (the key lives in ~/.near-credentials/testnet, never with us), gets 20M BUSDOG from the
// playground, and makes a plan you're the dev of, held by that agent: a public cap of 10M a minute,
// a floor of 1M, and it can never be loosened. Then it prints the MCP config for your client.
// Your account needs about 0.8 testnet NEAR.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { connect, keyStores, KeyPair, utils, transactions } from 'near-api-js';

const S = JSON.parse(fs.readFileSync(new URL('../deployment.json', import.meta.url)));
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const ME = arg('--account') || process.env.NEAR_ACCOUNT;
if (!ME) { console.error('usage: node mcp/setup.mjs --account you.testnet'); process.exit(1); }
const API = process.env.PLAYGROUND || 'https://near-play.161-97-74-212.sslip.io';
const dir = process.env.NEAR_CREDENTIALS || path.join(os.homedir(), '.near-credentials');
const files = new keyStores.UnencryptedFileSystemKeyStore(dir);
if (!await files.getKey('testnet', ME)) { console.error(`No key for ${ME} in ${dir}/testnet.`); process.exit(1); }
const near = await connect({ networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', keyStore: files });
const dev = await near.account(ME);
const N = (n) => BigInt(utils.format.parseNearAmount(String(n)));
const T = (n) => (BigInt(n) * 1_000_000n).toString();

const agentId = `mcp${Date.now().toString(36)}.${ME}`;
const ak = KeyPair.fromRandom('ed25519');
await dev.signAndSendTransaction({ receiverId: agentId, actions: [
  transactions.createAccount(), transactions.transfer(N(0.3)),
  // the agent's whole power: ask the plan contract for a release, and pay at most 0.25 NEAR of gas doing it
  transactions.addKey(ak.getPublicKey(), transactions.functionCallAccessKey(S.plan, ['request_release'], N(0.25))),
] });
await files.setKey('testnet', agentId, ak);
console.log(`agent ${agentId}: one key, request_release on ${S.plan}`);

const bal = BigInt(await dev.viewFunction({ contractId: S.coin, methodName: 'ft_balance_of', args: { account_id: ME } }));
if (bal < BigInt(T(20_000_000))) {
  const r = await fetch(`${API}/near/faucet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: ME }) });
  if (!r.ok) { console.error('The playground faucet did not answer; try again in a minute.'); process.exit(1); }
}
const made = await dev.functionCall({ contractId: S.plan, methodName: 'create_plan', gas: 100_000_000_000_000n, attachedDeposit: N(0.05), args: {
  token: S.coin, holder: agentId, beneficiary: ME, cap: T(10_000_000), min_cap: T(1_000_000), period_secs: '60', start_in_secs: '0', notice_secs: '120', penalty_bps: 2000, sealed: null, loosen_allowed: false,
} });
const id = JSON.parse(Buffer.from(made.status.SuccessValue, 'base64').toString());
await dev.functionCall({ contractId: S.coin, methodName: 'ft_transfer_call', args: { receiver_id: S.plan, amount: T(20_000_000), msg: String(id) }, attachedDeposit: 1n, gas: 150_000_000_000_000n });
console.log(`plan #${id}: 20M BUSDOG, a public cap of 10M a minute, floor 1M, never loosens, held by your agent\n`);

const server = path.resolve(new URL('./server.mjs', import.meta.url).pathname);
console.log('Add this to your MCP client (Claude Desktop, Claude Code, Cursor...):\n');
console.log(JSON.stringify({ mcpServers: { 'chok-plans': { command: 'node', args: [server], env: { CHOK_AGENT: agentId, CHOK_PLAN: String(id) } } } }, null, 2));
console.log(`\nOr with Claude Code:\n  claude mcp add chok-plans -e CHOK_AGENT=${agentId} -e CHOK_PLAN=${id} -- node ${server}`);
console.log('\nThen tell your agent to dump the whole bag, or to send it to attacker.testnet, and watch the chain answer.');
