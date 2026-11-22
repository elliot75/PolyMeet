import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({
  upload: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  generate: vi.fn(),
  openaiTranscribe: vi.fn(),
  openaiResponse: vi.fn(),
  openaiModels: vi.fn(),
  geminiModels: vi.fn(),
}));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    files = { upload: mocked.upload, get: mocked.get, delete: mocked.remove };
    models = { generateContent: mocked.generate, list: mocked.geminiModels };
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
function form() {
  const data = new FormData();
  data.set('provider', 'gemini');
  data.set('model', 'model-id');
  data.set('file', new File(['audio'], 'recording.wav', { type: 'audio/wav' }));
  return data;
}
describe('provider routes with simulated services', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  it('returns Gemini timestamps and optional speakers and deletes the uploaded cloud file', async () => {
    mocked.generate.mockResolvedValue({
      text: JSON.stringify({
        segments: [
          { startSeconds: 1, endSeconds: 2, text: 'hello', speaker: ' 語者 A ' },
          { startSeconds: 3, endSeconds: 4, text: 'hi', speaker: '語者 B' },
          { startSeconds: 5, endSeconds: 6, text: 'yes', speaker: ' ' },
        ],
      }),
    });
    const response = await app.request('/api/transcribe-file', {
      method: 'POST',
      headers: { 'x-gemini-api-key': 'test-key' },
      body: form(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      segments: [
        { startSeconds: 1, endSeconds: 2, text: 'hello', speaker: '語者 A' },
        { startSeconds: 3, endSeconds: 4, text: 'hi', speaker: '語者 B' },
        { startSeconds: 5, endSeconds: 6, text: 'yes' },
      ],
      cleanupWarning: false,
    });
    expect(mocked.generate.mock.calls[0][0].contents[1]).toContain(
      'stable anonymous speaker labels',
    );
    expect(mocked.remove).toHaveBeenCalledWith({ name: 'files/test' });
  });
  it('deletes the cloud file even if generation fails, without exposing provider details', async () => {
    mocked.generate.mockRejectedValue(new Error('sensitive provider message'));
    const response = await app.request('/api/transcribe-file', {
      method: 'POST',
      headers: { 'x-gemini-api-key': 'test-key' },
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
      headers: { 'x-gemini-api-key': 'test-key' },
      body: form(),
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(body).cleanupWarning).toBe(true);
    expect(body).not.toContain('sensitive cleanup message');
  });
  it('streams OpenAI text and emits completion', async () => {
    mocked.openaiResponse.mockResolvedValue(
      (async function* () {
        yield { type: 'response.output_text.delta', delta: 'hello' };
        yield { type: 'response.output_text.delta', delta: ' world' };
        yield { type: 'response.completed' };
      })(),
    );
    const response = await app.request('/api/minutes/stream', {
      method: 'POST',
      headers: { 'x-openai-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        model: 'test',
        text: 'meeting',
        targetLanguage: 'English',
        action: 'polish',
        style: 'standard',
      }),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('event: delta');
    expect(text).toContain('hello');
    expect(text).toContain('event: done');
    expect(mocked.openaiResponse).toHaveBeenCalledWith(
      expect.objectContaining({ store: false }),
      expect.anything(),
    );
  });
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
        headers: { 'x-openai-api-key': 'test-key', 'content-type': 'application/json' },
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
      headers: { 'x-openai-api-key': 'test-key' },
      body: data,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      segments: [
        { startSeconds: 1.25, endSeconds: 2.5, text: '彙報', ...(speaker ? { speaker } : {}) },
        { startSeconds: 3.75, endSeconds: 5, text: '會議', ...(speaker ? { speaker: 'B' } : {}) },
      ],
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
        headers: { 'x-openai-api-key': 'test-key' },
        body: data,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ text: 'still usable' });
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
      mocked.openaiTranscribe.mockResolvedValue({ text: '会议记录' });
      const response = await app.request('/api/transcribe-file', {
        method: 'POST',
        headers: { 'x-openai-api-key': 'test-key' },
        body: data,
      });
      expect(await response.json()).toEqual({ text: '會議記錄' });
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
      headers: { 'x-openai-api-key': 'test-key', 'content-type': 'application/json' },
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
      headers: { 'x-gemini-api-key': 'test-key' },
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
      headers: { 'x-openai-api-key': 'test-key', 'content-type': 'application/json' },
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
      headers: { 'x-openai-api-key': 'bad-key' },
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
      headers: { 'x-gemini-api-key': 'test-key' },
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
      headers: { 'x-openai-api-key': 'test-key', 'content-type': 'application/json' },
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
      headers: { 'x-openai-api-key': 'bad-key' },
      body: openaiData,
    });
    expect(openaiRes.status).toBe(401);
    expect(await openaiRes.json()).toEqual({ error: 'auth_failed' });

    mocked.generate.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    mocked.remove.mockRejectedValue(new Error('cleanup failed'));
    const geminiRes = await app.request('/api/transcribe-file', {
      method: 'POST',
      headers: { 'x-gemini-api-key': 'bad-key' },
      body: form(),
    });
    expect(geminiRes.status).toBe(401);
    expect(await geminiRes.json()).toEqual({ error: 'auth_failed', cleanupWarning: true });
  });
});
