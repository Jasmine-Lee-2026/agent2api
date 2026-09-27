import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { config } from './config.js';
import { createServer } from './openai.js';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

const crashLog = path.join(root, 'run', 'crash.log');

// Never die silently: log the full stack to stderr AND a file, keep serving.
function logCrash(kind, e) {
  const msg = `${new Date().toISOString()} [${kind}] ${e?.stack || e}\n`;
  console.error(msg);
  // Absolute path: the launcher sets CWD, but a manual start from elsewhere
  // must not lose crash logs. Cap at 1MB so a crash loop cannot fill the disk.
  try {
    // Ensure the parent dir exists: on a fresh clone run/ is gitignored away,
    // and writeFileSync would otherwise silently lose the first crash.
    fs.mkdirSync(path.dirname(crashLog), { recursive: true });
    if (!fs.existsSync(crashLog) || fs.statSync(crashLog).size > 1_000_000) {
      fs.writeFileSync(crashLog, msg);
    } else {
      fs.appendFileSync(crashLog, msg);
    }
  } catch { /* ignore */
  }
}
process.on('uncaughtException', (e) => logCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e));

const server = createServer();

// A closed stdout pipe (detached/hidden launcher) must not crash the server.
process.stdout?.on?.('error', (e) => {
  if (e?.code === 'EPIPE') return;
  throw e;
});
process.stderr?.on?.('error', (e) => {
  if (e?.code === 'EPIPE') return;
  throw e;
});
server.listen(config.port, config.host, () => {
  const base = `http://${config.host}:${config.port}`;
  console.log(`agent2api running`);
  console.log(`  client base URL: ${base}/v1`);
  console.log(`  client API key : ${config.apiKey ? 'loaded' : 'NOT SET (auth disabled)'}`);
  console.log(`  upstream       : ${config.upstreamBase || 'NOT CONFIGURED'}`);
  console.log(`  cookies        : ${config.cftk ? 'loaded' : 'MISSING -> set CFTK / SESSION_ID in .env'}`);
  if (!config.upstreamBase || !config.epMessages) {
    console.warn('  WARNING: upstream endpoints are not configured. Fill .env from your own packet capture - see PROTOCOL.md.');
  }
  if (!['127.0.0.1', '::1', 'localhost'].includes(String(config.host).toLowerCase())) {
    console.warn(`  WARNING: bound to ${config.host}, NOT loopback. Anyone on the network can reach this proxy with your upstream cookies behind it.`);
  }
});
