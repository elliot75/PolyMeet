import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({
  upload: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  generate: vi.fn(),
  openaiTranscribe: vi.fn(),
  openaiResponse: vi.fn(),
  openaiModels: vi.fn(),
}));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    files = { upload: mocked.upload, get: mocked.get, delete: mocked.remove };
    models = { generateContent: mocked.generate };
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
  it('returns structured timestamps and deletes the uploaded cloud file', async () => {
    const response = await app.request('/api/transcribe-file', {
      method: 'POST',
      headers: { 'x-gemini-api-key': 'test-key' },
      body: form(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      segments: [{ startSeconds: 1, endSeconds: 2, text: 'hello' }],
      cleanupWarning: false,
    });
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
  it('uses the requested Chinese script for file transcripts', async () => {
    const data = form();
    data.set('provider', 'openai');
    data.append('language', 'zh-TW');
    mocked.openaiTranscribe.mockResolvedValue({ text: '会议记录' });
    const response = await app.request('/api/transcribe-file', {
      method: 'POST',
      headers: { 'x-openai-api-key': 'test-key' },
      body: data,
    });
    expect(await response.json()).toEqual({ text: '會議記錄' });
  });
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
});
