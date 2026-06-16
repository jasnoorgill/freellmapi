/**
 * Hardened fetch wrapper for outbound provider calls.
 *
 * History & motivation
 * --------------------
 * The original `fetch()` in providers (base.ts → OpenAICompatProvider /
 * cloudflare / cohere / google) could crash the entire Node.js process
 * when an undici HTTP/2 stream emitted a late `socketError` event —
 * typically when a CDN edge (e.g. CloudFront `13.32.241.0/24`) closed
 * the connection mid-response, AFTER the `fetch()` promise had already
 * resolved. In that race window the error had no listener attached (the
 * response promise was settled, the stream reference was held only by
 * undici internals), so Node.js escalated it to an unhandled exception
 * and terminated with exit code 1.
 *
 * Why the previous fix no longer works
 * -------------------------------------
 * The first iteration of this wrapper attached a `body.on('error', …)`
 * / `body.addEventListener('error', …)` listener to the response body
 * to catch late stream errors. That approach targeted the undici
 * 5/6 (Node 20–22) body, which was a `BodyReadable` exposing
 * EventEmitter-style hooks. undici 7+ (Node 24+) and undici 8 (Node 26+)
 * return a WHATWG `ReadableStream` for `res.body` instead — it has
 * neither `.on()` nor `.addEventListener()`. The guard was therefore
 * silently a no-op on those runtimes, and late stream errors were
 * escaping again.
 *
 * What this version does
 * ----------------------
 *  1. Times out the request via AbortController.
 *  2. For non-streaming responses (the common case — health probes,
 *     `validateKey`, non-streaming `chatCompletion`): fully drains the
 *     response body into a buffer BEFORE returning, then synthesizes a
 *     new `Response` from those bytes. Any error that arrives during
 *     the read — including a late `UND_ERR_SOCKET` on a mid-body
 *     connection reset — is surfaced as a normal promise rejection
 *     from `safeFetch`, never as an unhandled exception. The caller
 *     gets back a body it can safely `.json()` / `.text()`.
 *  3. For streaming responses (`init.body` contains `"stream":true`):
 *     the body is returned as-is so the caller's SSE consumer can
 *     iterate chunks incrementally. Late errors on the underlying
 *     socket are caught by the process-level safety net
 *     (`server/src/lib/process-safety-net.ts`) — transport errors are
 *     logged and swallowed, real programming errors still crash the
 *     process so the operator notices.
 *
 * Usage (in BaseProvider.fetchWithTimeout):
 *   return safeFetch(url, init, timeoutMs);
 */

/**
 * Pick the most informative label for the error so the log line is
 * self-explanatory in the wild (e.g. `UND_ERR_SOCKET` from undici).
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    return code ? `${err.name} [${code}]: ${err.message}` : `${err.name}: ${err.message}`;
  }
  return String(err);
}

/**
 * Detect whether the caller is asking for a streaming response.
 *
 * Providers set `stream: true` in the JSON body they send upstream
 * (OpenAI wire format); the response is then SSE. We do NOT buffer
 * those — buffering would defeat the purpose of streaming and add
 * latency. Instead we return the response as-is and rely on
 * `process-safety-net.ts` to swallow any late transport errors that
 * escape via the unhandled-rejection path.
 *
 * For non-streaming responses we buffer the body fully before
 * returning. That is the common case (health probes, `validateKey`,
 * non-streaming `chatCompletion` JSON responses) and gives us a
 * clean place to convert late stream errors into normal rejections.
 */
function isStreamingRequest(init: RequestInit): boolean {
  const body = init.body;
  if (typeof body !== 'string') return false;
  // Cheap substring check is fine here — `stream` is always a top-level
  // boolean on OpenAI-compatible request bodies, and the body is small.
  return /"stream"\s*:\s*true/.test(body);
}

/**
 * Fully drain `res.body` into a `Uint8Array` and return a new `Response`
 * constructed from those bytes. Any error that occurs while reading —
 * including a late `UND_ERR_SOCKET` from a mid-body connection reset —
 * is surfaced as a thrown error, never as an unhandled exception.
 *
 * The original `Response` object is left alone but its body is fully
 * consumed (the underlying socket is closed cleanly). Callers using
 * `.json()` / `.text()` on the returned `Response` will not see any
 * difference in behavior — they get the same payload, just guaranteed
 * to be complete or to throw.
 */
