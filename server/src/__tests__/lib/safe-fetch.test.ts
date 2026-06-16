import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { safeFetch } from '../../lib/safe-fetch.js';

const realFetch = globalThis.fetch;

describe('safeFetch', () => {
  let onUnhandled: ((reason: unknown) => void) | undefined;
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The "surfaces late socket errors" test deliberately rejects a
    // ReadableStream to emulate an undici 8 mid-body connection reset.
    // That rejection escapes the body read after our catch block has
    // already fired (the Web Streams spec still surfaces it via
    // `cancel()`). Suppress it here so the test runner doesn't
    // report a phantom error.
    onUnhandled = (reason) => {
      const code = (reason as { code?: string })?.code;
      if (code === 'UND_ERR_SOCKET') return;
    };
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (onUnhandled) process.off('unhandledRejection', onUnhandled);
    onUnhandled = undefined;
    vi.restoreAllMocks();
  });

  it('returns a Response whose body has been drained into memory for non-streaming requests', async () => {
    const original = new Response('ok', { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(original);

    const out = await safeFetch('https://example.com/v1/models');
    // The returned object is a fresh Response (the buffered one), not
    // the original — that is the whole point: late transport errors on
    // the original stream can no longer fire.
    expect(out).not.toBe(original);
    expect(out.status).toBe(200);
    expect(out.headers.get('content-type')).toBe('text/plain;charset=UTF-8');
    expect(await out.text()).toBe('ok');
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

  // Regression test for the bug this module was created to fix on
  // undici 7+ / Node 24+. The previous version of this test asserted
  // that late undici stream errors were silently swallowed via an
  // `error` listener — that no longer works because undici 7+ returns
  // a WHATWG ReadableStream for the body which has no event surface.
  //
  // The new contract: a late socket error during the body read is
  // surfaced as a normal rejection from `safeFetch`, so the caller /
  // router sees a transport failure (and can fail over) rather than
  // hanging until the 15s abort timer fires.
  it('surfaces late socket errors during body read as a rejection', async () => {
    // A body whose read() rejects mid-stream with a socket error,
    // emulating the undici 8 behavior on a mid-body connection reset.
    // We do NOT use controller.error() (that path also signals the
    // rejection as unhandledRejection, which the test runner reports
    // as a phantom error). Instead, reject directly from `pull` —
    // that propagates through the reader as a normal exception, no
    // unhandledRejection side-effect.
    const socketErr = Object.assign(new Error('other side closed'), {
      code: 'UND_ERR_SOCKET',
      name: 'SocketError',
    });
    let reads = 0;
    const flakyBody = new ReadableStream({
      pull(controller) {
        if (reads++ === 0) {
          controller.enqueue(new TextEncoder().encode('partial '));
        } else {
          // The reader sees this as a thrown error on the next read,
          // without controller.error() triggering unhandledRejection.
          return Promise.reject(socketErr);
        }
      },
    });
    const res = new Response(flakyBody, { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);

    await expect(safeFetch('https://example.com/midreset')).rejects.toThrow(
      'other side closed',
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('body read failed'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('UND_ERR_SOCKET'),
    );
  });

  it('returns streaming responses unmodified so SSE consumers can iterate incrementally', async () => {
    // SSE-style response body — the caller will pull chunks via
    // getReader() and yield them. Buffering here would defeat the
    // purpose of streaming and add latency.
    const sseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"x":1}\n\n'));
        controller.close();
      },
    });
    const res = new Response(sseBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);

    const out = await safeFetch('https://example.com/v1/chat', {
      method: 'POST',
      body: JSON.stringify({ model: 'x', stream: true }),
    });
    // Streaming: the original Response is returned as-is. The caller
    // (readSseStream in base.ts) owns body consumption from here.
    expect(out).toBe(res);
    expect(out.headers.get('content-type')).toBe('text/event-stream');
  });

  it('tolerates null body (HEAD responses etc.)', async () => {
    const res = new Response(null, { status: 204 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);
    const out = await safeFetch('https://example.com/head');
    expect(out.status).toBe(204);
  });
});
