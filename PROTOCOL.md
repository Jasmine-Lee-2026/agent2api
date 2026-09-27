# Protocol notes: wrapping a login-protected web chat agent

This is the **map**, not a keychain: it documents the *method* of
reverse-engineering a browser chat app into a stateless OpenAI-compatible API,
the shapes to look for in traffic, and the pitfalls. It deliberately contains
**no vendor-specific values** (no hosts, endpoint paths, cookie names, magic
headers, agent ids) — you capture those from your own traffic in about ten
minutes and put them in `.env`.

## 0. The capture method (bring your own capture)

Any HTTP inspection tool works: mitmproxy, Fiddler, Charles, or plain browser
DevTools for the cookie-only parts. With the target web app open and logged
in:

1. **Cookies / token**: DevTools → Application/Network → any API request →
   copy the request cookies. You are looking for two of them: a CSRF-style
   token cookie (often also mirrored in a request header) and a session
   cookie. Note both *names* and *values*.
2. **Session create**: open a new chat in the UI and watch the network tab.
   The first call is usually a `POST` with an empty or near-empty JSON body
   that returns a JSON object containing something like
   `result.session_id` (name varies). That is your `EP_SESSION_CREATE`.
3. **Messages**: sending a chat message triggers a `POST` to a path containing
   that session id; the response is `text/event-stream`. That is
   `EP_MESSAGES`. Note the extra headers the app sends (`X-Requested-With`,
   client-type markers, channel markers) — copy the non-standard ones into
   `HEADERS_CHAT`.
4. **Session delete**: when you delete a chat, a `DELETE` to a path with the
   session id fires. That is `EP_SESSION_DELETE` (keep the `/{id}` template).
5. **Model lists**: the model picker in the UI issues one or two `GET`s that
   return arrays of model ids. Those are your `EP_AGENT_MODELS` /
   `EP_BENEFIT_MODELS` / `EP_LEGACY_MODELS`. If the agent-list call needs an
   id in its query string, that goes into `AGENT_ID`. If some models are
   marked as free/benefit channel and need a marker header on the messages
   call, that header pair goes into `BENEFIT_HEADER` and the model ids into
   `BENEFIT_MODELS`.

Sanity check before wiring everything: replay the messages request with
`curl` (cookies + headers copied verbatim) and confirm you get an SSE stream.

## 1. Authentication

Two pieces, all copied from browser traffic after login:

| Piece | Where used | Env var |
| --- | --- | --- |
| token | cookie `COOKIE_CFTK_NAME` AND header `TOKEN_HEADER_NAME` (both, if the app uses both) | `CFTK` |
| session | cookie `COOKIE_SESSION_NAME` | `SESSION_ID` |

Expiry signatures — the same "please log in" failure surfaces in several
different shapes depending on the endpoint, and the shim maps all of them to
401 so the client can distinguish "re-login" from "upstream broken":

- upstream answers `30x` redirect (to the login page);
- upstream answers `200` with an HTML login page;
- upstream answers `200` with a JSON body carrying a csrf/auth error string;
- (seen in the wild) upstream answers `200` with an **empty body** on session
  create when the token is invalid.

## 2. Two kinds of models, one messages endpoint

Chat backends of this family typically expose two channels through the same
messages endpoint:

- **Agent-platform models**: the cloud agent platform. Every request gets the
  platform's own large system prompt prepended server-side (not visible to
  you, not removable). The platform injects its own tool schema and expects
  the agent persona — hence the "you are a stateless API" override block in
  the prompt.
- **Free/benefit models**: same endpoint, selected by a marker header
  (`BENEFIT_HEADER`). No server-side system prompt (prompt token counts are
  visibly smaller), burns a daily free quota instead of paid credits.

## 3. SSE event table (messages stream)

The event names below are generic placeholders for the family of shapes you
will see; match yours from the capture.

| Event (shape) | Payload | Proxy behavior |
| --- | --- | --- |
| status | `{...}` | ignored |
| thought / reasoning trace | `{content}` deltas | ignored (not the reply) |
| **message** | `{content}` deltas | the reply text; forwarded to OpenAI content |
| cloud tool_call | cloud-side tool invocation | **deliberately ignored** (see §5) |
| cloud tool_result | cloud-side tool result | **deliberately ignored** (see §5) |
| file_diff | `{...}` | ignored (cloud sandbox edits) |
| step_finish / session_title | `{...}` | ignored |
| heartbeat | SSE comment lines | ignored by the SSE parser |
| error | `{error}` | raised as 502 |
| **done** | `{tokens:{input,output,total}}` | mapped to OpenAI `usage` |

Timing observation: reasoning/status events arrive during most of the wait,
then ALL reply deltas burst within a very short window just before `done`.
The upstream delivers reply content late in one burst; the shim is a
zero-delay pass-through. Do not "fix" perceived batching in the proxy.

## 4. Sessions are stateful server-side

The upstream session remembers prior turns. The shim therefore creates a
fresh session per request and serializes the full OpenAI conversation into a
single `content` prompt (stateless shim). Reusing sessions makes the upstream
concatenate old context and produce repeated/garbled replies. Cost model: one
session create round-trip per request (~100ms) plus full-context re-send —
that is the price of correctness here.

## 5. Deliberately unused: cloud-side tool events

The platform emits its own tool-call/tool-result events for ITS cloud
sandbox (cloud search, cloud file ops in a `/workspace`). These are NOT the
client's tools: mapping them to OpenAI `tool_calls` would be wrong — the
client cannot execute them and the result would never come back.

Instead the shim instructs the model to emit client tools as a JSON envelope
inside the reply text:

```json
{"tool_call": {"name": "get_weather", "arguments": {"city": "Hangzhou"}}}
```

If you see the shim ignore cloud `tool_call` events, that is by design. Do
not "fix" it.

## 6. Envelope detection and recovery (src/upstream.js)

First-chunk heuristic on the reply text: `{` / `[` → buffered JSON path;
```` ```json ```` + `{` → buffered JSON path; anything else → streamed as
content. On stream end, the buffered text is parsed as an envelope; if it is
NOT a valid envelope, the full text is recovered as content (nothing dropped).

Failure modes seen in the wild, and the defenses:

- model wraps the envelope in code fences → fence stripping;
- model wraps the envelope in prose ("Sure, let me check: {...}") →
  balanced-brace recovery extracts the first balanced JSON block (quote- and
  escape-aware) and retries once;
- truncated / non-envelope JSON → rejected, falls back to plain content;
- the model simply refuses → client sees a normal text reply and retries.

Known ceiling of this architecture: the model's cooperation is the only
enforcement mechanism — upstream offers no stop-sequences / prefill / JSON
mode to force the format. The few-shot examples in the prompt plus the
recovery paths keep the failure rate low but not zero.

## 7. Ops notes

- **Credential rotation**: cookies expire on the vendor's schedule (hours to
  days). The shim re-reads `.env` on every request (mtime check) — paste new
  cookie values into `.env`, save, done. No restart. A mid-write read
  (empty value) keeps the previous credentials instead of breaking auth.
- **Client disconnects** abort the upstream stream (no orphaned token burn).
- **Payload limit** 20MB, answered with 413 while draining the request so
  the error can actually be delivered.
- **Streaming discipline**: OpenAI default is non-streaming; only
  `stream: true` produces SSE. `finish_reason` is always emitted exactly once.
