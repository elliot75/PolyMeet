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
});