async function bufferResponseBody(
  res: Response,
  ctx: { url: string; method: string; label?: string },
): Promise<Response> {
  if (!res.body) return res;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } catch (err) {
    // Late socket errors land here on undici 7/8 (the
    // `attachStreamErrorGuard` no-op'd). Surface them as a normal
    // rejection from safeFetch so the caller / router can fail over
    // or report them. The 15s abort timer will also have fired in
    // many of these cases, but we log the underlying transport error
    // so the log line is informative rather than just "aborted".
    console.error(
      `[safeFetch] ${ctx.label ?? ctx.method} ${ctx.url} ` +
        `body read failed: ${describeError(err)}`,
    );
    try { reader.cancel(); } catch { /* upstream already gone */ }
    throw err;
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new Response(buf, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

export interface SafeFetchOptions extends RequestInit {
  /** Optional label for log lines (e.g. `validateKey(groq)`). */
  label?: string;
}

/**
 * Drop-in replacement for `fetch` that:
 *  - times out the request after `timeoutMs`
 *  - guards against late undici HTTP/2 stream errors
 *  - logs transport errors with provider context
 *
 * Throws on timeout or network error; status checking stays with the
 * caller (matches the existing `fetchWithTimeout` contract in base.ts).
 */
export async function safeFetch(
  url: string,
  init: SafeFetchOptions = {},
  timeoutMs = 15000,
): Promise<Response> {
  const { label, ...rest } = init;
  const method = (rest.method ?? 'GET').toUpperCase();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();

  let res: Response;
  try {
    res = await fetch(url, { ...rest, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const ms = Date.now() - t0;
    console.error(
      `[safeFetch] ${label ?? method} ${url} failed after ${ms}ms: ${describeError(err)}`,
    );
    throw err;
  }
  clearTimeout(timer);

  // Late transport errors (UND_ERR_SOCKET, ECONNRESET, etc.) on the
  // response body can no longer be caught by attaching an `error`
  // listener — undici 7+ / Node 24+ uses a plain WHATWG ReadableStream
  // which has no event surface. For non-streaming responses we fully
  // drain the body here so any such error becomes a clean rejection
  // from `safeFetch` (and surfaces in the caller / router as a
  // transport failure rather than a 15s abort).
  //
  // Streaming responses are returned as-is; the process-level safety
  // net in `lib/process-safety-net.ts` catches anything that escapes
  // via the unhandled-rejection path.
  if (!isStreamingRequest(rest)) {
    return await bufferResponseBody(res, { url, method, label });
  }

  return res;
}

/**
 * Attach a one-shot `error` listener to a Response whose body is backed by
 * a Node EventEmitter stream (e.g. undici 6 / Node 18-22), so a late stream
 * error doesn't escape as an unhandled exception.
 *
 * Used by `BaseProvider.fetchWithTimeout` when delegating to upstream's
 * `proxyFetch` (which returns a vanilla fetch Response) — the body-buffering
 * path inside `safeFetch` only applies when we own the fetch() call. When
 * proxyFetch does the fetch, this helper lets us apply the same guard.
 *
 * On undici 7+ / Node 24+ the body is a plain WHATWG ReadableStream with no
 * event surface — in that case this is a no-op (proxyFetch callers rely on
 * the process-safety-net for streaming errors, which is good enough).
 */
export function attachBodyGuard(
  res: Response,
  ctx: { url: string; platform?: string },
): Response {
  if (!res.body) return res;
  const body = res.body as unknown as {
    on?: (ev: string, fn: (err: unknown) => void) => void;
    addEventListener?: (ev: string, fn: (err: unknown) => void) => void;
  };
  const platformTag = ctx.platform ? `[${ctx.platform}] ` : '';
  const handler = (err: unknown) => {
    console.error(
      `[safeFetch] late stream error on ${platformTag}${ctx.url}: ` +
        `${describeError(err)} (response already delivered; suppressing)`,
    );
  };
  if (typeof body.on === 'function') body.on('error', handler);
  if (typeof body.addEventListener === 'function') {
    try { body.addEventListener('error', handler as any); } catch { /* ignore */ }
  }
  return res;
}
