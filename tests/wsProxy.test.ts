import { createServer } from 'node:http';
import { on, once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSession,
  createUser,
  deleteSessionByCookie,
  SESSION_COOKIE_NAME,
  updateUser,
} from '../src/server/auth';
import { resetDbForTesting } from '../src/server/db';
import { listUnsettledUsage, queryUsageReport } from '../src/server/usage';
import { attachSttProxy } from '../src/server/ws/sttProxy';
import type { SttServerEvent } from '../src/shared/protocol';

function createAuthCookie(allowServerKeys = true): string {
  const user = createUser({
    username: `ws_${Math.random().toString(36).slice(2, 8)}`,
    displayName: 'WS Tester',
    password: 'password123',
    role: 'user',
    allowServerKeys,
  });
  const { token } = createSession(user.id);
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
}

describe('websocket proxy', () => {
  const server = createServer();
  let port: number;
  let cookie = '';

  afterEach(() => vi.unstubAllEnvs());
  beforeAll(async () => {
    resetDbForTesting(':memory:');
    cookie = createAuthCookie(true);
    attachSttProxy(server, () => {
      throw new Error('fixture connection setup failure');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('rejects unauthenticated upgrade requests with 401', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/stt`, {
      origin: `http://127.0.0.1:${port}`,
    });
    const [_req, res] = await once(socket, 'unexpected-response');
    expect(res.statusCode).toBe(401);
  });

  it('rejects a rebound hostname even if its origin matches the host', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/stt`, {
      origin: 'http://attacker.invalid:3001',
      headers: { Host: 'attacker.invalid:3001', Cookie: cookie },
    });
    const [error] = await once(socket, 'error');
    expect(error).toBeInstanceOf(Error);
  });

  it('enforces allowServerKeys on configured HTTPS origins', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'server-secret');
    vi.stubEnv('POLYMEET_HTTPS_ORIGINS', 'https://meet.example.ts.net');
    const restrictedCookie = createAuthCookie(false);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/stt`, {
      origin: 'https://meet.example.ts.net',
      headers: { Host: 'meet.example.ts.net', Cookie: restrictedCookie },
    });
    await once(socket, 'open');
    const message = once(socket, 'message');
    const closed = once(socket, 'close');
    socket.send(
      JSON.stringify({
        type: 'session.start',
        provider: 'openai',
        model: 'gpt-live-transcribe',
        sampleRate: 24000,
        track: 'mic',
      }),
    );
    expect(JSON.parse((await message)[0].toString())).toMatchObject({
      type: 'error',
      code: 'missing_api_key',
    });
    await closed;
  });

  it('rejects invalid startup messages without opening an upstream connection', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/stt`, {
      origin: `http://127.0.0.1:${port}`,
      headers: { Cookie: cookie },
    });
    await once(socket, 'open');
    const message = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'session.start', provider: 'invalid' }));
    const [data] = await message;
    expect(JSON.parse(data.toString())).toMatchObject({ type: 'error', code: 'invalid_start' });
    const [code] = await once(socket, 'close');
    expect(code).toBe(1008);
  });

  it('returns a client error when the provider connection could not be created', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/stt`, {
      origin: `http://127.0.0.1:${port}`,
      headers: { Cookie: cookie },
    });
    await once(socket, 'open');
    const message = once(socket, 'message');
    const closed = once(socket, 'close');
    socket.send(
      JSON.stringify({
        type: 'session.start',
        provider: 'openai',
        model: 'gpt-live-transcribe',
        sampleRate: 24000,
        track: 'mic',
        apiKey: 'test-key',
      }),
    );
    expect(JSON.parse((await message)[0].toString())).toMatchObject({
      type: 'error',
      code: 'provider_error',
      recoverable: false,
    });
    expect((await closed)[0]).toBe(1008);
  });
});

