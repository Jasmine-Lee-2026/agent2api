// Tests for the hardening changes: crash.log append/truncate branches and the
// non-loopbind warning. Uses real code paths via process.emit('uncaughtException').
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const root = process.cwd();
const crashLog = `${root}/run/crash.log`;
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};

// T1: small crash.log -> appended.
fs.writeFileSync(crashLog, 'seed-line-1\n');
spawnSync(process.execPath, ['--input-type=module', '-e',
  `import('./src/index.js').then(()=>process.emit('uncaughtException',new Error('crash-A')))`,
], { cwd: root, timeout: 15000, env: { ...process.env, PORT: '9324' } });
const t1 = fs.readFileSync(crashLog, 'utf8');
check('crash.log small -> append', t1.startsWith('seed-line-1\n') && t1.includes('crash-A'), JSON.stringify(t1.slice(0, 80)));

// T2: oversized crash.log (>1MB) -> rewritten, only the new entry survives.
fs.writeFileSync(crashLog, 'x'.repeat(1_500_000));
spawnSync(process.execPath, ['--input-type=module', '-e',
  `import('./src/index.js').then(()=>process.emit('uncaughtException',new Error('crash-B')))`,
], { cwd: root, timeout: 15000, env: { ...process.env, PORT: '9324' } });
const t2 = fs.readFileSync(crashLog, 'utf8');
check('crash.log >1MB -> truncated rewrite', t2.length < 100_000 && t2.includes('crash-B') && !t2.includes('xxxxxx'), `len=${t2.length}`);
fs.rmSync(crashLog, { force: true });

// T3: non-loopback HOST -> bind warning present.
const r3 = spawnSync(process.execPath, ['src/index.js'], {
  cwd: root, timeout: 8000, encoding: 'utf8',
  env: { ...process.env, PORT: '9325', HOST: '0.0.0.0' },
});
const out3 = `${r3.stdout || ''}${r3.stderr || ''}`;
check('non-loopback host warns', out3.includes('NOT loopback') && out3.includes('0.0.0.0'), out3.slice(0, 200).replace(/\n/g, ' '));

// T4: loopback default -> no BIND warning. (On a fresh clone there is no .env,
// so the "upstream not configured" warning is expected and must not count.)
const r4 = spawnSync(process.execPath, ['src/index.js'], {
  cwd: root, timeout: 8000, encoding: 'utf8',
  env: { ...process.env, PORT: '9326' },
});
const out4 = `${r4.stdout || ''}${r4.stderr || ''}`;
check('loopback host no bind warning', out4.includes('running') && !out4.includes('NOT loopback'), out4.slice(0, 120).replace(/\n/g, ' '));

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
