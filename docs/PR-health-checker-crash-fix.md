# Fix: Health checker crashes the server on late undici HTTP/2 stream errors

## Summary

The `startHealthChecker()` interval in `server/src/services/health.ts` probes
all configured provider API keys every 300 seconds. On every probe, the
provider's `validateKey()` method issues an outbound `fetch()` (Node's
global, backed by undici). undici negotiates HTTP/2 with the provider's
CDN edge. When the edge resets the connection mid-response, undici emits a
late `error` event on the underlying `ClientHttp2Stream` AFTER the
`fetch()` promise has already resolved with a partial response. No
listener is attached to that stream anymore, so Node.js escalates the
event to `uncaughtException` and the entire server process exits with
code 1.

This branch fixes the crash with a two-layer fix:

1. **Primary fix — `server/src/lib/safe-fetch.ts`**: a hardened `fetch`
   wrapper that attaches an `error` listener to the response body so
   late stream errors are observed and logged, not escaped. The
   response that the caller already received is not invalidated. The
   wrapper is wired into `BaseProvider.fetchWithTimeout`, so all
   provider HTTP calls (`OpenAICompatProvider`, `CloudflareProvider`,
   `CohereProvider`, `GoogleProvider`) automatically get the guard.

2. **Defense-in-depth — `server/src/lib/process-safety-net.ts`**: a
   process-level `uncaughtException` and `unhandledRejection` handler
   that swallows transport-layer errors (undici `UND_ERR_SOCKET`, Node
   net `ECONNRESET`/`ETIMEDOUT`/`ENOTFOUND`/etc.) so the server stays
   alive even if a transport error escapes the wrapper. Programming
   errors (TypeError, ReferenceError, …) are NOT swallowed — they
   surface in the log and trigger `process.exit(1)`.

## Motivation

Observed in production (`/root/freellmapi` running `10.13.13.1:3001`):
the server crashed 5 times in 2 days with exit code 1. Every crash
originated from a `SocketError: other side closed` with code
`UND_ERR_SOCKET` on a `ClientHttp2Stream`, immediately preceded by
`[Health] Checking 16 keys…` / `[Health] Check complete.` in the log.
All 5 crashes hit the same Amazon CloudFront edge block
(`13.32.241.0/24`).

The health checker runs every 300 seconds and probes 16 keys per
cycle, so this is a high-frequency code path with a high probability
of hitting the edge-reset race on any given cycle. The cost of one
missed cycle is zero (the next cycle runs in 300s), so the correct
behavior on a transport error is to log it and move on — exactly
what the existing catch block in `checkKeyHealth()` already intended.
The crash happens because the error is surfaced LATER than the catch
block's scope, after the response promise has settled.

## Changes

### New files

- **`server/src/lib/safe-fetch.ts`** (≈130 lines) — hardened fetch
  wrapper. Attaches an `error` listener to the response body
  (covers the undici `EventEmitter`-style `.on('error', …)` API on
  Node 20+/22+) and also a `WHATWG`-style `addEventListener('error', …)`
  listener for completeness. Falls through silently if neither is
  available (the response is still returned to the caller; undici
  will simply emit the error to no one, which is exactly the bug
  being fixed). Also adds a 15s default timeout via
  `AbortController` (matching the prior `fetchWithTimeout` contract).