describe('websocket setup and recovery', () => {
  const readyTimeoutMs = 50;
  let fake: WebSocketServer;
  let proxy: ReturnType<typeof createServer>;
  let client: WebSocket;
  let cookie = '';

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    resetDbForTesting(':memory:');
    cookie = createAuthCookie(true);
    fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(fake, 'listening');
    const upstreamPort = (fake.address() as { port: number }).port;
    proxy = createServer();
    attachSttProxy(proxy, () => new WebSocket(`ws://127.0.0.1:${upstreamPort}`), readyTimeoutMs);
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const proxyPort = (proxy.address() as { port: number }).port;
    client = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws/stt`, {
      origin: `http://127.0.0.1:${proxyPort}`,
      headers: { Cookie: cookie },
    });
    await once(client, 'open');
  });

  afterEach(async () => {
    client?.terminate();
    for (const upstream of fake.clients) upstream.terminate();
    await Promise.all([
      new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      ),
      new Promise<void>((resolve, reject) =>
        fake.close((error) => (error ? reject(error) : resolve())),
      ),
    ]);
    vi.useRealTimers();
  });

  async function startSession() {
    const setup = once(fake, 'connection').then(async ([upstream]: [WebSocket]) => {
      const [payload] = await once(upstream, 'message');
      expect(JSON.parse(payload.toString())).toMatchObject({ type: 'session.update' });
      return upstream;
    });
    client.send(
      JSON.stringify({
        type: 'session.start',
        provider: 'openai',
        model: 'gpt-live-transcribe',
        sampleRate: 24000,
        track: 'mic',
        apiKey: 'test-key',
      }),
    );
    return setup;
  }

  it('retries when the upstream opens but never acknowledges setup', async () => {
    const events: SttServerEvent[] = [];
    client.on('message', (data) => events.push(JSON.parse(data.toString())));
    const upstream = await startSession();
    const clientClosed = once(client, 'close');
    const upstreamClosed = once(upstream, 'close');

    vi.advanceTimersByTime(readyTimeoutMs);

    expect((await clientClosed)[0]).toBe(1012);
    await upstreamClosed;
    expect(events).toEqual([{ type: 'session.reconnecting', reason: 'upstream_ready_timeout' }]);
  });

  it('keeps forwarding audio and transcripts after an upstream item fails', async () => {
    const upstream = await startSession();
    const events = on(client, 'message', { close: ['close'] });
    const nextEvent = async (): Promise<SttServerEvent | undefined> => {
      const { value } = await events.next();
      return value && JSON.parse(value[0].toString());
    };
    const sendAudio = async () => {
      const audio = once(upstream, 'message');
      client.send(JSON.stringify({ type: 'audio.chunk', pcm16Base64: 'AQI=' }));
      expect(JSON.parse((await audio)[0].toString())).toEqual({
        type: 'input_audio_buffer.append',
        audio: 'AQI=',
      });
    };
    upstream.send(JSON.stringify({ type: 'session.updated' }));
    expect(await nextEvent()).toMatchObject({ type: 'session.ready' });
    vi.advanceTimersByTime(readyTimeoutMs);
    await sendAudio();

    upstream.send(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'failed-item',
        delta: 'Partial text',
      }),
    );
    upstream.send(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.failed',
        item_id: 'failed-item',
        error: { message: 'private provider error' },
      }),
    );
    expect(await nextEvent()).toMatchObject({ type: 'transcript.interim', text: 'Partial text' });
    expect(await nextEvent()).toEqual({
      type: 'transcript.final',
      segmentId: 'failed-item',
      text: '',
      track: 'mic',
      failed: true,
    });
    expect(await nextEvent()).toEqual({
      type: 'error',
      code: 'transcript_failed',
      message: '這段音訊轉錄失敗，即時轉錄會繼續。',
      recoverable: true,
    });

    await sendAudio();
    upstream.send(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'next-item',
        transcript: 'Transcription continues',
      }),
    );
    expect(await nextEvent()).toEqual({
      type: 'transcript.final',
      segmentId: 'next-item',
      text: 'Transcription continues',
      track: 'mic',
    });
  });
});

