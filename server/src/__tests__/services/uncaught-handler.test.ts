/**
 * Regression test for the "unhandled undici stream error crashes the
 * process" bug. See references/crash-history.md in the freellmapi skill
 * for the full incident timeline.
 *
 * The bug:
 *   1. health.ts calls `provider.validateKey()` every 300s for every key.
 *   2. validateKey eventually calls `fetch()` (Node's global, backed by undici).
 *   3. undici negotiates HTTP/2 with the provider's CDN edge.
 *   4. The CDN (observed: CloudFront `13.32.241.0/24`) closes the connection
 *      mid-response.
 *   5. The `fetch()` promise resolves with a partial response, then the
 *      internal `ClientHttp2Stream` emits an `error` event with code
 *      `UND_ERR_SOCKET` ("other side closed").
 *   6. No one is listening to that stream anymore — the response was
 *      already delivered — so Node escalates to `uncaughtException` and
 *      exits with code 1.
 *
 * The fix has two layers:
 *   - server/src/lib/safe-fetch.ts attaches an `error` listener to the
 *     response body so the event is consumed.
 *   - server/src/lib/process-safety-net.ts adds a defense-in-depth
 *     `process.on('uncaughtException')` that swallows transport-layer
 *     errors but lets real programming errors through.
 *
 * This test verifies that the defense-in-depth handler does what we
 * expect: transport errors are swallowed (process stays alive), but a
 * TypeError is re-thrown and surfaces normally.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  installProcessSafetyNet,
  isTransportError,
  _setExitImpl,
} from '../../lib/process-safety-net.js';

describe('process safety net (defense-in-depth for transport errors)', () => {
  let handlers: Record<string, Array<(...args: unknown[]) => void>>;

  beforeEach(() => {
    handlers = {};
    vi.spyOn(process, 'on').mockImplementation(((event: string, fn: any) => {
      (handlers[event] ??= []).push(fn);
      return process;
    }) as any);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Default exit stub that throws so tests can detect the call without
    // actually exiting vitest.
    _setExitImpl(() => {
      throw new Error('process.exit was called');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _setExitImpl((code) => process.exit(code));
  });

  describe('isTransportError', () => {
    it('matches undici socket errors', () => {
      const e = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
      expect(isTransportError(e)).toBe(true);
    });

    it('matches Node net errors (ECONNRESET, ETIMEDOUT, …)', () => {
      for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_STREAM_PREMATURE_CLOSE']) {
        const e = Object.assign(new Error('boom'), { code });
        expect(isTransportError(e)).toBe(true);
      }
    });

    it('matches errors named SocketError (the undici error class)', () => {
      const e = Object.assign(new Error('other side closed'), { name: 'SocketError' });
      expect(isTransportError(e)).toBe(true);
    });

    it('rejects programming errors (TypeError, ReferenceError, …)', () => {
      expect(isTransportError(new TypeError("can't read foo of undefined"))).toBe(false);
      expect(isTransportError(new ReferenceError('x is not defined'))).toBe(false);
      expect(isTransportError(new Error('something else'))).toBe(false);
    });

    it('rejects non-Error values', () => {
      expect(isTransportError('plain string')).toBe(false);
      expect(isTransportError(null)).toBe(false);
      expect(isTransportError(undefined)).toBe(false);
      expect(isTransportError(42)).toBe(false);
    });
  });

  describe('installProcessSafetyNet', () => {
    it('registers uncaughtException and unhandledRejection handlers', () => {
      installProcessSafetyNet();
      expect(handlers['uncaughtException']).toBeDefined();
      expect(handlers['uncaughtException'].length).toBeGreaterThan(0);
      expect(handlers['unhandledRejection']).toBeDefined();
      expect(handlers['unhandledRejection'].length).toBeGreaterThan(0);
    });

    it('swallows transport-layer uncaughtException errors (UND_ERR_SOCKET)', () => {
      installProcessSafetyNet();
      const err = Object.assign(new Error('other side closed'), {
        code: 'UND_ERR_SOCKET',
        name: 'SocketError',
      });
      expect(() => handlers['uncaughtException'][0](err)).not.toThrow();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('swallowed transport-level'),
      );
    });

    it('swallows all common transport error codes', () => {
      installProcessSafetyNet();
      for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE']) {
        const err = Object.assign(new Error(`transport: ${code}`), { code });
        expect(() => handlers['uncaughtException'][0](err)).not.toThrow();
      }
    });

    it('calls exit(1) on programming errors', () => {
      installProcessSafetyNet();
      const realErr = new TypeError("Cannot read properties of undefined (reading 'foo')");
      expect(() => handlers['uncaughtException'][0](realErr)).toThrow();
      // console.error is called with two args: a label string and the err.
      // Vitest's toHaveBeenCalledWith requires exact arg match — use
      // toHaveBeenCalledWith for the first arg, and check the second.
      expect(console.error).toHaveBeenCalled();
      const firstCallArgs = (console.error as any).mock.calls[0];
      expect(String(firstCallArgs[0])).toContain('FATAL uncaughtException');
    });

    it('swallows transport-level unhandledRejection errors', () => {
      installProcessSafetyNet();
      const err = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      expect(() => handlers['unhandledRejection'][0](err)).not.toThrow();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('swallowed transport-level unhandledRejection'),
      );
    });

    it('logs but does not exit on non-transport unhandledRejection', () => {
      installProcessSafetyNet();
      const realErr = new Error('database connection lost');
      // No transport code — must not exit, but should log.
      expect(() => handlers['unhandledRejection'][0](realErr)).not.toThrow();
      expect(console.error).toHaveBeenCalled();
      const firstCallArgs = (console.error as any).mock.calls[0];
      expect(String(firstCallArgs[0])).toContain('unhandledRejection (non-transport)');
    });

    it('handles non-Error rejection reasons (e.g. a thrown string)', () => {
      installProcessSafetyNet();
      // Throwing a plain string is a common unhandledRejection pattern.
      expect(() => handlers['unhandledRejection'][0]('something went wrong')).not.toThrow();
      expect(console.error).toHaveBeenCalled();
      const firstCallArgs = (console.error as any).mock.calls[0];
      expect(String(firstCallArgs[0])).toContain('unhandledRejection (non-transport)');
    });
  });
});
