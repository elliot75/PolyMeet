import WebSocket, { WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import type { SttStart, SttServerEvent } from '../../shared/protocol';
import { usesManualCommit } from '../../shared/models';
import { createEventMapper, geminiConfiguration, openAiConfiguration } from './adapters';
import { isAllowedOrigin } from '../origin';
import { serverProviderKey } from '../config';

// 600 ms of PCM16 at 24 kHz exceeds OpenAI's default 500 ms VAD silence threshold.
const vadTailSilence = Buffer.alloc(24_000 * 2 * 0.6).toString('base64');

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
export function attachSttProxy(
  server: Server,
  connect: UpstreamFactory = connectProvider,
  upstreamReadyTimeoutMs = 10_000,
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;
    if (request.url !== '/ws/stt' || !origin || !isAllowedOrigin(request.headers.host, origin)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
  });
  wss.on('connection', (client, request) => {
    let upstream: WebSocket | undefined;
    let started = false,
      ready = false,
      closing = false,
      manualCommit = false,
      provider: 'openai' | 'gemini' = 'openai';
    let upstreamReadyTimeout: ReturnType<typeof setTimeout> | undefined;
    const send = (event: SttServerEvent) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
    };
    const cleanup = () => {
      if (closing) return;
      closing = true;
      clearTimeout(startTimeout);
      clearTimeout(upstreamReadyTimeout);
      if (ready) upstream?.close();
      else upstream?.terminate();
    };
    const close = (code: number) => {
      cleanup();
      client.close(code);
    };
    const fail = (code: string, message: string) => {
      send({ type: 'error', code, message, recoverable: false });
      close(1008);
    };
    const reconnect = (reason: string) => {
      send({ type: 'session.reconnecting', reason });
      close(1012);
    };
    const startTimeout = setTimeout(() => {
      if (!started) fail('start_timeout', '連線逾時。');
    }, 10_000);
    client.on('message', (raw, binary) => {
      if (closing) return;
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
        clearTimeout(startTimeout);
        const rawStart = data as SttStart;
        const start: SttStart = { ...rawStart, model: rawStart.model.trim() };
        provider = start.provider;
        const key =
          start.apiKey?.trim() ||
          serverProviderKey(
            start.provider,
            request.headers.host,
            request.headers['x-forwarded-host']?.toString(),
          );
        if (!key) {
          fail('missing_api_key', '請設定即時轉錄的 API 金鑰。');
          return;
        }
        manualCommit = usesManualCommit(start.provider, start.model);
        try {
          upstream = connect(start, key);
        } catch {
          fail('provider_error', '無法建立即時轉錄連線，請檢查 API 金鑰與設定。');
          return;
        }
        upstreamReadyTimeout = setTimeout(() => {
          reconnect('upstream_ready_timeout');
        }, upstreamReadyTimeoutMs);
        const map = createEventMapper(start);
        upstream.on('open', () => {
          if (closing) return;
          upstream?.send(
            JSON.stringify(
              start.provider === 'openai' ? openAiConfiguration(start) : geminiConfiguration(start),
            ),
          );
        });
        upstream.on('unexpected-response', (_req, res) => {
          res.resume();
          if (closing) return;
          const status = res.statusCode ?? 0;
          if (status === 401 || status === 403) {
            fail('auth_failed', '即時轉錄驗證失敗，請檢查 API 金鑰與模型權限。');
            return;
          }
          if (status === 400 || status === 404) {
            fail('provider_error', '即時轉錄模型或請求無效，請檢查模型設定。');
            return;
          }
          upstream?.terminate();
        });
        upstream.on('message', (message) => {
          if (closing) return;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(message.toString());
          } catch {
            return;
          }
          for (const event of map(parsed)) {
            if (event.type === 'session.ready') {
              ready = true;
              clearTimeout(upstreamReadyTimeout);
            }
            send(event);
            if (event.type === 'session.reconnecting') {
              close(1012);
              break;
            }
            if (event.type === 'error' && !event.recoverable) {
              close(1008);
              break;
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
          if (!closing) reconnect('upstream_closed');
        });
        return;
      }
      if (data?.type === 'session.stop') {
        close(1000);
        return;
      }
      if (!ready || upstream?.readyState !== WebSocket.OPEN) return;
      if (
        data?.type === 'audio.chunk' &&
        typeof data.pcm16Base64 === 'string' &&
        data.pcm16Base64.length > 0 &&
        data.pcm16Base64.length % 4 === 0 &&
        data.pcm16Base64.length <= 32000 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(data.pcm16Base64)
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
      } else if (data?.type === 'audio.end' && provider === 'openai' && !manualCommit) {
        // Server VAD needs PCM silence to close an active turn after capture stops.
        upstream.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: vadTailSilence }));
      } else if (data?.type === 'audio.commit') {
        if (manualCommit) upstream.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        else if (provider === 'gemini')
          upstream.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      }
    });
    client.on('close', cleanup);
    client.on('error', cleanup);
  });
}