describe('websocket transcription flow and usage tracking', () => {
  beforeEach(() => {
    resetDbForTesting(':memory:');
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each(['permission', 'disable', 'logout'] as const)(
    'closes an active server-key connection when access is revoked by %s',
    async (revoke) => {
      vi.stubEnv('OPENAI_API_KEY', 'fixture-server-key');
      const user = createUser({
        username: 'wsuser',
        displayName: 'User',
        password: 'fixture-password',
      });
      const { token } = createSession(user.id);
      const cookie = `${SESSION_COOKIE_NAME}=${token}`;
      const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      await once(provider, 'listening');
      const providerPort = (provider.address() as { port: number }).port;
      provider.on('connection', (upstream) =>
        upstream.once('message', () => upstream.send(JSON.stringify({ type: 'session.updated' }))),
      );

      const server = createServer();
      attachSttProxy(server, () => new WebSocket(`ws://127.0.0.1:${providerPort}`));
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as { port: number }).port;
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/stt`, {
        origin: `http://127.0.0.1:${port}`,
        headers: { Cookie: cookie },
      });
      try {
        await once(socket, 'open');
        const ready = once(socket, 'message');
        socket.send(
          JSON.stringify({
            type: 'session.start',
            accountId: user.id,
            provider: 'openai',
            model: 'gpt-live-transcribe',
            sampleRate: 24000,
            track: 'mic',
          }),
        );
        expect(JSON.parse((await ready)[0].toString())).toMatchObject({ type: 'session.ready' });

        const notification = once(socket, 'message');
        const closed = once(socket, 'close');
        if (revoke === 'permission') updateUser(user.id, { allowServerKeys: false });
        if (revoke === 'disable') updateUser(user.id, { active: false });
        if (revoke === 'logout') deleteSessionByCookie(cookie);
        expect(JSON.parse((await notification)[0].toString())).toMatchObject({
          type: 'error',
          code: 'session_revoked',
          recoverable: false,
        });
        expect((await closed)[0]).toBe(1008);
      } finally {
        socket.terminate();
        for (const upstream of provider.clients) upstream.terminate();
        await Promise.all([
          new Promise<void>((resolve) => server.close(() => resolve())),
          new Promise<void>((resolve) => provider.close(() => resolve())),
        ]);
      }
    },
  );

  it.each(['gpt-live-transcribe', 'gpt-4o-transcribe'])(
    'finalizes trailing audio and records usage for %s',
    async (model) => {
      vi.stubEnv('OPENAI_API_KEY', 'server-secret');
      const cookie = createAuthCookie(true);
      const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      await once(fake, 'listening');
      const upstreamPort = (fake.address() as { port: number }).port;
      const server = createServer();
      attachSttProxy(server, () => new WebSocket(`ws://127.0.0.1:${upstreamPort}`));
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as { port: number }).port;
      const frames: Record<string, unknown>[] = [];
      fake.on('connection', (upstream) =>
        upstream.on('message', (payload) => {
          const frame = JSON.parse(payload.toString());
          frames.push(frame);
          if (frame.type === 'session.update')
            upstream.send(JSON.stringify({ type: 'session.updated' }));
          if (
            frame.type === 'input_audio_buffer.commit' ||
            (frame.type === 'input_audio_buffer.append' && frame.audio !== 'AQI=')
          )
            upstream.send(
              JSON.stringify({
                type: 'conversation.item.input_audio_transcription.completed',
                item_id: 'one',
                transcript: 'Hello',
                usage:
                  model === 'gpt-4o-transcribe'
                    ? {
                        type: 'tokens',
                        input_tokens: 200,
                        output_tokens: 50,
                        total_tokens: 250,
                        input_token_details: { audio_tokens: 180, text_tokens: 20 },
                      }
                    : { type: 'duration', seconds: 30 },
              }),
            );
        }),
      );
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/stt`, {
        origin: `http://127.0.0.1:${port}`,
        headers: { Cookie: cookie },
      });
      await once(socket, 'open');
      const ready = once(socket, 'message');
      socket.send(
        JSON.stringify({
          type: 'session.start',
          provider: 'openai',
          model,
          sampleRate: 24000,
          track: 'mic',
          meetingId: 'meeting-ws-1',
          meetingTitle: 'WS Meeting',
          usageSessionId: 'session-ws-1',
        }),
      );
      expect(JSON.parse((await ready)[0].toString())).toMatchObject({ type: 'session.ready' });
      const final = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'audio.chunk', pcm16Base64: 'AQI=' }));
      socket.send(JSON.stringify({ type: 'audio.commit' }));
      socket.send(JSON.stringify({ type: 'audio.end' }));
      expect(JSON.parse((await final)[0].toString())).toMatchObject({
        type: 'transcript.final',
        text: 'Hello',
        track: 'mic',
      });
      const usagePromise = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'session.stop' }));
      const usageEvent = JSON.parse((await usagePromise)[0].toString());
      expect(usageEvent).toMatchObject({
        type: 'usage.recorded',
        usage: {
          keySource: 'server_env',
          model,
          meetingId: 'meeting-ws-1',
        },
      });
      if (model === 'gpt-4o-transcribe') {
        expect(usageEvent.usage.totalTokens).toBe(250);
        expect(usageEvent.usage.audioInputTokens).toBe(180);
      } else {
        expect(usageEvent.usage.audioSeconds).toBe(30);
        expect(usageEvent.usage.costUsd).toBeCloseTo(0.0085, 6);
      }
      const report = queryUsageReport({ keySource: 'server_env' });
      expect(report.dailyMeetings).toHaveLength(1);
      expect(frames).toContainEqual({ type: 'input_audio_buffer.append', audio: 'AQI=' });
      if (model === 'gpt-live-transcribe') {
        expect(frames).toHaveLength(3);
        expect(frames[2]).toEqual({ type: 'input_audio_buffer.commit' });
      } else {
        expect(frames).toHaveLength(3);
        expect(frames[2].type).toBe('input_audio_buffer.append');
        expect(Buffer.from(String(frames[2].audio), 'base64')).toEqual(Buffer.alloc(28_800));
      }
      expect(JSON.stringify(frames)).not.toContain('server-secret');
      await once(socket, 'close');
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await new Promise<void>((resolve, reject) =>
        fake.close((error) => (error ? reject(error) : resolve())),
      );
    },
  );
});

