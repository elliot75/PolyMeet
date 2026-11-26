import { afterEach, describe, expect, it, vi } from 'vitest';
import { needsTranslation, TranslationQueue } from '../src/client/services/translationQueue';
import { defaults } from '../src/client/services/settings';
import type { TranscriptSegment } from '../src/shared/types';

function makeSegment(id: string, text: string): TranscriptSegment {
  return {
    id,
    meetingId: 'm1',
    track: 'mic',
    speakerLabel: '我方',
    startedAtMs: 0,
    text,
    isFinal: true,
  };
}

function sseResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('translation queue', () => {
  it('retains at most 4 prior sentences in sliding context and emits updates', async () => {
    const payloads: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}'));
        payloads.push(body.text);
        return sseResponse(['event: delta\ndata: {"text":"ok"}\n\n', 'event: done\ndata: {}\n\n']);
      }),
    );

    const updates: Array<{ id: string; text: string; final: boolean }> = [];
    const onError = vi.fn();
    const queue = new TranslationQueue(
      defaults,
      '繁體中文',
      'English',
      (segment, text, final) => {
        updates.push({ id: segment.id, text, final });
      },
      onError,
    );

    for (let i = 1; i <= 6; i++) {
      queue.add(makeSegment(`s${i}`, `line-${i}`));
    }
    await vi.waitFor(() => expect(payloads).toHaveLength(6));
    await vi.waitFor(() => expect(updates.filter((entry) => entry.final)).toHaveLength(6));

    expect(onError).not.toHaveBeenCalled();
    expect(payloads[5]).toBe('Context:\nline-2\nline-3\nline-4\nline-5\n\nCurrent speech:\nline-6');
    expect(updates.filter((entry) => entry.id === 's1')).toEqual([
      { id: 's1', text: 'ok', final: false },
      { id: 's1', text: 'ok', final: true },
    ]);
  });

  it('runs two jobs concurrently and retains the recording id while the next action waits', async () => {
    const usageIds: string[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const { usageSessionId } = JSON.parse(String(init?.body));
        usageIds.push(usageSessionId);
        if (usageIds.length < 3) await promise;
        return sseResponse([
          'event: delta\ndata: {"text":"ok"}\n\n',
          'event: done\ndata: {"usage":{"id":"meter"}}\n\n',
        ]);
      }),
    );
    const queue = new TranslationQueue(defaults, '繁體中文', 'English', vi.fn(), vi.fn());
    const forRecording = vi.fn();
    const forBatch = vi.fn();
    const recording = { meetingId: 'm1', meetingTitle: 'Meeting', usageSessionId: 'recording' };
    const jobs = [
      queue.add(makeSegment('s1', 'first'), recording, forRecording),
      queue.add(makeSegment('s2', 'last'), recording, forRecording),
      queue.add(makeSegment('s3', 'batch'), { ...recording, usageSessionId: 'batch' }, forBatch),
    ];
    await vi.waitFor(() => expect(usageIds).toEqual(['recording', 'recording']));
    resolve();
    await Promise.all(jobs);
    expect(usageIds).toEqual(['recording', 'recording', 'batch']);
    expect(forRecording).toHaveBeenCalledTimes(2);
    expect(forBatch).toHaveBeenCalledTimes(1);
  });

  it('replaces a streamed draft with the normalized final translation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'event: delta\ndata: {"text":"会议记录"}\n\n',
          'event: done\ndata: {"finalText":"會議記錄"}\n\n',
        ]),
      ),
    );
    const onUpdate = vi.fn();
    const queue = new TranslationQueue(defaults, 'English', '繁體中文', onUpdate, vi.fn());
    const segment = makeSegment('s1', 'Meeting minutes');
    await queue.add(segment);
    expect(onUpdate.mock.calls).toEqual([
      [segment, '会议记录', false, expect.any(AbortSignal)],
      [segment, '會議記錄', true, expect.any(AbortSignal)],
    ]);
  });

  it('keeps failed text as a draft while reporting recorded usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'event: delta\ndata: {"text":"Partial"}\n\n',
          'event: error\ndata: {"error":"provider_request_failed","usage":{"id":"meter"}}\n\n',
        ]),
      ),
    );
    const onUpdate = vi.fn();
    const onError = vi.fn();
    const onUsage = vi.fn();
    const queue = new TranslationQueue(defaults, '繁體中文', 'English', onUpdate, onError);
    const segment = makeSegment('s1', 'first');
    await queue.add(segment, undefined, onUsage);
    expect(onUpdate.mock.calls).toEqual([[segment, 'Partial', false, expect.any(AbortSignal)]]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ id: 'meter' });
  });

  it('releases both live slots when they stall before the first translated text', async () => {
    vi.useFakeTimers();
    const stalled: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      if (fetchMock.mock.calls.length <= 2) {
        const signal = init.signal!;
        stalled.push(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return Promise.resolve(
        sseResponse(['event: delta\ndata: {"text":"Translated"}\n\n', 'event: done\ndata: {}\n\n']),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const onUpdate = vi.fn();
    const onError = vi.fn();
    const queue = new TranslationQueue(defaults, '繁體中文', 'English', onUpdate, onError);
    const usage = { meetingId: 'm1', meetingTitle: 'Meeting', live: true };
    const segments = [
      makeSegment('s1', 'first'),
      makeSegment('s2', 'second'),
      makeSegment('s3', 'third'),
    ];
    const jobs = segments.map((segment) => queue.add(segment, usage));

    await vi.advanceTimersByTimeAsync(7_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stalled.every((signal) => !signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(onError.mock.calls).toEqual([['first-text-timeout'], ['first-text-timeout']]);
    expect(stalled.every((signal) => signal.aborted)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await Promise.all(jobs);
    expect(onUpdate).toHaveBeenCalledWith(segments[2], 'Translated', true, expect.any(AbortSignal));
  });

  it('clears the live deadline when nonblank text arrives', async () => {
    vi.useFakeTimers();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const write = (frame: string) => writer.write(new TextEncoder().encode(frame));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(readable));
    vi.stubGlobal('fetch', fetchMock);
    const onUpdate = vi.fn();
    const onError = vi.fn();
    const queue = new TranslationQueue(defaults, '繁體中文', 'English', onUpdate, onError);
    const segment = makeSegment('s1', 'first');
    const job = queue.add(segment, { meetingId: 'm1', meetingTitle: 'Meeting', live: true });
    await vi.advanceTimersByTimeAsync(7_000);
    await write('event: delta\ndata: {"text":"Translated"}\n\n');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock.mock.calls[0][1].signal?.aborted).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    await write('event: done\ndata: {}\n\n');
    await writer.close();
    await job;
    expect(onUpdate).toHaveBeenCalledWith(segment, 'Translated', true, expect.any(AbortSignal));
  });

  it('filters only final nonblank originals with missing or unfinished translations', () => {
    const segment = makeSegment('s1', 'line');
    expect(
      [
        segment,
        { ...segment, translation: 'draft', translationIsFinal: false },
        { ...segment, translation: 'legacy final' },
        { ...segment, text: '' },
        { ...segment, isFinal: false },
      ].map(needsTranslation),
    ).toEqual([true, true, false, false, false]);
  });

  it('deduplicates a pending segment and replaces an in-flight job after an edit', async () => {
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const { text } = JSON.parse(String(init?.body));
      if (text.endsWith('corrected')) {
        expect(text).toBe('Context:\n\n\nCurrent speech:\ncorrected');
        return Promise.resolve(
          sseResponse(['event: delta\ndata: {"text":"new"}\n\n', 'event: done\ndata: {}\n\n']),
        );
      }
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal?.reason));
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onUpdate = vi.fn();
    const onError = vi.fn();
    const queue = new TranslationQueue(defaults, '繁體中文', 'English', onUpdate, onError);
    const first = makeSegment('s1', 'original');
    queue.add(first);
    expect(queue.add(first)).toBeUndefined();
    await vi.waitFor(() => expect(signal).toBeDefined());
    queue.remove(first.id);
    const corrected = { ...first, text: 'corrected' };
    await queue.add(corrected);
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUpdate.mock.calls.filter(([, , final]) => final)).toEqual([
      [corrected, 'new', true, expect.any(AbortSignal)],
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('bounds the wait for final translations before a reload and cancels the remaining work', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
      }),
    );
    const onError = vi.fn();
    const queue = new TranslationQueue(defaults, '繁體中文', 'English', vi.fn(), onError);
    queue.add(makeSegment('s1', 'first'));
    queue.add(makeSegment('s2', 'second'));
    const queued = queue.add(makeSegment('s3', 'third'));
    await queue.finish(5);
    await queued;
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it('cancels active translation without triggering onError', async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
      }),
    );

    const onError = vi.fn();
    const queue = new TranslationQueue(defaults, '繁體中文', 'English', vi.fn(), onError);
    queue.add(makeSegment('s1', 'first'));
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    queue.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(capturedSignal?.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });
});
