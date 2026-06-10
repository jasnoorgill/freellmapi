import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { safeFetch } from '../../lib/safe-fetch.js';

const realFetch = globalThis.fetch;

describe('safeFetch', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('returns the response on success', async () => {
    const res = new Response('ok', { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);

    const out = await safeFetch('https://example.com/v1/models');
    expect(out).toBe(res);
    expect(out.status).toBe(200);
  });

  it('passes the request body and headers through', async () => {
    let captured: RequestInit | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      captured = init;
      return new Response('{}', { status: 200 });
    });

    await safeFetch('https://example.com/v1/chat', {
      method: 'POST',
      headers: { 'X-Test': '1' },
      body: JSON.stringify({ model: 'x' }),
    });
    expect(captured?.method).toBe('POST');
    expect((captured?.headers as Record<string, string>)['X-Test']).toBe('1');
    expect(captured?.body).toBe('{"model":"x"}');
  });

  it('aborts and throws on timeout', async () => {
    vi.useFakeTimers();
    try {
      // fetch that respects the abort signal
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
      });

      const p = safeFetch('https://example.com/slow', {}, 100);
      // Advance past the timeout
      vi.advanceTimersByTime(200);
      await expect(p).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs and re-throws network errors', async () => {
    const err = new Error('fetch failed');
    (err as any).code = 'UND_ERR_SOCKET';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(err);

    await expect(safeFetch('https://example.com/down')).rejects.toThrow('fetch failed');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[safeFetch]'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('UND_ERR_SOCKET'),
    );
  });

  // Regression test for the bug this module was created to fix.
  // When a fetch resolves successfully but the underlying undici
  // stream later emits an `error` event, the response is still
  // returned to the caller. The error is logged but does not throw.
  it('attaches an error listener to the body to suppress late undici stream errors', async () => {
    // Mock body that exposes an EventEmitter-style .on() API — this
    // matches the undici internal stream surface on Node 20/22.
    const handlers: Record<string, Array<(err: unknown) => void>> = {};
    const fakeBody = {
      on(event: string, fn: (err: unknown) => void) {
        (handlers[event] ??= []).push(fn);
      },
    };
    const res = {
      ok: true,
      status: 200,
      body: fakeBody,
    } as unknown as Response;

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);

    const out = await safeFetch('https://example.com/v1/models');
    expect(out).toBe(res);

    // The guard must have installed an 'error' listener.
    expect(handlers['error']).toBeDefined();
    expect(handlers['error'].length).toBeGreaterThanOrEqual(1);

    // Simulate a late undici socket error firing after the response
    // was returned. It should be caught and logged, NOT thrown.
    const socketErr = Object.assign(new Error('other side closed'), {
      code: 'UND_ERR_SOCKET',
      name: 'SocketError',
    });
    expect(() => handlers['error'][0](socketErr)).not.toThrow();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('late stream error'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('UND_ERR_SOCKET'),
    );
  });

  it('tolerates bodies without an EventEmitter-style .on() method', async () => {
    // Standard WHATWG ReadableStream — no .on() method.
    const res = new Response('ok', { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);

    // Must not throw even though .on is not available on the body.
    await expect(safeFetch('https://example.com/standard')).resolves.toBe(res);
  });

  it('tolerates null body (HEAD responses etc.)', async () => {
    const res = new Response(null, { status: 204 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);
    await expect(safeFetch('https://example.com/head')).resolves.toBe(res);
  });
});