describe('Gemini websocket transcription', () => {
  beforeEach(() => {
    resetDbForTesting(':memory:');
  });

  it('forwards 16 kHz audio, emits final text without turnComplete, and aggregates peak prompt tokens + per-turn output tokens', async () => {
    const cookie = createAuthCookie(true);
    const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(fake, 'listening');
    const upstreamPort = (fake.address() as { port: number }).port;
    const server = createServer();
    attachSttProxy(server, () => new WebSocket(`ws://127.0.0.1:${upstreamPort}`));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const frames: Record<string, any>[] = [];
    fake.on('connection', (upstream) =>
      upstream.on('message', (payload) => {
        const frame = JSON.parse(payload.toString());
        frames.push(frame);
        if (frame.setup) upstream.send(JSON.stringify({ setupComplete: {} }));
        if (frame.realtimeInput?.audioStreamEnd) {
          upstream.send(
            JSON.stringify({
              usageMetadata: {
                promptTokenCount: 500,
                promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 450 }],
                responseTokenCount: 20,
              },
            }),
          );
          upstream.send(
            JSON.stringify({
              serverContent: { inputTranscription: { text: '測試' } },
              usageMetadata: {
                promptTokenCount: 800,
                promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 720 }],
                responseTokenCount: 30,
              },
            }),
          );
        }
      }),
    );
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/stt`, {
      origin: `http://127.0.0.1:${port}`,
      headers: { Cookie: cookie },
    });
    await once(socket, 'open');
    const ready = once(socket, 'message');
    socket.send(
      JSON.stringify({
        type: 'session.start',
        provider: 'gemini',
        model: 'gemini-3.5-transcribe-live',
        sampleRate: 16000,
        track: 'system',
        apiKey: 'test-key',
      }),
    );
    expect(JSON.parse((await ready)[0].toString())).toMatchObject({ type: 'session.ready' });
    const events = on(socket, 'message', { close: ['close'] });
    const nextEvent = async () => JSON.parse((await events.next()).value[0].toString());
    socket.send(JSON.stringify({ type: 'audio.chunk', pcm16Base64: 'AQI=' }));
    socket.send(JSON.stringify({ type: 'audio.commit' }));
    expect(await nextEvent()).toMatchObject({
      type: 'transcript.final',
      text: '測試',
      track: 'system',
    });
    socket.send(JSON.stringify({ type: 'session.stop' }));
    const usageEvent = await nextEvent();
    expect(usageEvent).toMatchObject({
      type: 'usage.recorded',
      usage: {
        provider: 'gemini',
        keySource: 'byok',
        audioInputTokens: 720,
        textInputTokens: 80,
        outputTokens: 50,
        totalTokens: 850,
      },
    });
    expect(frames[1]).toEqual({
      realtimeInput: { audio: { data: 'AQI=', mimeType: 'audio/pcm;rate=16000' } },
    });
    expect(frames[2]).toEqual({ realtimeInput: { audioStreamEnd: true } });
    expect(JSON.stringify(frames)).not.toContain('test-key');
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      fake.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('trims model names, handles goAway without duplicate reconnects, and rejects 401 handshakes', async () => {
    const cookie = createAuthCookie(true);
    const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(fake, 'listening');
    const upstreamPort = (fake.address() as { port: number }).port;
    const server = createServer();
    attachSttProxy(server, () => new WebSocket(`ws://127.0.0.1:${upstreamPort}`));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const frames: Record<string, any>[] = [];
    fake.on('connection', (upstream) =>
      upstream.on('message', (payload) => {
        const frame = JSON.parse(payload.toString());
        frames.push(frame);
        if (frame.setup) {
          upstream.send(JSON.stringify({ setupComplete: {} }));
          upstream.send(JSON.stringify({ goAway: { timeLeft: '5s' } }));
        }
      }),
    );
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/stt`, {
      origin: `http://127.0.0.1:${port}`,
      headers: { Cookie: cookie },
    });
    const received: Record<string, unknown>[] = [];
    socket.on('message', (data) => received.push(JSON.parse(data.toString())));
    await once(socket, 'open');
    socket.send(
      JSON.stringify({
        type: 'session.start',
        provider: 'gemini',
        model: '  gemini-3.5-transcribe-live  ',
        sampleRate: 16000,
        track: 'mic',
        apiKey: 'test-key',
      }),
    );
    const [closeCode] = await once(socket, 'close');
    expect(closeCode).toBe(1012);
    expect(frames[0].setup.model).toBe('models/gemini-3.5-transcribe-live');
    expect(received.filter((event) => event.type === 'session.reconnecting')).toHaveLength(1);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      fake.close((error) => (error ? reject(error) : resolve())),
    );

    // Verify upstream 401 handshake fails as non-recoverable auth_failed instead of reconnecting.
    const authFailUpstream = createServer((_req, res) => {
      res.writeHead(401);
      res.end('Unauthorized');
    });
    authFailUpstream.listen(0, '127.0.0.1');
    await once(authFailUpstream, 'listening');
    const authPort = (authFailUpstream.address() as { port: number }).port;
    const proxy2 = createServer();
    attachSttProxy(proxy2, () => new WebSocket(`ws://127.0.0.1:${authPort}`));
    proxy2.listen(0, '127.0.0.1');
    await once(proxy2, 'listening');
    const proxy2Port = (proxy2.address() as { port: number }).port;
    const client2 = new WebSocket(`ws://127.0.0.1:${proxy2Port}/ws/stt`, {
      origin: `http://127.0.0.1:${proxy2Port}`,
      headers: { Cookie: cookie },
    });
    await once(client2, 'open');
    const errEvent = once(client2, 'message');
    client2.send(
      JSON.stringify({
        type: 'session.start',
        provider: 'openai',
        model: 'gpt-live-transcribe',
        sampleRate: 24000,
        track: 'mic',
        apiKey: 'bad-key',
      }),
    );
    const [errBuf] = await errEvent;
    expect(JSON.parse(errBuf.toString())).toMatchObject({
      type: 'error',
      code: 'auth_failed',
      recoverable: false,
    });
    const [code2] = await once(client2, 'close');
    expect(code2).toBe(1008);
    await new Promise<void>((resolve, reject) =>
      proxy2.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      authFailUpstream.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('drops empty or unaligned base64 audio chunks before forwarding upstream', async () => {
    const cookie = createAuthCookie(true);
    const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(fake, 'listening');
    const upstreamPort = (fake.address() as { port: number }).port;
    const server = createServer();
    attachSttProxy(server, () => new WebSocket(`ws://127.0.0.1:${upstreamPort}`));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const frames: Record<string, unknown>[] = [];
    fake.on('connection', (upstream) =>
      upstream.on('message', (payload) => {
        const frame = JSON.parse(payload.toString());
        frames.push(frame);
        if (frame.type === 'session.update')
          upstream.send(JSON.stringify({ type: 'session.updated' }));
        if (frame.type === 'input_audio_buffer.commit')
          upstream.send(
            JSON.stringify({
              type: 'conversation.item.input_audio_transcription.completed',
              item_id: 'valid',
              transcript: 'Done',
            }),
          );
      }),
    );
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/stt`, {
      origin: `http://127.0.0.1:${port}`,
      headers: { Cookie: cookie },
    });
    await once(socket, 'open');
    const ready = once(socket, 'message');
    socket.send(
      JSON.stringify({
        type: 'session.start',
        provider: 'openai',
        model: 'gpt-live-transcribe',
        sampleRate: 24000,
        track: 'mic',
        apiKey: 'test-key',
      }),
    );
    await ready;
    const final = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'audio.chunk', pcm16Base64: '' }));
    socket.send(JSON.stringify({ type: 'audio.chunk', pcm16Base64: 'AQI' }));
    socket.send(JSON.stringify({ type: 'audio.chunk', pcm16Base64: 'AQI=' }));
    socket.send(JSON.stringify({ type: 'audio.commit' }));
    await final;
    expect(frames.filter((frame) => frame.type === 'input_audio_buffer.append')).toEqual([
      { type: 'input_audio_buffer.append', audio: 'AQI=' },
    ]);
    socket.close();
    await once(socket, 'close');
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      fake.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('pre-registers pending usage on first audio chunk and flags token-only live models missing provider usage for reconciliation', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'server-gemini-secret');
    const cookie = createAuthCookie(true);
    const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(fake, 'listening');
    const upstreamPort = (fake.address() as { port: number }).port;
    const server = createServer();
    const wss = attachSttProxy(server, () => new WebSocket(`ws://127.0.0.1:${upstreamPort}`));
    expect(wss).toBeInstanceOf(WebSocketServer);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const audioReceived = new Promise<void>((resolve) => {
      fake.on('connection', (upstream) =>
        upstream.on('message', (payload) => {
          const frame = JSON.parse(payload.toString());
          if (frame.setup) upstream.send(JSON.stringify({ setupComplete: {} }));
          if (frame.realtimeInput?.audio) resolve();
        }),
      );
    });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/stt`, {
      origin: `http://127.0.0.1:${port}`,
      headers: { Cookie: cookie },
    });
    await once(socket, 'open');
    const ready = once(socket, 'message');
    socket.send(
      JSON.stringify({
        type: 'session.start',
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        sampleRate: 16000,
        track: 'mic',
        meetingId: 'm-live-pending',
        meetingTitle: 'Dropped Live Call',
      }),
    );
    await ready;
    socket.send(JSON.stringify({ type: 'audio.chunk', pcm16Base64: 'AQI=' }));
    await audioReceived;

    // Pre-flight pending entry exists before socket closes
    expect(listUnsettledUsage({ keySource: 'server_env' }).entries).toHaveLength(1);

    // Abrupt close without usageMetadata must remain pendingReconciliation instead of silent $0
    socket.close();
    await once(socket, 'close');
    await vi.waitFor(() =>
      expect(queryUsageReport({ keySource: 'server_env' }).totals).toMatchObject({
        pendingCalls: 1,
        costUsd: 0,
      }),
    );
    expect(listUnsettledUsage({ keySource: 'server_env' }).entries).toMatchObject([
      {
        model: 'gemini-3.8-flash',
        pendingReconciliation: true,
        pricingMissing: false,
      },
    ]);

    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      fake.close((error) => (error ? reject(error) : resolve())),
    );
  });
});
