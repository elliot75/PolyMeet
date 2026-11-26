import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({
  upload: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  generate: vi.fn(),
  generateStream: vi.fn(),
  openaiTranscribe: vi.fn(),
  openaiResponse: vi.fn(),
  openaiModels: vi.fn(),
  geminiModels: vi.fn(),
}));
vi.mock('@google/genai', () => ({
  ThinkingLevel: { LOW: 'LOW' },
  GoogleGenAI: class {
    files = { upload: mocked.upload, get: mocked.get, delete: mocked.remove };
    models = {
      generateContent: mocked.generate,
      generateContentStream: mocked.generateStream,
      list: mocked.geminiModels,
    };
  },
  createPartFromUri: (uri: string, mimeType: string) => ({ uri, mimeType }),
  createUserContent: (content: unknown) => content,
}));
vi.mock('openai', () => ({
  default: class {
    audio = { transcriptions: { create: mocked.openaiTranscribe } };
    responses = { create: mocked.openaiResponse };
    models = { list: mocked.openaiModels };
  },
}));
import { app } from '../src/server/app';
import { createSession, createUser, SESSION_COOKIE_NAME } from '../src/server/auth';
import { queryUsageReport } from '../src/server/usage';
import { resetDbForTesting } from '../src/server/db';

function form() {
  const data = new FormData();
  data.set('provider', 'gemini');
  data.set('model', 'model-id');
  data.set('file', new File(['audio'], 'recording.wav', { type: 'audio/wav' }));
  return data;
}

