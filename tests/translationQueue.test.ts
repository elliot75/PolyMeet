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

afterEach(() => vi.unstubAllGlobals());

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
    expect(updates[0]).toEqual({ id: 's1', text: 'ok', final: false });
    expect(updates[1]).toEqual({ id: 's1', text: 'ok', final: true });
  });

  it('retains the recording id for queued translations when the next action starts', async () => {
    const usageIds: string[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const { usageSessionId } = JSON.parse(String(init?.body));
        usageIds.push(usageSessionId);
        if (usageIds.length === 1) await promise;
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
    await vi.waitFor(() => expect(usageIds).toEqual(['recording']));
    resolve();
    await Promise.all(jobs);
    expect(usageIds).toEqual(['recording', 'recording', 'batch']);
    expect(forRecording).toHaveBeenCalledTimes(2);
    expect(forBatch).toHaveBeenCalledTimes(1);
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
    await queue.finish(5);
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
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
