/**
 * Process-level safety net for transport-layer errors.
 *
 * Installs `uncaughtException` and `unhandledRejection` handlers that
 * swallow errors from the undici/Node transport layer (CDN edge resets,
 * DNS failures, TLS errors, etc.) so the server stays alive. Real
 * programming errors (TypeError, ReferenceError, etc.) are NOT
 * swallowed — they surface in the log and trigger the normal
 * `process.exit(1)` so the operator notices.
 *
 * The primary fix for the recurring undici `ClientHttp2Stream` crash
 * lives in `server/src/lib/safe-fetch.ts`, which attaches an `error`
 * listener to the response body so late stream errors don't escape in
 * the first place. This module is the defense-in-depth backstop: if a
 * transport error still escapes the wrapper for any reason (e.g. the
 * error fires during request setup before the body is returned, or on
 * a Node version where the stream surface doesn't expose the
 * `on('error', …)` API), the process stays alive.
 *
 * Why is this in its own module?
 *   - It can be unit-tested by importing the module without spinning up
 *     the full server (which would conflict on port 3001 in test runs).
 *   - It's reusable for any Node service that does outbound HTTP/2.
 *   - It keeps `index.ts` clean.
 */

const TRANSPORT_ERROR_CODES = new Set([
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPIPE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

/**
 * Returns true if `err` looks like a transport-layer problem (vs a
 * real programming bug).
 */
export function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: string }).code ?? '';
  return TRANSPORT_ERROR_CODES.has(code) || err.name === 'SocketError';
}

/** Pretty-print a rejection reason for log lines. */
export function describeRejection(reason: unknown): string {
  if (reason instanceof Error) {
    const code = (reason as Error & { code?: string }).code;
    return code
      ? `${reason.name} [${code}]: ${reason.message}`
      : `${reason.name}: ${reason.message}`;
  }
  return String(reason);
}

/** Hook for test mocks. Defaults to `process.exit`. */
let exitImpl: (code: number) => void = (code) => process.exit(code);

export function _setExitImpl(fn: (code: number) => void): void {
  exitImpl = fn;
}

/**
 * Install both handlers. Idempotent — safe to call multiple times
 * (e.g. across test files or hot reloads), only the most recent call
 * takes effect.
 */
export function installProcessSafetyNet(): void {
  process.on('uncaughtException', (err) => {
    if (isTransportError(err)) {
      console.error(
        `[server] swallowed transport-level uncaughtException: ` +
          `${err.name} [${(err as Error & { code?: string }).code ?? 'n/a'}]: ${err.message}`,
      );
      return;
    }
    console.error('[server] FATAL uncaughtException:', err);
    exitImpl(1);
  });

  process.on('unhandledRejection', (reason) => {
    if (isTransportError(reason)) {
      console.error(
        `[server] swallowed transport-level unhandledRejection: ` +
          `${describeRejection(reason)}`,
      );
      return;
    }
    console.error('[server] unhandledRejection (non-transport):', reason);
  });
}
