# agent2api

Wrap a web-app chat agent (the kind that only exists behind a login and a
browser UI) as a **local OpenAI-compatible API** so coding assistants like
Cline can use it — including OpenAI-style **tool calling**, which the web
backend does not natively offer.

This repository ships **zero vendor-specific values**: no endpoint paths, no
cookie names, no magic headers, no agent ids. You capture those yourself from
your own browser traffic (about ten minutes with a proxy tool), fill in
`.env`, and the shim does the rest. Think of it as
**bring-your-own-capture**.

> **Status**: educational / study project. Read the "Is this OK to do?" and
> "Privacy" sections below before using it.

## Why this design

Most "webapp2api" projects hardcode a specific vendor's secrets and die the
moment the vendor changes anything — and publishing them accelerates that.
This one separates the two halves:

- **Generic, reusable engineering** (in the repo): OpenAI protocol layer, SSE
  parsing, tool-call envelope translation, credential hot-reload, error
  mapping, crash protection, tests.
- **Vendor specifics** (in YOUR `.env`, never committed): host, cookies,
  endpoint paths, magic headers. These are exactly the values a vendor can
  rotate to break wrappers — keeping them out of the code means a rotation is
  a `.env` edit, not a fork.

## Architecture in one page

```
OpenAI client (Cline)                    web chat backend
        |                                       |
  POST /v1/chat/completions                    |
        |  auth: local Bearer key              |
  src/openai.js                                |
        |  - validates, maps errors            |
        |  - hot-reloads cookies from .env     |
  src/upstream.js                              |
        |  - creates a fresh upstream session per request
        |  - serializes the whole conversation into one prompt
        |  - injects a tool-call contract (JSON envelope)
        |  - streams SSE back, translating:
        |      SSE message deltas -> OpenAI content deltas
        |      JSON envelope      -> OpenAI tool_calls
        |      done{tokens}      -> OpenAI usage
        '--------------------------------------->
```

Key ideas (all detailed in [PROTOCOL.md](PROTOCOL.md)):

1. **Stateless shim over a stateful agent** — one fresh upstream session per
   request, full conversation re-serialized each time. Reusing sessions makes
   the backend concatenate old context and garble replies.
2. **Tool calling by contract** — the backend's own tool events belong to its
   cloud sandbox, not to your client. The shim instead instructs the model to
   emit client tools as a JSON envelope in the reply text, then translates
   that envelope back into OpenAI `tool_calls`. Robustness: fence stripping,
   balanced-brace recovery from prose, failure falls back to plain content
   (never drops the reply).
3. **Auth-expiry signatures** — the same "please log in" failure shows up as
   3xx redirects, HTML pages, or JSON errors depending on the endpoint. All
   are mapped to OpenAI-style 401 so the client knows to re-capture cookies.

## Quick start

Requirements: Node.js >= 20, a packet-capture tool (mitmproxy, Fiddler, or
browser DevTools for cookie-only cases), and an account on the web app you
are wrapping.

1. Clone, `npm install` (no runtime dependencies — install is a no-op formality).
2. Read [PROTOCOL.md](PROTOCOL.md) — it is the map: which requests to look
   for, how to recognize session create/messages/model-list calls, what the
   auth cookies look like, and the pitfalls (stateful sessions, cloud-side
   tool events, late-burst SSE).
3. Capture your values and fill `.env` from `.env.example`.
4. Start: `npm start` (or use the bundled Windows `.vbs` launchers).
5. Point your client at `http://127.0.0.1:9317/v1` with your local API key.
6. `npm test` to run the regression suite against a live capture.

## What is in the box

| File | Role |
| --- | --- |
| `src/index.js` | process hardening: crash log with 1MB cap, EPIPE guard, startup preflight & warnings |
| `src/openai.js` | OpenAI HTTP surface: auth, validation, streaming & non-streaming, error mapping, client-disconnect abort |
| `src/upstream.js` | the adapter: sessions, prompt serialization, envelope contract & recovery, SSE translation |
| `src/sse.js` | dependency-free SSE parse/write |
| `src/config.js` | `.env` loader, all captured values, credential hot-reload with mid-write guard |
| `PROTOCOL.md` | the reverse-engineering map: method, signatures, pitfalls |
| `tools/reg.mjs` | 8-case live regression |
| `tools/hardening.test.mjs` | crash-log & bind-warning tests |
| `tools/shim.test.mjs` | envelope recovery unit tests + hot-reload E2E |

`start.vbs` / `stop.vbs` / `status.vbs` are optional Windows launchers (silent
start/stop/status, PID-file driven, tightens `.env` permissions on start).

## Is this OK to do?

Be honest with yourself about three things:

- **ToS**: wrapping a login-protected web API almost certainly violates the
  vendor's terms of service. This repo exists to *study* how such wrappers
  work, not to encourage abuse of any specific service.
- **Rate & footprint**: your traffic runs under your own account. Keep it
  low-volume and personal. High-volume automated use is what gets accounts
  banned and free tiers killed — for everyone, including people who never
  ran a wrapper.
- **Don't publish captures**: your cookies are your account. They belong in
  `.env` (gitignored) and nowhere else.

## Privacy

- The proxy listens on `127.0.0.1` by default; binding to anything else
  prints a loud startup warning (your upstream cookies sit behind it).
- Everything sensitive lives in `.env`, which is gitignored and (on Windows
  launchers) ACL-tightened to your user.
- Logs contain no message content; crash logs are capped at 1MB.

## License

MIT