describe('provider routes with simulated services', () => {
  let cookie = '';

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbForTesting(':memory:');
    const user = createUser({
      username: 'tester',
      displayName: 'Tester',
      password: 'password123',
      role: 'admin',
      allowServerKeys: true,
    });
    const { token } = createSession(user.id);
    cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;

    mocked.upload.mockResolvedValue({
      name: 'files/test',
      uri: 'https://example.invalid/file',
      mimeType: 'audio/wav',
      state: 'ACTIVE',
    });
    mocked.remove.mockResolvedValue({});
    mocked.generate.mockResolvedValue({
      text: JSON.stringify({ segments: [{ startSeconds: 1, endSeconds: 2, text: 'hello' }] }),
    });
  });

  it('uses provider-billed audio seconds instead of a larger browser or transcript estimate', async () => {
    mocked.openaiTranscribe.mockResolvedValueOnce({
      text: 'hello',
      duration: 31,
      usage: { type: 'duration', seconds: 30 },
      segments: [{ start: 0, end: 45, text: 'hello' }],
    });
    const data = form();
    data.set('provider', 'openai');
    data.set('model', 'gpt-transcribe');
    data.set('audioSeconds', '60');
    const response = await app.request('/api/transcribe-file', {
      method: 'POST',
      headers: { Cookie: cookie, 'X-OpenAI-API-Key': 'fixture-audio-key' },
      body: data,
    });
    expect(response.status).toBe(200);
    const { usage } = await response.json();
    expect(usage).toMatchObject({ audioSeconds: 30, estimated: false });
    expect(usage.costUsd).toBeCloseTo(0.00225);
  });

  it('removes confirmed provider refusals from pending usage while keeping uncertain failures', async () => {
    mocked.openaiResponse.mockRejectedValueOnce({ status: 401, requestID: 'rejected-request' });
    const response = await app.request('/api/translate/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenAI-API-Key': 'fixture-refused-key',
        Cookie: cookie,
      },
      body: JSON.stringify({
        provider: 'openai',
        model: 'gpt-5-mini',
        text: 'example',
        targetLanguage: 'English',
      }),
    });
    expect(await response.text()).toContain('event: error');
    expect(queryUsageReport({}).totals).toMatchObject({ pendingCalls: 0, meetingCount: 0 });

    mocked.openaiTranscribe.mockRejectedValueOnce({ status: 403, requestID: 'rejected-audio' });
    const data = form();
    data.set('provider', 'openai');
    data.set('model', 'gpt-transcribe');
    const failure = await app.request('/api/transcribe-file', {
      method: 'POST',
      headers: { Cookie: cookie, 'X-OpenAI-API-Key': 'fixture-refused-key' },
      body: data,
    });
    expect(failure.status).toBe(401);
    expect(queryUsageReport({}).totals.pendingCalls).toBe(0);
  });

  it('returns Gemini timestamps, optional speakers, usage tokens, and deletes the uploaded cloud file', async () => {
    mocked.generate.mockResolvedValue({
      text: JSON.stringify({
        segments: [
          { startSeconds: 1, endSeconds: 2, text: 'hello', speaker: ' 語者 A ' },
          { startSeconds: 3, endSeconds: 4, text: 'hi', speaker: '語者 B' },
          { startSeconds: 5, endSeconds: 6, text: 'yes', speaker: ' ' },
        ],
      }),
      usageMetadata: {
        promptTokenCount: 1500,
        promptTokensDetails: [
          { modality: 'AUDIO', tokenCount: 1200 },
          { modality: 'TEXT', tokenCount: 300 },
        ],
        candidatesTokenCount: 250,
        thoughtsTokenCount: 50,
        totalTokenCount: 1800,
      },
    });
    const bodyForm = form();
    bodyForm.set('model', 'gemini-3.8-flash');
    bodyForm.set('meetingId', 'm-gemini');
    bodyForm.set('meetingTitle', 'Weekly Sync');
    const response = await app.request('/api/transcribe-file', {
      method: 'POST',
      headers: { 'x-gemini-api-key': 'test-key', Cookie: cookie },
      body: bodyForm,
    });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({
      segments: [
        { startSeconds: 1, endSeconds: 2, text: 'hello', speaker: '語者 A' },
        { startSeconds: 3, endSeconds: 4, text: 'hi', speaker: '語者 B' },
        { startSeconds: 5, endSeconds: 6, text: 'yes' },
      ],
      cleanupWarning: false,
      usage: {
        operation: 'file_stt',
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        keySource: 'byok',
        meetingId: 'm-gemini',
        meetingTitle: 'Weekly Sync',
        textInputTokens: 300,
        audioInputTokens: 1200,
        outputTokens: 300,
        totalTokens: 1800,
        audioSeconds: 6,
      },
    });
    expect(json.usage.costUsd).toBeGreaterThan(0);
    expect(mocked.generate.mock.calls[0][0].contents[1]).toContain(
      'stable anonymous speaker labels',
    );
    expect(mocked.generate.mock.calls[0][0].config.abortSignal).toBeInstanceOf(AbortSignal);
    expect(mocked.remove).toHaveBeenCalledWith({ name: 'files/test' });
  });

  it('deletes the cloud file even if generation fails, without exposing provider details', async () => {
    mocked.generate.mockRejectedValue(new Error('sensitive provider message'));
    const response = await app.request('/api/transcribe-file', {
      method: 'POST',
      headers: { 'x-gemini-api-key': 'test-key', Cookie: cookie },
      body: form(),
    });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('sensitive provider message');
    expect(mocked.remove).toHaveBeenCalledWith({ name: 'files/test' });
  });

  it('reports a cloud cleanup failure without exposing provider messages', async () => {
    mocked.remove.mockRejectedValue(new Error('sensitive cleanup message'));
    const response = await app.request('/api/transcribe-file', {
      method: 'POST',
      headers: { 'x-gemini-api-key': 'test-key', Cookie: cookie },
      body: form(),
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(body).cleanupWarning).toBe(true);
    expect(body).not.toContain('sensitive cleanup message');
  });

  it('aborts upstream Gemini generation when a browser stops reading and keeps a pending entry for reconciliation', async () => {
    let capturedSignal: AbortSignal | undefined;
    mocked.generateStream.mockImplementationOnce(async function* (req: {
      config?: { abortSignal?: AbortSignal };
    }) {
      capturedSignal = req.config?.abortSignal;
      yield { text: 'start' };
      await new Promise<void>((_resolve, reject) => {
        if (capturedSignal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        capturedSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    });
    const response = await app.request('/api/minutes/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gemini-API-Key': 'fixture-gemini-key',
        Cookie: cookie,
      },
      body: JSON.stringify({
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        text: 'example',
        targetLanguage: 'English',
        action: 'polish',
        style: 'standard',
        meetingId: 'meeting',
        usageSessionId: 'cancelled',
      }),
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: delta');
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
    expect(queryUsageReport({}).totals.pendingCalls).toBe(1);
    await reader.cancel();
    await vi.waitFor(() => expect(capturedSignal?.aborted).toBe(true));
    expect(queryUsageReport({}).totals).toMatchObject({
      pendingCalls: 1,
      costUsd: 0,
    });
  });

  it('keeps one pending usage entry when upstream does not supply tokens', async () => {
    mocked.openaiResponse.mockResolvedValueOnce(
      (async function* () {
        yield { type: 'response.failed' };
      })(),
    );
    const response = await app.request('/api/translate/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenAI-API-Key': 'fixture-openai-key',
        Cookie: cookie,
      },
      body: JSON.stringify({
        provider: 'openai',
        model: 'gpt-5-mini',
        text: 'example',
        targetLanguage: 'English',
        meetingId: 'meeting',
        usageSessionId: 'failed',
      }),
    });
    expect(await response.text()).toContain('event: error');
    const report = queryUsageReport({});
    expect(report.totals).toMatchObject({ pendingCalls: 1, costUsd: 0 });
    expect(report.dailyMeetings[0].models[0]).toMatchObject({ calls: 1, pendingCalls: 1 });
  });

  it('streams OpenAI text and emits completion with token usage', async () => {
    mocked.openaiResponse.mockResolvedValue(
      (async function* () {
        yield { type: 'response.output_text.delta', delta: 'hello' };
        yield { type: 'response.output_text.delta', delta: ' world' };
        yield {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 1000,
              input_tokens_details: { cached_tokens: 200 },
              output_tokens: 500,
              total_tokens: 1500,
            },
          },
        };
      })(),
    );
    const response = await app.request('/api/minutes/stream', {
      method: 'POST',
      headers: {
        'x-openai-api-key': 'test-key',
        'content-type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        provider: 'openai',
        model: 'gpt-5-mini',
        text: 'meeting',
        targetLanguage: 'English',
        action: 'polish',
        style: 'standard',
        meetingId: 'm-1',
        meetingTitle: 'Design Review',
      }),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('event: delta');
    expect(text).toContain('hello');
    expect(text).toContain('event: done');
    const doneFrame = text.split('\n\n').find((f) => f.includes('event: done'))!;
    const doneData = JSON.parse(doneFrame.split('data: ')[1]);
    expect(doneData.usage).toMatchObject({
      operation: 'minutes',
      provider: 'openai',
      model: 'gpt-5-mini',
      keySource: 'byok',
      textInputTokens: 1000,
      cachedInputTokens: 200,
      outputTokens: 500,
      totalTokens: 1500,
    });
    expect(doneData.usage.costUsd).toBeCloseTo(0.001205, 6);
    expect(mocked.openaiResponse).toHaveBeenCalledWith(
      expect.objectContaining({ store: false }),
      expect.anything(),
    );
    expect(mocked.openaiResponse.mock.calls[0][0]).not.toHaveProperty('reasoning');
  });

  it('streams a translation draft before completion and returns corrected Chinese with usage', async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    mocked.openaiResponse.mockResolvedValueOnce(
      (async function* () {
        yield { type: 'response.output_text.delta', delta: '会议' };
        await promise;
        yield { type: 'response.output_text.delta', delta: '记录' };
        yield {
          type: 'response.completed',
          response: { usage: { input_tokens: 10, output_tokens: 4 } },
        };
      })(),
    );
    const response = await app.request('/api/translate/stream', {
      method: 'POST',
      headers: {
        'x-openai-api-key': 'test-key',
        'content-type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        provider: 'openai',
        model: 'gpt-5-mini',
        text: 'Meeting minutes',
        sourceLanguage: 'English',
        targetLanguage: '繁體中文',
        streamDraft: '1',
      }),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      const first = await reader.read();
      expect(decoder.decode(first.value)).toContain('{"text":"会议"}');
    } finally {
      resolve();
    }
    let rest = '';
    for (;;) {
      const frame = await reader.read();
      if (frame.done) break;
      rest += decoder.decode(frame.value, { stream: true });
    }
    expect(rest).toContain('"finalText":"會議記錄"');
    expect(rest).toContain('"totalTokens":14');
    expect(mocked.openaiResponse).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning: { effort: 'minimal' } }),
      expect.anything(),
    );
  });

  it('uses a lower thinking level for Gemini 3.8 Flash translation', async () => {
    mocked.generateStream.mockResolvedValueOnce(
      (async function* () {
        yield { text: 'Meeting minutes', candidates: [{ finishReason: 'STOP' }] };
      })(),
    );
    const response = await app.request('/api/translate/stream', {
      method: 'POST',
      headers: {
        'x-gemini-api-key': 'test-key',
        'content-type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        text: '會議記錄',
        targetLanguage: 'English',
      }),
    });
    expect(await response.text()).toContain('Meeting minutes');
    expect(mocked.generateStream).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ thinkingConfig: { thinkingLevel: 'LOW' } }),
      }),
    );
  });

  it.each(['MAX_TOKENS', 'SAFETY', undefined])(
    'leaves incomplete Gemini text unfinished and records reported usage (%s)',
    async (finishReason) => {
      mocked.generateStream.mockResolvedValueOnce(
        (async function* () {
          yield {
            text: '开会地点是',
            candidates: [{ finishReason }],
            responseId: 'gemini-fixture',
          };
          yield {
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4, totalTokenCount: 24 },
          };
        })(),
      );
      const response = await app.request('/api/translate/stream', {
        method: 'POST',
        headers: {
          'x-gemini-api-key': 'test-key',
          'content-type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          provider: 'gemini',
          model: 'gemini-3.8-flash',
          text: 'The meeting is at the school.',
          sourceLanguage: 'English',
          targetLanguage: '繁體中文',
          streamDraft: '1',
        }),
      });
      const frames = await response.text();
      expect(frames).toContain('event: delta');
      expect(frames).toContain('开会地点是');
      expect(frames).toContain('event: error');
      expect(frames).not.toContain('event: done');
      expect(frames).toContain('"totalTokens":24');
      expect(queryUsageReport({}).totals).toMatchObject({ totalTokens: 24, pendingCalls: 0 });
    },
  );

  it.each(['response.incomplete', 'response.failed', undefined])(
    'reports OpenAI generation without successful completion (%s)',
    async (terminalEvent) => {
      mocked.openaiResponse.mockResolvedValue(
        (async function* () {
          yield { type: 'response.output_text.delta', delta: 'partial' };
          if (terminalEvent) yield { type: terminalEvent };
        })(),
      );
      const response = await app.request('/api/minutes/stream', {
        method: 'POST',
        headers: {
          'x-openai-api-key': 'test-key',
          'content-type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({
          provider: 'openai',
          model: 'test',
          text: 'meeting',
          targetLanguage: 'English',
          action: 'polish',
          style: 'standard',
        }),
      });
      const body = await response.text();
      expect(body).toContain('event: error');
      expect(body).not.toContain('event: done');
    },
  );

  it.each([
    [
      'whisper-1',
      { response_format: 'verbose_json', timestamp_granularities: ['segment'] },
      undefined,
    ],
    [
      'gpt-4o-transcribe-diarize',
      { response_format: 'diarized_json', chunking_strategy: 'auto' },
      'A',
    ],
  ])('returns original audio offsets from %s segments', async (model, format, speaker) => {
    const data = form();
    data.set('provider', 'openai');
    data.set('model', model);
    data.append('language', 'zh-TW');
    mocked.openaiTranscribe.mockResolvedValue({
      text: '汇报 会议',
      segments: [
        { start: 3.75, end: 5, text: '会议', ...(speaker ? { speaker: 'B' } : {}) },
        { start: 1.25, end: 2.5, text: ' 汇报 ', ...(speaker ? { speaker } : {}) },
      ],
    });
    const response = await app.request('/api/transcribe-file', {
      method: 'POST',
      headers: { 'x-openai-api-key': 'test-key', Cookie: cookie },
      body: data,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      segments: [
        { startSeconds: 1.25, endSeconds: 2.5, text: '彙報', ...(speaker ? { speaker } : {}) },
        { startSeconds: 3.75, endSeconds: 5, text: '會議', ...(speaker ? { speaker: 'B' } : {}) },
      ],
      usage: {
        model,
        audioSeconds: 5,
      },
    });
    expect(mocked.openaiTranscribe).toHaveBeenCalledWith(
      expect.objectContaining({ model, language: 'zh', ...format }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([undefined, [], [{ start: 2, end: 1, text: 'text' }]])(
    'falls back to untimed text when the response has no usable timestamps (%j)',
    async (segments) => {
      const data = form();
      data.set('provider', 'openai');
      data.set('model', 'whisper-1');
      mocked.openaiTranscribe.mockResolvedValue({ text: 'still usable', segments });
      const response = await app.request('/api/transcribe-file', {
        method: 'POST',
        headers: { 'x-openai-api-key': 'test-key', Cookie: cookie },
        body: data,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ text: 'still usable' });
      expect(mocked.openaiTranscribe).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['gpt-transcribe', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'])(
    'uses the default text response and requested Chinese script for %s',
    async (model) => {
      const data = form();
      data.set('provider', 'openai');
      data.set('model', model);
      data.append('language', 'zh-TW');
      mocked.openaiTranscribe.mockResolvedValue({
        text: '会议记录',
        usage: {
          type: 'tokens',
          input_tokens: 400,
          output_tokens: 100,
          total_tokens: 500,
          input_token_details: { audio_tokens: 350, text_tokens: 50 },
        },
      });
      const response = await app.request('/api/transcribe-file', {
        method: 'POST',
        headers: { 'x-openai-api-key': 'test-key', Cookie: cookie },
        body: data,
      });
      expect(await response.json()).toMatchObject({
        text: '會議記錄',
        usage: {
          textInputTokens: 50,
          audioInputTokens: 350,
          outputTokens: 100,
          totalTokens: 500,
        },
      });
      expect(mocked.openaiTranscribe.mock.calls[0][0]).not.toHaveProperty('response_format');
    },
  );

  it('uses the selected output language even for polished minutes and converts split deltas', async () => {
    mocked.openaiResponse.mockResolvedValue(
      (async function* () {
        yield { type: 'response.output_text.delta', delta: '会议' };
        yield { type: 'response.completed' };
        yield { type: 'response.output_text.delta', delta: '记录' };
      })(),
    );
    const response = await app.request('/api/minutes/stream', {
      method: 'POST',
      headers: {
        'x-openai-api-key': 'test-key',
        'content-type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        provider: 'openai',
        model: 'test',
        text: 'test',
        targetLanguage: '繁體中文',
        action: 'polish',
        style: 'standard',
      }),
    });
    const output = await response.text();
    expect(output).toContain('會議記錄');
    expect(output).not.toContain('会议');
    expect(mocked.openaiResponse.mock.calls[0][0].instructions).toContain(
      'specified output language',
    );
  });

  it('strips codec parameters from uploaded audio MIME types and trims stream parameters', async () => {
    const data = new FormData();
    data.set('provider', 'gemini');
    data.set('model', '  gemini-3.8-flash  ');
    data.set('file', new File(['audio'], 'recording.webm', { type: 'audio/webm;codecs=opus' }));
    const uploadRes = await app.request('/api/transcribe-file', {
      method: 'POST',
      headers: { 'x-gemini-api-key': 'test-key', Cookie: cookie },
      body: data,
    });
    expect(uploadRes.status).toBe(200);
    expect(mocked.upload.mock.calls[0][0].config).toEqual({ mimeType: 'audio/webm' });

    mocked.openaiResponse.mockResolvedValue(
      (async function* () {
        yield { type: 'response.output_text.delta', delta: 'ok' };
        yield { type: 'response.completed' };
      })(),
    );
    const translateRes = await app.request('/api/translate/stream', {
      method: 'POST',
      headers: {
        'x-openai-api-key': 'test-key',
        'content-type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        provider: 'openai',
        model: '  gpt-5-mini  ',
        text: 'hello',
        sourceLanguage: '   ',
        targetLanguage: '繁體中文',
      }),
    });
    expect(translateRes.status).toBe(200);
    expect(mocked.openaiResponse.mock.calls[0][0].model).toBe('gpt-5-mini');
    expect(mocked.openaiResponse.mock.calls[0][0].instructions).toContain(
      'between the detected language and 繁體中文',
    );
    expect(mocked.openaiResponse.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);

    mocked.openaiModels.mockRejectedValue(Object.assign(new Error('bad key'), { status: 401 }));
    const modelsRes = await app.request('/api/models?provider=openai', {
      headers: { 'x-openai-api-key': 'bad-key', Cookie: cookie },
    });
    expect(modelsRes.status).toBe(401);
    expect(await modelsRes.json()).toEqual({ error: 'auth_failed' });
  });

  it('passes request abortSignal to Gemini model listing', async () => {
    mocked.geminiModels.mockResolvedValue(
      (async function* () {
        yield { name: 'models/gemini-3.8-flash' };
      })(),
    );
    const res = await app.request('/api/models?provider=gemini', {
      headers: { 'x-gemini-api-key': 'test-key', Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: ['gemini-3.8-flash'] });
    expect(mocked.geminiModels).toHaveBeenCalledWith({
      config: expect.objectContaining({ pageSize: 100, abortSignal: expect.any(AbortSignal) }),
    });
  });

  it('streams multi-paragraph Chinese minutes incrementally and avoids malformed bilingual prompt on single-language meetings', async () => {
    mocked.openaiResponse.mockResolvedValue(
      (async function* () {
        yield { type: 'response.output_text.delta', delta: '# 会议\n\n' };
        yield { type: 'response.output_text.delta', delta: '第二段' };
        yield { type: 'response.completed' };
      })(),
    );
    const response = await app.request('/api/minutes/stream', {
      method: 'POST',
      headers: {
        'x-openai-api-key': 'test-key',
        'content-type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        provider: 'openai',
        model: 'gpt-5-mini',
        text: '討論內容',
        targetLanguage: '雙語對照',
        meetingLanguages: '繁體中文',
        action: 'polish',
        style: 'standard',
      }),
    });
    const body = await response.text();
    const deltas = body
      .split('\n\n')
      .filter((frame) => frame.startsWith('event: delta'))
      .map((frame) => JSON.parse(frame.split('\ndata: ')[1]).text);
    expect(deltas).toEqual(['# 會議\n\n', '第二段']);
    const instruction = mocked.openaiResponse.mock.calls[0][0].instructions;
    expect(instruction).not.toContain('in both selected languages (繁體中文)');
    expect(instruction).toContain('in 繁體中文');
  });

  it('returns 401 auth_failed for file transcription authentication failures while preserving cleanupWarning', async () => {
    mocked.openaiTranscribe.mockRejectedValue(
      Object.assign(new Error('invalid key'), { status: 401 }),
    );
    const openaiData = form();
    openaiData.set('provider', 'openai');
    const openaiRes = await app.request('/api/transcribe-file', {
      method: 'POST',
      headers: { 'x-openai-api-key': 'bad-key', Cookie: cookie },
      body: openaiData,
    });
    expect(openaiRes.status).toBe(401);
    expect(await openaiRes.json()).toEqual({ error: 'auth_failed' });

    mocked.generate.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    mocked.remove.mockRejectedValue(new Error('cleanup failed'));
    const geminiRes = await app.request('/api/transcribe-file', {
      method: 'POST',
      headers: { 'x-gemini-api-key': 'bad-key', Cookie: cookie },
      body: form(),
    });
    expect(geminiRes.status).toBe(401);
    expect(await geminiRes.json()).toEqual({ error: 'auth_failed', cleanupWarning: true });
  });
});