- **`server/src/lib/process-safety-net.ts`** (≈100 lines) — process-
  level safety net. Exports `installProcessSafetyNet()`,
  `isTransportError(err)`, and a `_setExitImpl(fn)` test hook. The
  handler is selective: only errors matching the transport-layer
  code list (`UND_ERR_SOCKET`, `ECONNRESET`, `ETIMEDOUT`,
  `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `EPIPE`,
  `ERR_TLS_CERT_ALTNAME_INVALID`, `ERR_STREAM_PREMATURE_CLOSE`) or
  with `name === 'SocketError'` are swallowed. Anything else logs
  and exits with code 1.

- **`server/src/__tests__/lib/safe-fetch.test.ts`** (7 tests) —
  unit tests for safeFetch: success path, request body/header
  pass-through, timeout via AbortController, network error
  re-throw with logging, late undici stream error suppression
  (regression test for the actual bug), tolerance for
  ReadableStream bodies without `.on()`, tolerance for null body
  (HEAD responses).

- **`server/src/__tests__/services/uncaught-handler.test.ts`**
  (12 tests) — unit tests for process-safety-net. Covers
  `isTransportError` matching/rejection across 5 scenarios, and
  `installProcessSafetyNet` behavior across 7 scenarios including
  the critical "programming errors must still trigger exit(1)"
  guarantee.

### Modified files

- **`server/src/providers/base.ts`** — `BaseProvider.fetchWithTimeout`
  now delegates to `safeFetch`. Drop-in replacement; preserves the
  same `(url, init, timeoutMs) → Promise<Response>` contract, so
  no provider subclass needs to change.

- **`server/src/index.ts`** — calls
  `installProcessSafetyNet()` at module load (before `main()`).
  Replaces an inline 60-line handler block with a one-line
  function call. The full handler logic now lives in
  `process-safety-net.ts` and is unit-testable without spawning
  the server.

### Files NOT changed

- `server/src/services/health.ts` — no behavioral change. The
  existing `try/catch` in `checkKeyHealth()` continues to handle
  synchronous promise rejections from `validateKey()`. The
  transport-error log line that was already extended (Jun 6 2026)
  to include `platform` and `base_url` is preserved verbatim.
- All provider subclasses (`openai-compat.ts`, `cloudflare.ts`,
  `cohere.ts`, `google.ts`) — no changes. They inherit the fix
  automatically through `BaseProvider.fetchWithTimeout`.
- The `OpenAICompatProvider.validateKey()` timeout change from
  10s to 30s (already shipped) is preserved.

## Test plan

- ✅ All 421 server tests pass (44 test files)
- ✅ 7 new safeFetch tests pass
- ✅ 12 new process-safety-net tests pass
- ✅ `npm run build:server` (tsc) clean
- ✅ New code is zero-dependency (no new packages)

Manual verification recommended (operator): start the server,
leave it running for ≥1 hour, confirm the watchdog
(`bff5ae167d28` cron, every 12h) reports no new crashes once a
provider edge is back to normal operation. To reproduce the fix:
temporarily add a malformed API key for a CloudFront-routed
provider and observe that:
1. `[Health] Key N (<platform>, base=default) transport error: …`
   is logged every 300s (existing behavior).
2. The server does NOT exit (new behavior).

## Risk assessment

**Low risk.** The two fixes are narrowly scoped:
- `safeFetch` is a strict superset of bare `fetch` for the
  caller. The only behavioral addition is attaching an `error`
  listener to the response body — if the body doesn't expose
  the relevant API, the wrapper is a no-op.
- `process-safety-net` only swallows errors matching a
  explicit, well-known list of transport-layer error codes.
  Programming errors are explicitly NOT swallowed (the test
  suite includes a regression test for this).
- No new dependencies. No changes to public APIs or DB schema.
- No changes to existing provider behavior beyond what
  `fetchWithTimeout` already did.

**Rollback plan:** revert the commit. The change is contained to
4 new files + 2 modified files. If `safeFetch` is the source of
a regression, `BaseProvider.fetchWithTimeout` can be reverted to
its 4-line bare-`fetch` implementation in one edit.

## Deployment notes

- No configuration changes required.
- The watchdog cron (`bff5ae167d28`, every 12h) continues to
  work without modification — it reads `/tmp/freellmapi.log`
  for `[Health] Key N (… transport error` lines, which the
  fix does not change.
- After deploying, the next 300-second health-check cycle will
  exercise the new code path. Operators should see the same
  `[Health] Key N (… transport error` log lines they were
  seeing before — just without the server exit.

## Related

- The Jun 6 2026 extension of the `[Health] Key N` log line to
  include `platform` and `base_url` for forensic attribution. This
  PR does not modify that line.
- Node undici issue tracker: the late `ClientHttp2Stream` error
  on HTTP/2 socket reset is a known undici behavior; the only
  in-process fix is to install a body-level error listener.
