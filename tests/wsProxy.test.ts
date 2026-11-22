import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachSttProxy } from '../src/server/ws/sttProxy';

describe('websocket proxy', () => {
  const server = createServer();
  let port: number;
  beforeAll(async () => {
    attachSttProxy(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  it('rejects a rebound hostname even if its origin matches the host', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/stt`, {
      origin: 'http://attacker.invalid:3001',
      headers: { Host: 'attacker.invalid:3001' },
    });
    const [error] = await once(socket, 'error');
    expect(error).toBeInstanceOf(Error);
  });
  it('rejects invalid startup messages without opening an upstream connection', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/stt`, {
      origin: `http://127.0.0.1:${port}`,
    });
    await once(socket, 'open');
    const message = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'session.start', provider: 'invalid' }));
    const [data] = await message;
    expect(JSON.parse(data.toString())).toMatchObject({ type: 'error', code: 'invalid_start' });
    const [code] = await once(socket, 'close');
    expect(code).toBe(1008);
  });
});

describe('websocket transcription flow', () => {
  it('forwards PCM and manual commits and returns normalized transcript events', async () => {
    const { WebSocketServer } = await import('ws');
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
              item_id: 'one',
              transcript: 'Hello',
            }),
          );
      }),
    );
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/stt`, {
      origin: `http://127.0.0.1:${port}`,
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
    expect(JSON.parse((await ready)[0].toString())).toMatchObject({ type: 'session.ready' });
    const final = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'audio.chunk', pcm16Base64: 'AQI=' }));
    socket.send(JSON.stringify({ type: 'audio.commit' }));
    expect(JSON.parse((await final)[0].toString())).toMatchObject({
      type: 'transcript.final',
      text: 'Hello',
      track: 'mic',
    });
    expect(frames).toContainEqual({ type: 'input_audio_buffer.append', audio: 'AQI=' });
    expect(frames).toContainEqual({ type: 'input_audio_buffer.commit' });
    expect(JSON.stringify(frames)).not.toContain('test-key');
    socket.close();
    await once(socket, 'close');
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      fake.close((error) => (error ? reject(error) : resolve())),
    );
  });
});

describe('Gemini websocket transcription', () => {
  it('forwards 16 kHz audio and emits final text without turnComplete', async () => {
    const { WebSocketServer } = await import('ws');
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
        if (frame.realtimeInput?.audioStreamEnd)
          upstream.send(
            JSON.stringify({ serverContent: { inputTranscription: { text: '測試' } } }),
          );
      }),
    );
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/stt`, {
      origin: `http://127.0.0.1:${port}`,
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
    const final = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'audio.chunk', pcm16Base64: 'AQI=' }));
    socket.send(JSON.stringify({ type: 'audio.commit' }));
    expect(JSON.parse((await final)[0].toString())).toMatchObject({
      type: 'transcript.final',
      text: '測試',
      track: 'system',
    });
    expect(frames[1]).toEqual({
      realtimeInput: { audio: { data: 'AQI=', mimeType: 'audio/pcm;rate=16000' } },
    });
    expect(frames[2]).toEqual({ realtimeInput: { audioStreamEnd: true } });
    expect(JSON.stringify(frames)).not.toContain('test-key');
    socket.close();
    await once(socket, 'close');
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      fake.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('trims model names, handles goAway without duplicate reconnects, and rejects 401 handshakes', async () => {
    const { WebSocketServer } = await import('ws');
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
    const { WebSocketServer } = await import('ws');
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
});
