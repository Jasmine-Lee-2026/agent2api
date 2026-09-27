import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Minimal .env loader (zero dependencies).
function loadDotEnv() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

loadDotEnv();

// All vendor-specific "magic values" (endpoint paths, cookie names, magic
// headers, the agent id) live here instead of being hardcoded anywhere else.
// Capture your own values from real browser traffic - see PROTOCOL.md.
export const config = {
  port: Number(process.env.PORT || 9317),
  host: process.env.HOST || '127.0.0.1',
  apiKey: process.env.API_KEY || '',
  defaultModel: process.env.DEFAULT_MODEL || '',

  // --- captured-from-traffic settings (fill from your own packet capture) ---
  upstreamBase: process.env.UPSTREAM_BASE || '',
  cftk: process.env.CFTK || '',
  sessionId: process.env.SESSION_ID || '',
  // Cookie names for the two auth cookies.
  cookieCftk: process.env.COOKIE_CFTK_NAME || '',
  cookieSession: process.env.COOKIE_SESSION_NAME || '',
  // Header name/value carrying the CSRF-style token (empty disables the header,
  // the cookie half is always sent).
  tokenHeader: process.env.TOKEN_HEADER_NAME || '',
  // Messages endpoint, session endpoints, model-list endpoints (paths only;
  // UPSTREAM_BASE is prefixed). {id} is replaced with the session id.
  epSession: process.env.EP_SESSION_CREATE || '',
  epSessionDelete: process.env.EP_SESSION_DELETE || '/{id}',
  epMessages: process.env.EP_MESSAGES || '',
  epAgentModels: process.env.EP_AGENT_MODELS || '',
  epBenefitModels: process.env.EP_BENEFIT_MODELS || '',
  epLegacyModels: process.env.EP_LEGACY_MODELS || '',
  // agent_id query value for the agent model list (if the endpoint needs one).
  agentId: process.env.AGENT_ID || '',
  // Extra headers: "Name: value" pairs separated by | or newlines.
  // One set for session/messages calls, one for model-list calls.
  headersChat: parseHeaderList(process.env.HEADERS_CHAT || ''),
  headersList: parseHeaderList(process.env.HEADERS_LIST || ''),
  // Benefit-channel marker header, e.g. "X-Channel: free". Empty = no marker.
  benefitHeader: parseHeaderList(process.env.BENEFIT_HEADER || ''),
  // Models routed through the free-benefit gateway (comma separated ids).
  benefitModels: (process.env.BENEFIT_MODELS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
};

function parseHeaderList(s) {
  const out = {};
  for (const part of s.split(/\||\n/)) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

// Hot-reload of expiring credentials (CFTK / SESSION_ID): the .env file is
// re-read when its mtime changes, so a fresh cookie from the browser takes
// effect on the next request without a restart. A read yielding an empty CFTK
// (file mid-write) keeps the previous value instead of wiping auth.
const envPath = path.join(root, '.env');
const RELOAD_KEYS = ['CFTK', 'SESSION_ID', 'UPSTREAM_BASE', 'DEFAULT_MODEL'];
let lastMtime = 0;
try { lastMtime = fs.existsSync(envPath) ? fs.statSync(envPath).mtimeMs : 0; } catch { /* ignore */ }

export function reloadCredentials() {
  try {
    const mtime = fs.statSync(envPath).mtimeMs;
    if (mtime === lastMtime) return false;
    lastMtime = mtime;
    // Mid-write guard: a read that yields empty credentials (file being
    // rewritten) keeps BOTH previous values - losing either cookie breaks auth.
    const saved = {};
    for (const k of RELOAD_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    loadDotEnv();
    if (!process.env.CFTK) process.env.CFTK = saved.CFTK;
    if (!process.env.SESSION_ID) process.env.SESSION_ID = saved.SESSION_ID;
    config.cftk = process.env.CFTK || '';
    config.sessionId = process.env.SESSION_ID || '';
    config.upstreamBase = process.env.UPSTREAM_BASE || config.upstreamBase;
    config.defaultModel = process.env.DEFAULT_MODEL || config.defaultModel;
    return true;
  } catch {
    return false;
  }
}
