// The agent's head: a model on NEAR AI Cloud, running in an attested TEE, turning what the
// visitor typed into tool calls. It holds no keys. Every tool call it makes is handed to act(),
// which signs with the agent's one function-call key, so the most an obedient (or fooled) model
// can do is ask. The plan contract and the sealed judge decide what actually happens.
//
// We show the visitor everything: the system prompt, each raw tool call, the result the chain
// gave back, the attestation checks and the signature on every answer.
import { attest, checkAnswer, BASE } from './attest.mjs';

export const MODEL = process.env.NEAR_AI_MODEL || 'deepseek-ai/DeepSeek-V4.1-Flash-1017';

export const SYSTEM = `You are an agent holding a token plan for a memecoin dev on NEAR testnet.
Do what the person asks, using the tools. You may call several tools, one after another.
Amounts are whole tokens. If they ask for everything, use the plan balance from read_plan.
Keep your last reply to one or two short sentences saying what happened.`;

export const TOOLS = [
  { name: 'read_plan', description: 'Read the plan: balance, public cap per period, releases and busts so far.', parameters: { type: 'object', properties: {} } },
  { name: 'request_release', description: 'Ask the plan contract to release tokens to the dev.', parameters: { type: 'object', properties: { amount: { type: 'number', description: 'whole tokens' } }, required: ['amount'] } },
  { name: 'send_tokens', description: 'Send tokens from the agent account to any account.', parameters: { type: 'object', properties: { to: { type: 'string' }, amount: { type: 'number' } }, required: ['to', 'amount'] } },
  { name: 'propose_loosen', description: 'Propose a higher cap on the plan.', parameters: { type: 'object', properties: { cap: { type: 'number', description: 'whole tokens per period' } }, required: ['cap'] } },
].map((f) => ({ type: 'function', function: f }));

let cached = null;
export async function attestation(key) {
  // a fresh nonce every ten minutes is plenty for a demo; every answer is still signature-checked
  if (!cached || Date.now() - cached.at > 600_000) cached = { at: Date.now(), result: await attest(MODEL, key) };
  return cached.result;
}

// readPlan() returns the plan as the tools should see it; act(x) runs one {kind, ...} and returns its result
export async function think({ key, text, readPlan, act, maxActions = 5, force = null }) {
  const att = await attestation(key);
  if (!att.passed) throw new Error('the model failed attestation, so the agent will not use it');
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: String(text).slice(0, 600) }];
  const steps = [], answers = [];
  for (let round = 0; round < 6; round++) {
    // `force` makes the first call that tool: a model that's been fully taken over, which is what the key
    // is there to stop. The call is still the model's own, signed by its TEE.
    const requestBody = JSON.stringify({ model: MODEL, messages, tools: TOOLS, temperature: 0, max_tokens: 2500, ...(force && round === 0 ? { tool_choice: { type: 'function', function: { name: force } } } : {}) });
    const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: requestBody });
    const responseText = await r.text();
    if (!r.ok) throw new Error(`NEAR AI ${r.status}: ${responseText.slice(0, 160)}`);
    const out = JSON.parse(responseText);
    answers.push({ chatId: out.id, ...(await checkAnswer({ model: MODEL, key, chatId: out.id, requestBody, responseText, signers: att.signers, gateway: att.gateway })) });
    const msg = out.choices[0].message;
    if (process.env.BRAIN_DEBUG) console.error(JSON.stringify(out.choices[0]).slice(0, 800));
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
    if (!msg.tool_calls?.length) return { forced: !!force, model: MODEL, system: SYSTEM, steps, reply: msg.content || (out.choices[0].finish_reason === 'length' ? '(ran out of room to answer)' : ''), attestation: att, answers };
    for (const tc of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
      let result;
      if (tc.function.name === 'read_plan') result = await readPlan();
      else if (steps.filter((s) => s.call.name !== 'read_plan').length >= maxActions) result = { outcome: 'skipped', why: 'action limit for one message' };
      else if (tc.function.name === 'request_release') result = await act({ kind: 'release', amount: Number(args.amount) || 0 });
      else if (tc.function.name === 'send_tokens') result = await act({ kind: 'transfer', to: String(args.to || ''), amount: Number(args.amount) || 0 });
      else if (tc.function.name === 'propose_loosen') result = await act({ kind: 'loosen', cap: Number(args.cap) || 0 });
      else result = { outcome: 'no such tool' };
      steps.push({ call: { name: tc.function.name, arguments: args }, result });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return { forced: !!force, model: MODEL, system: SYSTEM, steps, reply: '(stopped after six rounds)', attestation: att, answers };
}
