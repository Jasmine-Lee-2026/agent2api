// Smoke test for the public tree: unit-tests the envelope parser without
// needing a configured .env (no network calls).
import { Upstream } from '../src/upstream.js';

const u = new Upstream();
const cases = [
  ['plain envelope', '{"tool_call":{"name":"t1","arguments":{"a":1}}}', 't1'],
  ['prose before', 'Sure.\n{"tool_call":{"name":"t1","arguments":{"a":1}}}', 't1'],
  ['fenced envelope', '```json\n{"tool_call":{"name":"t1","arguments":{"a":1}}}\n```', 't1'],
  ['braces in strings', '{"tool_call":{"name":"t1","arguments":{"code":"function f() { return 1; }"}}}', 't1'],
  ['multi-call', '{"tool_calls":[{"name":"a","arguments":{}},{"name":"b","arguments":{}}]}', 'a'],
  ['non-envelope JSON stays content', 'result: {"answer": 42} end', null],
  ['truncated JSON rejected', '{"tool_call":{"name":"t1"', null],
  ['plain sentence null', 'just a plain sentence', null],
];

let pass = 0, fail = 0;
for (const [name, text, expect] of cases) {
  const calls = u._parseToolCall(text);
  const got = calls?.[0]?.name ?? null;
  if (got === expect) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} :: got=${JSON.stringify(got)} want=${JSON.stringify(expect)}`); }
}

// config defaults: nothing configured, no crash on import
const { config } = await import('../src/config.js');
if (!config.upstreamBase && !config.epMessages && config.cftk === '') { pass++; console.log('PASS config: fresh clone = all capture fields empty'); }
else { fail++; console.log(`FAIL config: base=${config.upstreamBase} ep=${config.epMessages}`); }

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
