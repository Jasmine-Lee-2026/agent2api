import http from 'node:http';
import { config, reloadCredentials } from './config.js';
import { Upstream, UpstreamError } from './upstream.js';
import { sseWrite } from './sse.js';

const upstream = new Upstream();

const nowSec = () => Math.floor(Date.now() / 1000);
const rid = (p) => p + Math.random().toString(36).slice(2, 12);

function log(...args) {
  // Console can throw EPIPE when our stdout pipe is closed (e.g. detached
  // launcher); logging must never take a request down with it.
  try {
    console.log(new Date().toISOString(), ...args);
  } catch { /* ignore */ }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return; // drain and discard so the 413 can still be sent
      chunks.push(c);
      len += c.length;
      if (len > 20_000_000) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error('payload too large (max 20MB)'), { status: 413 }));
      }
    });
    req.on('end', () => {
      if (tooLarge) return; // 413 already rejected
      if (!chunks.length) return resolve({});
      // Decode once from the full buffer: string-concat per chunk would split
      // multi-byte UTF-8 characters across chunk boundaries.
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(Object.assign(new Error(`invalid JSON body: ${e.message}`), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function checkAuth(req, res) {
  const expect = config.apiKey;
  if (!expect) return true; // auth disabled
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== expect) {
    sendJSON(res, 401, { error: { message: 'invalid API key (expect "Authorization: Bearer <API_KEY>")', type: 'authentication_error', code: 401 } });
    return false;
  }
  return true;
}

async function handleModels(req, res) {
  if (!checkAuth(req, res)) return;
  const models = await upstream.listModels();
  sendJSON(res, 200, { object: 'list', data: models });
}

async function handleChat(req, res) {
  // Pick up cookie edits from .env without a restart (mtime check, one stat
  // per request - negligible next to the multi-second upstream call).
  reloadCredentials();
  const abort = new AbortController();
  let finished = false;
  // Stop burning upstream tokens when the client goes away mid-request.
  // NOTE: `req` 'close' fires as soon as the body is consumed on modern Node,
  // which would abort every request instantly - must listen on `res` instead.
  res.on('close', () => {
    if (!finished) abort.abort(new Error('client disconnected'));
  });

  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    const status = Number(e.status) || 400;
    return sendJSON(res, status, { error: { message: e.message, type: 'invalid_request_error', code: status } });
  }

  const model = body.model || config.defaultModel || 'default';
  // Reject invalid requests before touching upstream.
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendJSON(res, 400, {
      error: { message: 'messages must be a non-empty array', type: 'invalid_request_error', code: 400 },
    });
  }
  // OpenAI default is non-streaming; only stream when explicitly requested.
  const wantStream = body.stream === true;
  const started = Date.now();

  try {
    const created = nowSec();
    const cid = rid('chatcmpl-');

    if (wantStream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      sseWrite(res, {
        id: cid, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });

      let finishEmitted = false;
      let usage = null;
      for await (const delta of upstream.chatStream({ ...body, model }, { signal: abort.signal })) {
        if (delta.usage) usage = delta.usage;
        const choice = { index: 0, delta: {}, finish_reason: null };
        if (delta.role) choice.delta.role = delta.role;
        if (delta.content) choice.delta.content = delta.content;
        if (delta.tool_calls) choice.delta.tool_calls = delta.tool_calls;
        if (delta.finish_reason) {
          choice.finish_reason = delta.finish_reason;
          finishEmitted = true;
        }
        sseWrite(res, { id: cid, object: 'chat.completion.chunk', created, model, choices: [choice] });
      }

      if (!finishEmitted) {
        sseWrite(res, {
          id: cid, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
      }
      if (body.stream_options?.include_usage && usage) {
        sseWrite(res, { id: cid, object: 'chat.completion.chunk', created, model, choices: [], usage });
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Non-streaming aggregation.
    let content = '';
    const toolCalls = [];
    let finish = 'stop';
    let usage = null;
    for await (const delta of upstream.chatStream({ ...body, model }, { signal: abort.signal })) {
      if (delta.content) content += delta.content;
      if (delta.tool_calls) toolCalls.push(...delta.tool_calls);
      if (delta.finish_reason) finish = delta.finish_reason;
      if (delta.usage) usage = delta.usage;
    }
    const message = { role: 'assistant', content: content || null };
    if (toolCalls.length) message.tool_calls = toolCalls;
    sendJSON(res, 200, {
      id: rid('chatcmpl-'), object: 'chat.completion', created, model,
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (e) {
    const aborted = abort.signal.aborted;
    const status = aborted ? 499 : Number(e.status) || (e instanceof UpstreamError ? 502 : 500);
    if (!aborted) log('chat error:', status, String(e.message || e));
    if (res.headersSent) {
      if (!aborted) {
        try {
          sseWrite(res, { error: { message: String(e.message || e), type: e.name || 'error', code: status } });
          res.write('data: [DONE]\n\n');
        } catch { /* client gone */ }
      }
      res.end();
    } else if (!aborted) {
      sendJSON(res, status, { error: { message: String(e.message || e), type: e.name || 'error', code: status } });
    } else {
      try { res.end(); } catch { /* ignore */ }
    }
  } finally {
    finished = true;
    log('POST /v1/chat/completions', model, `${Date.now() - started}ms`);
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    log(req.method, u.pathname);
    try {
      if (req.method === 'GET' && u.pathname === '/health') {
        return sendJSON(res, 200, {
          status: 'ok',
          upstreamConfigured: Boolean(config.upstreamBase && config.epMessages),
          hasToken: Boolean(config.cftk),
        });
      }
      if (req.method === 'GET' && u.pathname === '/v1/models') return await handleModels(req, res);
      if (req.method === 'POST' && u.pathname === '/v1/chat/completions') return await handleChat(req, res);
      sendJSON(res, 404, { error: { message: `not found: ${u.pathname}`, type: 'invalid_request_error' } });
    } catch (e) {
      if (!res.headersSent) {
        try {
          sendJSON(res, 500, { error: { message: String(e.message || e), type: 'error' } });
        } catch { /* socket gone */ }
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    }
  });
}
