import WebSocket, { WebSocketServer } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type { SttStart, SttServerEvent } from '../../shared/protocol';
import type { AuthUser, KeySource, UsageMetric } from '../../shared/types';
import { usesManualCommit } from '../../shared/models';
import { findModelPricing } from '../../shared/pricing';
import { getSessionUser, subscribeToAuthChanges } from '../auth';
import { createEventMapper, geminiConfiguration, openAiConfiguration } from './adapters';
import { isAllowedOrigin } from '../origin';
import { resolveWsProviderKey } from '../config';
import { listModelPricing, recordUsageEvent } from '../usage';

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
  const upgradeUsers = new WeakMap<IncomingMessage, AuthUser>();

  server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;
    if (request.url !== '/ws/stt' || !origin || !isAllowedOrigin(request.headers.host, origin)) {
      socket.destroy();
      return;
    }
    const user = getSessionUser(request.headers.cookie);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    upgradeUsers.set(request, user);
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
  });

  wss.on('connection', (client, request) => {
    const user = upgradeUsers.get(request);
    if (!user) {
      client.close(1008);
      return;
    }

    let upstream: WebSocket | undefined;
    let started = false,
      ready = false,
      closing = false,
      manualCommit = false,
      provider: 'openai' | 'gemini' = 'openai';
    let keySource: KeySource | undefined;
    let modelName = '';
    let sampleRate: 16000 | 24000 = 16000;
    let meetingId: string | undefined;
    let meetingTitle: string | undefined;
    let usageSessionId: string | undefined;
    let sessionStartedAt = Date.now();
    let totalAudioBytes = 0;

    // OpenAI Realtime per-item usage totals
    let openaiTextIn = 0;
    let openaiAudioIn = 0;
    let openaiOut = 0;
    let openaiTotal = 0;
    let openaiUsageSeconds = 0;
    let hasOpenaiUsage = false;

    // Gemini Live usage tracking (promptTokenCount is cumulative context; response/candidates is per-turn)
    let geminiPeakPromptTokens = 0;
    let geminiPeakAudioInTokens = 0;
    let geminiPeakCachedTokens = 0;
    let geminiOutTokens = 0;
    let hasGeminiUsage = false;
    let usageFlushed = false;
    let usageId: string | undefined;

    let upstreamReadyTimeout: ReturnType<typeof setTimeout> | undefined;
    const send = (event: SttServerEvent) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
    };

    const ensurePendingUsage = () => {
      if (usageId || usageFlushed || !started || !keySource || !modelName) return;
      try {
        usageId = recordUsageEvent({
          userId: user.id,
          meetingId,
          meetingTitle,
          usageSessionId,
          operation: 'live_stt',
          provider,
          model: modelName,
          keySource,
          startedAt: sessionStartedAt,
          endedAt: sessionStartedAt,
          pendingReconciliation: true,
        }).id;
      } catch {
        // Usage pre-registration must not interrupt audio forwarding.
      }
    };

    const flushUsage = (): UsageMetric | undefined => {
      if (usageFlushed || !started || !keySource || !modelName) return undefined;
      const audioSeconds = sampleRate > 0 ? totalAudioBytes / (sampleRate * 2) : 0;
      const hasProviderUsage = provider === 'openai' ? hasOpenaiUsage : hasGeminiUsage;
      if (!ready && audioSeconds === 0 && !hasProviderUsage && !usageId) return undefined;
      usageFlushed = true;
      const endedAt = Date.now();
      const durationSeconds = Math.max(0, (endedAt - sessionStartedAt) / 1000);
      const pricing = findModelPricing(listModelPricing(sessionStartedAt), provider, modelName);

      if (provider === 'openai') {
        const billedAudioSeconds = Math.max(audioSeconds, openaiUsageSeconds);
        const canEstimateByMinute = Boolean(
          pricing && pricing.perMinute > 0 && billedAudioSeconds > 0,
        );
        const pendingReconciliation =
          !hasOpenaiUsage && billedAudioSeconds > 0 && !canEstimateByMinute;
        return recordUsageEvent({
          id: usageId,
          userId: user.id,
          meetingId,
          meetingTitle,
          usageSessionId,
          operation: 'live_stt',
          provider,
          model: modelName,
          keySource,
          startedAt: sessionStartedAt,
          endedAt,
          durationSeconds,
          audioSeconds: billedAudioSeconds,
          textInputTokens: openaiTextIn,
          audioInputTokens: openaiAudioIn,
          cachedInputTokens: 0,
          outputTokens: openaiOut,
          totalTokens: openaiTotal || openaiTextIn + openaiAudioIn + openaiOut,
          estimated: !hasOpenaiUsage && canEstimateByMinute,
          pendingReconciliation,
        });
      }

      const canEstimateByMinute = Boolean(pricing && pricing.perMinute > 0 && audioSeconds > 0);
      const pendingReconciliation = !hasGeminiUsage && audioSeconds > 0 && !canEstimateByMinute;
      const audioInputTokens =
        geminiPeakAudioInTokens > 0 ? geminiPeakAudioInTokens : geminiPeakPromptTokens;
      const textInputTokens = Math.max(0, geminiPeakPromptTokens - audioInputTokens);
      return recordUsageEvent({
        id: usageId,
        userId: user.id,
        meetingId,
        meetingTitle,
        usageSessionId,
        operation: 'live_stt',
        provider,
        model: modelName,
        keySource,
        startedAt: sessionStartedAt,
        endedAt,
        durationSeconds,
        audioSeconds,
        textInputTokens,
        audioInputTokens,
        cachedInputTokens: geminiPeakCachedTokens,
        outputTokens: geminiOutTokens,
        totalTokens: geminiPeakPromptTokens + geminiOutTokens,
        estimated: !hasGeminiUsage && canEstimateByMinute,
        pendingReconciliation,
      });
    };

    const cleanup = () => {
      if (closing) return;
      closing = true;
      clearTimeout(startTimeout);
      clearTimeout(upstreamReadyTimeout);
      clearInterval(authTimer);
      unsubscribeAuth();
      try {
        flushUsage();
      } catch {
        // Usage persistence must not break socket cleanup.
      }
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
    const revalidateSession = (): AuthUser | undefined => {
      try {
        const current = getSessionUser(request.headers.cookie);
        if (current?.id === user.id && (keySource !== 'server_env' || current.allowServerKeys)) {
          return current;
        }
      } catch {
        // Provider access must stop if session validation becomes unavailable.
      }
      fail('session_revoked', '登入或系統金鑰權限已失效，已停止即時轉錄。');
      return undefined;
    };
    const unsubscribeAuth = subscribeToAuthChanges(revalidateSession);
    const authTimer = setInterval(revalidateSession, 5000);
    authTimer.unref();

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
          (data.meetingId !== undefined &&
            (typeof data.meetingId !== 'string' || data.meetingId.length > 120)) ||
          (data.meetingTitle !== undefined &&
            (typeof data.meetingTitle !== 'string' || data.meetingTitle.length > 200)) ||
          (data.recordingId !== undefined &&
            (typeof data.recordingId !== 'string' || data.recordingId.length > 120)) ||
          (data.usageSessionId !== undefined &&
            (typeof data.usageSessionId !== 'string' || data.usageSessionId.length > 120)) ||
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
        if (data.accountId !== undefined && data.accountId !== user.id) {
          fail('account_changed', '登入帳號已變更，請重新開啟工作區。');
          return;
        }
        const currentUser = revalidateSession();
        if (!currentUser) return;
        started = true;
        clearTimeout(startTimeout);
        const rawStart = data as SttStart;
        const start: SttStart = { ...rawStart, model: rawStart.model.trim() };
        provider = start.provider;
        modelName = start.model;
        sampleRate = start.sampleRate;
        meetingId = start.meetingId?.trim() || undefined;
        meetingTitle = start.meetingTitle?.trim() || undefined;
        usageSessionId = start.usageSessionId?.trim() || undefined;
        sessionStartedAt = Date.now();

        const resolved = resolveWsProviderKey(start.provider, start.apiKey, currentUser);
        if (!resolved) {
          fail('missing_api_key', '請設定即時轉錄的 API 金鑰。');
          return;
        }
        keySource = resolved.keySource;
        manualCommit = usesManualCommit(start.provider, start.model);
        try {
          upstream = connect(start, resolved.key);
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
          let parsed: Record<string, any>;
          try {
            parsed = JSON.parse(message.toString());
          } catch {
            return;
          }

          if (
            provider === 'openai' &&
            parsed.type === 'conversation.item.input_audio_transcription.completed' &&
            parsed.usage &&
            typeof parsed.usage === 'object'
          ) {
            hasOpenaiUsage = true;
            if (parsed.usage.type === 'tokens') {
              const totalIn = Number(parsed.usage.input_tokens) || 0;
              const explicitAudio = Number(parsed.usage.input_token_details?.audio_tokens) || 0;
              const explicitText = Number(parsed.usage.input_token_details?.text_tokens) || 0;
              if (explicitAudio > 0 || explicitText > 0) {
                openaiAudioIn += explicitAudio;
                openaiTextIn += Math.max(0, totalIn - explicitAudio);
              } else {
                openaiAudioIn += totalIn;
              }
              const out = Number(parsed.usage.output_tokens) || 0;
              openaiOut += out;
              openaiTotal += Number(parsed.usage.total_tokens) || totalIn + out;
            } else if (
              parsed.usage.type === 'duration' &&
              typeof parsed.usage.seconds === 'number' &&
              Number.isFinite(parsed.usage.seconds)
            ) {
              openaiUsageSeconds += Math.max(0, parsed.usage.seconds);
            }
          }

          if (
            provider === 'gemini' &&
            parsed.usageMetadata &&
            typeof parsed.usageMetadata === 'object'
          ) {
            hasGeminiUsage = true;
            const meta = parsed.usageMetadata as {
              promptTokenCount?: number;
              cachedContentTokenCount?: number;
              responseTokenCount?: number;
              candidatesTokenCount?: number;
              thoughtsTokenCount?: number;
              promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
            };
            const prompt = Number(meta.promptTokenCount) || 0;
            if (prompt > geminiPeakPromptTokens) geminiPeakPromptTokens = prompt;
            const cached = Number(meta.cachedContentTokenCount) || 0;
            if (cached > geminiPeakCachedTokens) geminiPeakCachedTokens = cached;
            if (Array.isArray(meta.promptTokensDetails)) {
              const audioTok = meta.promptTokensDetails
                .filter((d) => String(d?.modality || '').toUpperCase() === 'AUDIO')
                .reduce((sum, d) => sum + (Number(d?.tokenCount) || 0), 0);
              if (audioTok > geminiPeakAudioInTokens) geminiPeakAudioInTokens = audioTok;
            }
            const out =
              (Number(meta.responseTokenCount ?? meta.candidatesTokenCount) || 0) +
              (Number(meta.thoughtsTokenCount) || 0);
            geminiOutTokens += out;
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
        try {
          const usage = flushUsage();
          if (usage) send({ type: 'usage.recorded', usage });
        } catch {
          // Ignore usage write failures during teardown.
        }
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
        ensurePendingUsage();
        totalAudioBytes += Buffer.from(data.pcm16Base64, 'base64').length;
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

  return wss;
}
