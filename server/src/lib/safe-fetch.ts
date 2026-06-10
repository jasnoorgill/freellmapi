/**
 * Hardened fetch wrapper for outbound provider calls.
 *
 * The original `fetch()` in providers (base.ts → OpenAICompatProvider /
 * cloudflare / cohere / google) can crash the entire Node.js process when
 * an undici HTTP/2 stream emits a late `socketError` event — typically when
 * a CDN edge (e.g. CloudFront `13.32.241.0/24`) closes the connection
 * mid-response, AFTER the `fetch()` promise has already resolved.
 *
 * In that race window the error has no listener attached (the response
 * promise has settled, the stream reference is held only by undici
 * internals), so Node.js escalates it to an unhandled exception and
 * terminates with exit code 1.
 *
 * This wrapper:
 *  1. Attaches an `error` listener to the response body so late socket
 *     errors are observed and logged, not escaped.
 *  2. Times out the request via AbortController.
 *  3. Returns the same `Response` shape callers expect, so drop-in
 *     replacement of `fetch()` is safe.
 *
 * Usage (in BaseProvider.fetchWithTimeout):
 *   return safeFetch(url, init, timeoutMs);
 *
 * If a late stream error fires AFTER the response body has been
 * delivered to the caller, it is logged once with provider context but
 * does not propagate. The response that the caller already received is
 * not invalidated — undici simply continues to surface the transport
 * error to anyone who is still listening, which is now us.
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
 * Attach a one-shot `error` listener to the response body so a late
 * undici stream error doesn't escape as an unhandled exception.
 *
 * Why: `fetch()` in Node 18+/20+/22 (undici) returns a Response whose
 * `.body` is a ReadableStream backed by a `ClientHttp2Stream` (for
 * H2 connections) or `Socket` (for H1). When the remote peer resets
 * the connection after the body has started streaming, the underlying
 * stream emits an `error` event with code `UND_ERR_SOCKET`. Because
 * the `fetch()` promise is already settled (the response was received),
 * no caller is awaiting it anymore — the error has nowhere to go and
 * Node terminates the process.
 *
 * The fix: install an `error` listener on the body. The body is still
 * consumed normally via the standard `body.getReader()` API; we do not
 * interfere with the data flow.
 *
 * Exported so BaseProvider can compose it with `proxyFetch` — the
 * upstream PR introduced a proxyFetch wrapper that replaces bare
 * fetch(), so the stream-error guard has to be applied to whatever
 * proxyFetch returns, not via a wrapper around fetch().
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

  // Guard against late stream errors that arrive AFTER the response
  // promise has resolved (the actual crash mechanism — see module header).
  attachBodyGuard(res, { url });

  return res;
}
