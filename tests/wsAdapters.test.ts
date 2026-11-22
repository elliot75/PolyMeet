import { describe, expect, it } from 'vitest';
import {
  createEventMapper,
  openAiConfiguration,
  geminiConfiguration,
} from '../src/server/ws/adapters';
import type { SttStart } from '../src/shared/protocol';

describe('transcription adapters', () => {
  const openai: SttStart = {
    type: 'session.start',
    provider: 'openai',
    model: 'gpt-live-transcribe',
    sampleRate: 24000,
    track: 'mic',
  };
  it('disables server VAD for live transcription and aggregates deltas', () => {
    expect(openAiConfiguration(openai).session.audio.input.turn_detection).toBeNull();
    const map = createEventMapper(openai);
    map({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'a',
      delta: 'hello ',
    });
    expect(
      map({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'a',
        delta: 'world',
      })[0],
    ).toMatchObject({ type: 'transcript.interim', text: 'hello world' });
    expect(
      map({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'a',
        transcript: 'hello world',
      })[0],
    ).toMatchObject({ type: 'transcript.final', text: 'hello world' });
  });
  it('passes bilingual language hints in the provider-specific format', () => {
    const hints = ['zh-TW', 'en-US'];
    expect(
      openAiConfiguration({ ...openai, languageHints: hints }).session.audio.input.transcription,
    ).toEqual({ model: 'gpt-live-transcribe', languages: ['zh-tw', 'en'] });
    expect(
      geminiConfiguration({
        ...openai,
        provider: 'gemini',
        model: 'gemini-3.5-transcribe-live',
        sampleRate: 16000,
        languageHints: hints,
      }).setup.inputAudioTranscription,
    ).toEqual({ languageCodes: hints });
    expect(
      openAiConfiguration({ ...openai, model: 'gpt-4o-transcribe', languageHints: hints }).session
        .audio.input.transcription,
    ).toEqual({ model: 'gpt-4o-transcribe' });
  });
  it('emits Gemini finals without waiting for turnComplete', () => {
    const map = createEventMapper({
      ...openai,
      provider: 'gemini',
      model: 'gemini-3.5-transcribe-live',
      sampleRate: 16000,
    });
    expect(map({ serverContent: { inputTranscription: { text: '測試' } } })[0]).toMatchObject({
      type: 'transcript.final',
      text: '測試',
    });
    expect(map({ goAway: { timeLeft: '30s' } })[0]).toMatchObject({ type: 'session.reconnecting' });
  });
  it('normalizes live transcription to the selected Chinese script', () => {
    const map = createEventMapper({ ...openai, languageHints: ['zh-TW', 'en-US'] });
    expect(
      map({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'a',
        delta: '会议记录',
      })[0],
    ).toMatchObject({ text: '會議記錄' });
    expect(
      map({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'a',
        transcript: '会议记录',
      })[0],
    ).toMatchObject({ text: '會議記錄' });
    const japanese = createEventMapper({ ...openai, languageHints: ['zh-TW', 'ja-JP'] });
    expect(
      japanese({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: '会社です',
      })[0],
    ).toMatchObject({ text: '会社です' });
  });
});
