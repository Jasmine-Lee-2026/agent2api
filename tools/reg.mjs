// One-shot regression for the proxy. Usage: node tools/reg.mjs [port] [apikey]
// Defaults read PORT / API_KEY from the service .env when available.
// 9317 is only the .env.example default port, not a vendor value.
import { readFileSync } from 'node:fs';
let defPort = '9317';
let defKey = '';
try {
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  defPort = env.match(/^PORT\s*=\s*(\d+)/m)?.[1] || defPort;
  defKey = env.match(/^API_KEY\s*=\s*(\S+)/m)?.[1] || defKey;
} catch { /* defaults */ }
const port = process.argv[2] || defPort;
const key = process.argv[3] || defKey;
const base = `http://127.0.0.1:${port}`;
const H = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
}

async function models() {
  const r = await fetch(`${base}/v1/models`, { headers: H });
  const j = await r.json().catch(() => null);
  check('models', r.status === 200 && Array.isArray(j?.data) && j.data.length >= 1,
    `status=${r.status} n=${j?.data?.length}`);
  return j?.data?.map((m) => m.id) || [];
}

async function chat(name, payload, expect) {
  const t0 = Date.now();
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify(payload) });
  const ms = Date.now() - t0;
  if (expect) { check(name, r.status === expect, `status=${r.status}`); return null; }
  const ct = r.headers.get('content-type') || '';
  let msg = null;
  let raw = '';
  if (ct.includes('text/event-stream')) {
    raw = await r.text();
    // aggregate streamed deltas into a pseudo-message
    let content = '';
    let toolCalls = [];
    let finish = null;
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
      try {
        const j = JSON.parse(line.slice(6));
        const c = j?.choices?.[0];
        if (c?.delta?.content) content += c.delta.content;
        if (c?.delta?.tool_calls) toolCalls.push(...c.delta.tool_calls);
        if (c?.finish_reason) finish = c.finish_reason;
      } catch { /* ignore */ }
    }
    msg = { content, tool_calls: toolCalls.length ? toolCalls : undefined };
    raw = finish ? '' : raw;
  } else {
    const j = await r.json().catch(() => null);
    msg = j?.choices?.[0]?.message;
    raw = j ? '' : `unparseable body`;
  }
  const text = msg?.content || '';
  const ok = r.status === 200 && (text.length > 0 || msg?.tool_calls?.length);
  check(name, ok, `status=${r.status} ms=${ms} body=${(text || raw).slice(0, 200)}`);
  console.log(`  -> [${payload.model}] ${ms}ms ${msg?.tool_calls ? 'tool_calls: ' + msg.tool_calls.map((t) => t.function?.name).join(',') : text.slice(0, 60).replace(/\n/g, ' ')}`);
  return msg;
}

const modelList = await models();

// error paths
await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer wrong' } })
  .then((r) => check('401 wrong key', r.status === 401, `status=${r.status}`));
await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: H, body: '{bad' })
  .then((r) => check('400 bad json', r.status === 400, `status=${r.status}`));
await fetch(`${base}/nope`, { headers: H })
  .then((r) => check('404', r.status === 404, `status=${r.status}`));

// plain chat: first listed model non-streaming, second (if any) streaming
const m1 = modelList[0];
if (!m1) {
  console.log('FAIL no models returned; upstream not configured?');
  process.exit(1);
}
await chat(`plain ${m1} (stream=false)`, { model: m1, stream: false, messages: [{ role: 'user', content: 'reply with exactly one word: ok' }] });

const m2 = modelList.find((m) => m !== m1);
if (m2) {
  await chat(`plain ${m2} (stream=true)`, { model: m2, stream: true, messages: [{ role: 'user', content: 'reply with exactly one word: ok' }] });
}

// tool round-trip on the first model
const tools = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
}];
const t1 = await chat('tool T1', {
  model: m1, stream: false, tools,
  messages: [{ role: 'user', content: 'What is the weather in Hangzhou today? You MUST use the tool to check.' }],
});
if (t1?.tool_calls?.length) {
  const tc = t1.tool_calls[0];
  await chat('tool T2', {
    model: m1, stream: false, tools,
    messages: [
      { role: 'user', content: 'What is the weather in Hangzhou today? You MUST use the tool to check.' },
      { role: 'assistant', content: t1.content || null, tool_calls: t1.tool_calls },
      { role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify({ city: 'Hangzhou', temp: '26C', cond: 'cloudy' }) },
    ],
  });
} else {
  check('tool T1 produced tool_calls', false, 'no tool_calls in T1');
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
