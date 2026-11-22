import { randomUUID } from 'node:crypto';
import type { SttServerEvent, SttStart } from '../../shared/protocol';
import { usesManualCommit } from '../../shared/models';
import { scriptConverter } from '../language';

export function openAiConfiguration(start: SttStart) {
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: {
            model: start.model,
            ...(start.model === 'gpt-live-transcribe' && start.languageHints?.length
              ? {
                  languages: start.languageHints.map((hint) =>
                    hint.toLowerCase().startsWith('zh-')
                      ? hint.toLowerCase()
                      : hint.split('-')[0].toLowerCase(),
                  ),
                }
              : {}),
          },
          turn_detection: usesManualCommit(start.provider, start.model)
            ? null
            : { type: 'server_vad' },
        },
      },
    },
  };
}
export function geminiConfiguration(start: SttStart) {
  return {
    setup: {
      model: `models/${start.model.replace(/^models\//, '')}`,
      generationConfig: { responseModalities: ['TEXT'] },
      inputAudioTranscription:
        start.model.replace(/^models\//, '') === 'gemini-3.5-transcribe-live' &&
        start.languageHints?.length
          ? { languageCodes: start.languageHints }
          : {},
    },
  };
}
export function createEventMapper(start: SttStart) {
  const convert =
    scriptConverter(start.languageHints || [], true) ||
    ((text: string, _language?: string) => text);
  let geminiId = randomUUID();
  const partial = new Map<string, string>();
  const setPartial = (id: string, text: string) => {
    if (!partial.has(id) && partial.size >= 200) {
      const oldest = partial.keys().next().value;
      if (oldest !== undefined) partial.delete(oldest);
    }
    partial.set(id, text);
  };
  return (data: Record<string, any>): SttServerEvent[] => {
    const events: SttServerEvent[] = [];
    if (start.provider === 'openai') {
      if (data.type === 'input_audio_buffer.committed' && typeof data.item_id === 'string')
        events.push({ type: 'transcript.committed', segmentId: data.item_id });
      if (data.type === 'session.updated')
        events.push({ type: 'session.ready', provider: start.provider, model: start.model });
      if (
        data.type === 'conversation.item.input_audio_transcription.delta' &&
        typeof data.delta === 'string'
      ) {
        const id = String(data.item_id || 'current');
        const text = (partial.get(id) || '') + data.delta;
        setPartial(id, text);
        events.push({
          type: 'transcript.interim',
          segmentId: id,
          text: convert(text),
          track: start.track,
        });
      }
      if (
        data.type === 'conversation.item.input_audio_transcription.completed' &&
        typeof data.transcript === 'string'
      ) {
        const id = String(data.item_id || 'current');
        partial.delete(id);
        events.push({
          type: 'transcript.final',
          segmentId: id,
          text: convert(data.transcript, data.language),
          track: start.track,
        });
      }
      if (data.type === 'conversation.item.input_audio_transcription.failed') {
        const id = String(data.item_id || 'current');
        partial.delete(id);
        events.push(
          { type: 'transcript.final', segmentId: id, text: '', track: start.track, failed: true },
          {
            type: 'error',
            code: 'transcript_failed',
            message: '這段音訊轉錄失敗，即時轉錄會繼續。',
            recoverable: true,
          },
        );
      }
      if (data.type === 'error')
        events.push({
          type: 'error',
          code: 'provider_error',
          message: '即時轉錄服務發生錯誤，請檢查模型及金鑰。',
          recoverable: false,
        });
    } else {
      if (data.setupComplete)
        events.push({ type: 'session.ready', provider: start.provider, model: start.model });
      const interim = data.serverContent?.interimInputTranscription?.text;
      const final = data.serverContent?.inputTranscription?.text;
      if (typeof interim === 'string' && interim)
        events.push({
          type: 'transcript.interim',
          segmentId: geminiId,
          text: convert(interim, data.serverContent.interimInputTranscription.languageCode),
          track: start.track,
        });
      if (typeof final === 'string' && final) {
        const offset = data.serverContent.inputTranscription.endOffset;
        const seconds =
          typeof offset === 'string' && /^\d+(?:\.\d+)?s$/.test(offset)
            ? Number(offset.slice(0, -1))
            : NaN;
        events.push({
          type: 'transcript.final',
          segmentId: geminiId,
          text: convert(final, data.serverContent.inputTranscription.languageCode),
          ...(Number.isFinite(seconds) && seconds > 0 ? { audioEndMs: seconds * 1000 } : {}),
          track: start.track,
        });
        geminiId = randomUUID();
      }
      if (data.goAway)
        events.push({ type: 'session.reconnecting', reason: 'provider_session_expiring' });
      if (data.error)
        events.push({
          type: 'error',
          code: 'provider_error',
          message: '即時轉錄服務發生錯誤，請檢查模型及金鑰。',
          recoverable: false,
        });
    }
    return events;
  };
}
