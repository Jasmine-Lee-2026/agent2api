// Tests for this round: balanced-brace envelope recovery (unit) and .env
// credential hot-reload (end-to-end on a scratch instance).
// The E2E part edits the developer's real .env (backup/restore around it) and
// needs live upstream cookies - it is skipped when .env does not exist.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};

// ---- Unit: _parseToolCall recovery paths ------------------------------------
const { Upstream } = await import('../src/upstream.js');
const u = new Upstream();

const cases = [
  ['plain envelope', '{"tool_call":{"name":"t1","arguments":{"a":1}}}', 't1'],
  ['fenced envelope', '```json\n{"tool_call":{"name":"t1","arguments":{"a":1}}}\n```', 't1'],
  ['prose before', 'Sure, let me check that.\n{"tool_call":{"name":"t1","arguments":{"a":1}}}', 't1'],
  ['prose after', '{"tool_call":{"name":"t1","arguments":{"a":1}}}\nLet me know if you need more.', 't1'],
  ['braces inside strings', '{"tool_call":{"name":"t1","arguments":{"code":"function f() { return 1; }"}}}', 't1'],
  ['nested objects', '{"tool_call":{"name":"t1","arguments":{"opts":{"deep":{"x":1}}}}}', 't1'],
  ['multi-call array', '{"tool_calls":[{"name":"a","arguments":{}},{"name":"b","arguments":{}}]}', 'a'],
];
for (const [name, text, expect] of cases) {
  const calls = u._parseToolCall(text);
  check(`unit: ${name}`, Array.isArray(calls) && calls[0]?.name === expect, JSON.stringify(calls)?.slice(0, 60));
}
check('unit: no JSON -> null', u._parseToolCall('just a plain sentence, nothing else') === null, 'should be null');
check('unit: balanced-but-not-envelope -> null', u._parseToolCall('result: {"answer": 42} end') === null, 'non-envelope JSON must stay content');
check('unit: unbalanced -> null', u._parseToolCall('{"tool_call": {"name": "t1"') === null, 'truncated JSON must not fake a call');

// ---- E2E: credential hot reload ----------------------------------------------
// Needs a configured .env (with real upstream cookies) because R2 does a live
// chat call. On a fresh clone there is no .env - skip the E2E, keep unit green.
const root = process.cwd();
if (!fs.existsSync(`${root}/.env`)) {
  console.log('SKIP e2e hot-reload: no .env configured (fresh clone). Unit section already passed.');
  console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
const envBackup = fs.readFileSync(`${root}/.env`, 'utf8');
// The real .env already contains PORT=9317; config.js honors the FIRST
// occurrence, so rebuild the file with PORT forced, never append a second one.
const envWithPort = (txt, port) => `${txt.replace(/^PORT\s*=.*$/m, `PORT=${port}`)}\n`;
const port = 9327;
try {
  fs.writeFileSync(`${root}/.env`, envWithPort(envBackup, port));
  // This test process imported src/config.js earlier (unit section), which put
  // PORT/HOST from the real .env into our own env; strip them so the child
  // reads them fresh from the scratch .env instead of inheriting 9317.
  const childEnv = { ...process.env };
  delete childEnv.PORT;
  delete childEnv.HOST;
  const child = spawn(process.execPath, ['src/index.js'], { cwd: root, stdio: 'ignore', detached: false, env: childEnv });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Wait until the scratch instance accepts connections (cold Node start can be slow).
  let up = false;
  for (let i = 0; i < 20 && !up; i++) {
    await wait(500);
    up = await fetch(`http://127.0.0.1:${port}/health`).then(() => true).catch(() => false);
  }
  if (!up) throw new Error('scratch instance never came up');

  // R1: with an INVALID token in .env, chat must 401 (proves the bad value is live).
  fs.writeFileSync(`${root}/.env`, envWithPort('CFTK=invalid-hot-test\n', port));
  await wait(300);
  let r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'any-model', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const j1 = await r.json().catch(() => ({}));
  check('reload: bad cftk live -> 401', r.status === 401, `code=${r.status} msg=${String(j1?.error?.message).slice(0, 80)}`);

  // R2: write back the good cftk WITHOUT restart -> chat must succeed.
  fs.writeFileSync(`${root}/.env`, envWithPort(envBackup, port));
  await wait(300);
  r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'any-model', stream: false, messages: [{ role: 'user', content: 'reply with exactly one word: ok' }] }),
  });
  const j2 = await r.json().catch(() => null);
  check('reload: fixed cftk live without restart', r.status === 200 && !!j2?.choices?.[0]?.message?.content, `code=${r.status}`);

  // R3: mid-write guard - empty CFTK in .env keeps the previous value (no 401).
  fs.writeFileSync(`${root}/.env`, envWithPort('CFTK=\n', port));
  await wait(300);
  r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'any-model', stream: false, messages: [{ role: 'user', content: 'reply ok' }] }),
  });
  check('reload: empty-cftk mid-write guard keeps old value', r.status !== 401, `code=${r.status}`);

  child.kill();
} finally {
  fs.writeFileSync(`${root}/.env`, envBackup);
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
