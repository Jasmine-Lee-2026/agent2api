# Known limitations (by design, not bugs)

Last reviewed: 2026-09-27. All listed items are inherent to the architecture
or deliberate trade-offs — read PROTOCOL.md first.

## Upstream-inherent, not fixable here

1. **Server-side system prompt cost on agent-channel models**
   The agent platform prepends its own large system prompt server-side (not
   visible, not removable). It burns quota fast. Mitigation: use free-channel
   models (`BENEFIT_MODELS` / `BENEFIT_HEADER`) which skip it.

2. **Late-burst streaming**
   The upstream delivers status/reasoning events during most of the wait and
   then bursts ALL reply deltas in one short window. The shim is a zero-delay
   pass-through; perceived batching is upstream behavior.

3. **Full-context re-send per request**
   The upstream session is stateful; the shim is stateless by design (see
   PROTOCOL.md §4). Every request pays one session round-trip plus the full
   conversation re-serialized. This is the price of correct, un-garbled
   replies.

## Architecture ceiling

4. **Tool calling relies on model cooperation**
   The upstream offers no stop-sequences / prefill / JSON mode, so the JSON
   envelope contract is enforced only by prompt + recovery heuristics
   (fences, balanced-brace extraction, fallback-to-content). Failure rate is
   low but nonzero; a failed envelope degrades to a plain text reply.

5. **Credential rotation is manual**
   Cookies expire on the vendor's schedule. The shim hot-reloads `.env`
   (no restart), but somebody still has to open the browser and re-capture.

## Deliberately not done

6. **Prompt-prefix caching** — the upstream protocol has no such knob.
7. **Failure-rate counters** — single-user local tool; log lines suffice.
8. **Vendor values in the repo** — the whole point; see README.
