import WebSocket, { WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import type { SttStart, SttServerEvent } from '../../shared/protocol';
import { createEventMapper, geminiConfiguration, openAiConfiguration } from './adapters';
import { isAllowedOrigin } from '../origin';

type UpstreamFactory = (start: SttStart, key: string) => WebSocket;
function connectProvider(start: SttStart, key: string): WebSocket {
  const url =
    start.provider === 'openai'
      ? 'wss://api.openai.com/v1/realtime?intent=transcription'
      : `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`;
  return new WebSocket(
    url,
    start.provider === 'openai' ? { headers: { Authorization: `Bearer ${key}` } } : {},
  );
}
export function attachSttProxy(server: Server, connect: UpstreamFactory = connectProvider) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;
    if (request.url !== '/ws/stt' || !origin || !isAllowedOrigin(request.headers.host, origin)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client));
  });
  wss.on('connection', (client) => {
    let upstream: WebSocket | undefined;
    let started = false,
      ready = false,
      closing = false,
      manualCommit = false,
      provider: 'openai' | 'gemini' = 'openai';
    const send = (event: SttServerEvent) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
    };
    const fail = (code: string, message: string) => {
      send({ type: 'error', code, message, recoverable: false });
      client.close(1008);
    };
    const timeout = setTimeout(() => {
      if (!started) fail('start_timeout', '連線逾時。');
    }, 10000);
    client.on('message', (raw, binary) => {
      if (binary) {
        fail('invalid_message', '無效的連線訊息。');
        return;
      }
      let data: any;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        fail('invalid_message', '無效的連線訊息。');
        return;
      }
      if (!started) {
        if (
          data?.type !== 'session.start' ||
          !['openai', 'gemini'].includes(data.provider) ||
          typeof data.model !== 'string' ||
          !data.model.trim() ||
          data.model.length > 200 ||
          !['mic', 'system'].includes(data.track) ||
          data.sampleRate !== (data.provider === 'openai' ? 24000 : 16000) ||
          (data.apiKey !== undefined && typeof data.apiKey !== 'string') ||
          (data.languageHints !== undefined &&
            (!Array.isArray(data.languageHints) ||
              data.languageHints.length > 2 ||
              !data.languageHints.every(
                (hint: unknown) => typeof hint === 'string' && /^[a-z]{2}-[A-Z]{2}$/.test(hint),
              )))
        ) {
          fail('invalid_start', '即時轉錄設定無效。');
          return;
        }
        started = true;
        clearTimeout(timeout);
        const start = data as SttStart;
        provider = start.provider;
        const key =
          start.apiKey?.trim() ||
          (start.provider === 'openai'
            ? process.env.OPENAI_API_KEY
            : process.env.GEMINI_API_KEY
          )?.trim();
        if (!key) {
          fail('missing_api_key', '請設定即時轉錄的 API 金鑰。');
          return;
        }
        manualCommit =
          start.provider === 'openai' &&
          ['gpt-live-transcribe', 'gpt-transcribe', 'gpt-realtime-whisper'].includes(start.model);
        upstream = connect(start, key);
        const map = createEventMapper(start);
        upstream.on('open', () =>
          upstream?.send(
            JSON.stringify(
              start.provider === 'openai' ? openAiConfiguration(start) : geminiConfiguration(start),
            ),
          ),
        );
        upstream.on('message', (message) => {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(message.toString());
          } catch {
            return;
          }
          for (const event of map(parsed)) {
            if (event.type === 'session.ready') ready = true;
            send(event);
            if (event.type === 'session.reconnecting') upstream?.close();
            if (event.type === 'error') {
              closing = true;
              upstream?.close();
              client.close(1008);
            }
          }
        });
        upstream.on('error', () => {
          if (!closing)
            send({
              type: 'error',
              code: 'upstream_connection',
              message: '無法連接即時轉錄服務。',
              recoverable: true,
            });
        });
        upstream.on('close', () => {
          if (!closing && client.readyState === WebSocket.OPEN) {
            send({ type: 'session.reconnecting', reason: 'upstream_closed' });
            client.close(1012);
          }
        });
        return;
      }
      if (data?.type === 'session.stop') {
        closing = true;
        upstream?.close();
        client.close(1000);
        return;
      }
      if (!ready || upstream?.readyState !== WebSocket.OPEN) return;
      if (
        data?.type === 'audio.chunk' &&
        typeof data.pcm16Base64 === 'string' &&
        data.pcm16Base64.length <= 32000 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(data.pcm16Base64)
      ) {
        upstream.send(
          JSON.stringify(
            provider === 'openai'
              ? { type: 'input_audio_buffer.append', audio: data.pcm16Base64 }
              : {
                  realtimeInput: {
                    audio: { data: data.pcm16Base64, mimeType: 'audio/pcm;rate=16000' },
                  },
                },
          ),
        );
      } else if (data?.type === 'audio.commit') {
        if (manualCommit) upstream.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        else if (provider === 'gemini')
          upstream.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      }
    });
    client.on('close', () => {
      closing = true;
      clearTimeout(timeout);
      upstream?.close();
    });
    client.on('error', () => {
      closing = true;
      upstream?.close();
    });
  });
}
