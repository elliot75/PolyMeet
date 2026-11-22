import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveSttClient } from '../src/client/audio/liveSttClient';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: any[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(_url: string) {
    FakeSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeSocket.instances = [];
});
describe('live transcription reconnect', () => {
  const start = {
    type: 'session.start',
    provider: 'openai',
    model: 'gpt-live-transcribe',
    sampleRate: 24000,
    track: 'mic',
  } as const;
  const ready = { type: 'session.ready', provider: start.provider, model: start.model };
  function newClient() {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
    vi.stubGlobal('WebSocket', FakeSocket);
    const events = vi.fn();
    const client = new LiveSttClient(start, events);
    client.connect();
    return { client, events, first: FakeSocket.instances[0] };
  }
  it('times out a silent handshake without dropping pending audio or processing stale events', async () => {
    const { client, events, first } = newClient();
    first.open();
    client.audio(new Uint8Array([1, 2]).buffer);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'session.reconnecting',
      reason: 'readiness_timeout',
    });
    first.message(ready);
    expect(first.sent).toEqual([start]);
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.instances[1];
    second.open();
    second.message(ready);
    expect(second.sent).toEqual([start, { type: 'audio.chunk', pcm16Base64: 'AQI=' }]);
    client.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });
  it('replays exactly 500 ms of quiet context and no finalized words after provider retirement', async () => {
    const { client, events, first } = newClient();
    first.open();
    first.message(ready);
    client.audio(new Uint8Array([99, 99]).buffer, 0.1, true);
    for (let i = 1; i <= 6; i++) client.audio(new Uint8Array(4800).fill(i).buffer, 0);
    client.commit();
    first.message({ type: 'transcript.committed', segmentId: 'saved' });
    first.message({
      type: 'transcript.final',
      segmentId: 'saved',
      text: 'already saved',
      track: 'mic',
    });
    first.message({ type: 'session.reconnecting', reason: 'provider_session_expiring' });
    expect(events.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'session.reconnecting',
      reason: 'provider_session_expiring',
    });
    client.audio(new Uint8Array([42, 42]).buffer, 0.1, true);
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.instances[1];
    second.open();
    second.message(ready);
    expect(
      second.sent
        .slice(1)
        .map((value) => [...atob(value.pcm16Base64)].map((byte) => byte.charCodeAt(0)))
        .map((bytes) => [bytes.length, bytes[0]]),
    ).toEqual([
      [4800, 2],
      [4800, 3],
      [4800, 4],
      [4800, 5],
      [4800, 6],
      [2, 42],
    ]);
    client.stop();
  });
  it('replays recent audio and queues new audio and commits in order', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
    vi.stubGlobal('WebSocket', FakeSocket);
    const events: string[] = [];
    const client = new LiveSttClient(
      {
        type: 'session.start',
        provider: 'openai',
        model: 'gpt-live-transcribe',
        sampleRate: 24000,
        track: 'mic',
      },
      (event) => events.push(event.type),
    );
    client.connect();
    const first = FakeSocket.instances[0];
    first.open();
    first.message({ type: 'session.ready', provider: 'openai', model: 'gpt-live-transcribe' });
    client.audio(new Uint8Array([1, 2]).buffer);
    first.close();
    client.audio(new Uint8Array([3, 4]).buffer);
    client.commit();
    client.endInput();
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.instances[1];
    second.open();
    second.message({ type: 'session.ready', provider: 'openai', model: 'gpt-live-transcribe' });
    expect(second.sent.slice(1)).toEqual([
      { type: 'audio.chunk', pcm16Base64: 'AQI=' },
      { type: 'audio.chunk', pcm16Base64: 'AwQ=' },
      { type: 'audio.commit' },
      { type: 'audio.end' },
    ]);
    expect(events).toContain('session.reconnecting');
    client.stop();
  });
  it('replays an entire unfinalized commit and clears the old interim wait', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
    vi.stubGlobal('WebSocket', FakeSocket);
    const events = vi.fn();
    const start = {
      type: 'session.start',
      provider: 'openai',
      model: 'gpt-live-transcribe',
      sampleRate: 24000,
      track: 'mic',
    } as const;
    const client = new LiveSttClient(start, events);
    const ready = { type: 'session.ready', provider: start.provider, model: start.model };
    client.connect();
    const first = FakeSocket.instances[0];
    first.open();
    first.message(ready);
    client.noteSpeechStart();
    client.audio(new Uint8Array([99]).buffer);
    client.commit();
    first.message({ type: 'transcript.committed', segmentId: 'done' });
    first.message({
      type: 'transcript.final',
      segmentId: 'done',
      track: 'mic',
      text: 'already saved',
    });
    client.noteSpeechStart();
    for (let i = 0; i < 8; i++) client.audio(new Uint8Array([i]).buffer);
    client.commit();
    first.message({ type: 'transcript.committed', segmentId: 'lost' });
    first.message({ type: 'transcript.interim', segmentId: 'lost', track: 'mic', text: 'partial' });
    first.close();
    expect(events.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'session.reconnecting',
      discardedInterims: [expect.stringMatching(/:lost$/)],
    });
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.instances[1];
    second.open();
    second.message(ready);
    await vi.advanceTimersByTimeAsync(40);
    expect(second.sent.slice(1)).toEqual(first.sent.slice(3));
    second.message({ type: 'transcript.committed', segmentId: 'retry' });
    second.message({
      type: 'transcript.final',
      segmentId: 'retry',
      track: 'mic',
      text: 'complete',
    });
    const complete = client.waitForFinal(100);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await complete).toBe(true);
    client.stop();
  });
});

describe('out-of-order live results', () => {
  it('waits for every unfinished segment rather than only the last event', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
    vi.stubGlobal('WebSocket', FakeSocket);
    const client = new LiveSttClient(
      {
        type: 'session.start',
        provider: 'openai',
        model: 'gpt-live-transcribe',
        sampleRate: 24000,
        track: 'mic',
      },
      () => {},
    );
    client.connect();
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.message({ type: 'session.ready', provider: 'openai', model: 'gpt-live-transcribe' });
    socket.message({ type: 'transcript.interim', segmentId: 'first', text: 'a', track: 'mic' });
    socket.message({ type: 'transcript.interim', segmentId: 'second', text: 'b', track: 'mic' });
    socket.message({ type: 'transcript.final', segmentId: 'second', text: 'b', track: 'mic' });
    const incomplete = client.waitForFinal(100);
    await vi.advanceTimersByTimeAsync(2200);
    expect(await incomplete).toBe(false);
    socket.message({ type: 'transcript.final', segmentId: 'first', text: 'a', track: 'mic' });
    const complete = client.waitForFinal(100);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await complete).toBe(true);
    client.stop();
  });
});

describe('speech finalization', () => {
  it('waits for a final result even when a provider emitted no interim text', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
    vi.stubGlobal('WebSocket', FakeSocket);
    const client = new LiveSttClient(
      {
        type: 'session.start',
        provider: 'gemini',
        model: 'gemini-3.5-transcribe-live',
        sampleRate: 16000,
        track: 'mic',
      },
      () => {},
    );
    client.connect();
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.message({
      type: 'session.ready',
      provider: 'gemini',
      model: 'gemini-3.5-transcribe-live',
    });
    client.noteSpeechStart();
    const pending = client.waitForFinal(100);
    await vi.advanceTimersByTimeAsync(2200);
    expect(await pending).toBe(false);
    socket.message({ type: 'transcript.final', segmentId: 'one', text: 'hello', track: 'mic' });
    const complete = client.waitForFinal(100);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await complete).toBe(true);
    client.stop();
  });
});
