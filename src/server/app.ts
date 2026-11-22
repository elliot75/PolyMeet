import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { GoogleGenAI, createPartFromUri, createUserContent } from '@google/genai';
import OpenAI from 'openai';
import { isProvider, providerKey, requestHost, serverProviderKey } from './config';
import { generateText } from './providers/text';
import {
  openAITranscriptionFormat,
  parseOpenAITranscript,
  parseTimedTranscript,
  transcriptSchema,
} from './providers/transcription';
import { isAllowedOrigin } from './origin';
import { languageInstruction, scriptConverter, streamConvertedText } from './language';

function providerErrorStatus(error: unknown): number {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number(error.status)
    : 0;
}

function isAuthError(error: unknown): boolean {
  const status = providerErrorStatus(error);
  return status === 401 || status === 403;
}

export const app = new Hono();
app.use('*', async (c, next) => {
  if (!isAllowedOrigin(requestHost(c), c.req.header('origin')))
    return c.json({ error: 'origin_not_allowed' }, 403);
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  if (c.req.path.startsWith('/api/')) {
    c.header('Cache-Control', 'no-store');
  }
});
app.get('/api/health', (c) =>
  c.json({
    status: 'ok',
    serverKeys: {
      openai: Boolean(
        serverProviderKey('openai', requestHost(c), c.req.header('x-forwarded-host')),
      ),
      gemini: Boolean(
        serverProviderKey('gemini', requestHost(c), c.req.header('x-forwarded-host')),
      ),
    },
  }),
);
app.get('/api/models', async (c) => {
  const provider = c.req.query('provider');
  if (!isProvider(provider)) return c.json({ error: 'invalid_provider' }, 400);
  const key = providerKey(c, provider);
  if (!key) return c.json({ error: 'missing_api_key' }, 401);
  try {
    if (provider === 'openai') {
      const models = await new OpenAI({ apiKey: key }).models.list({ signal: c.req.raw.signal });
      const ids: string[] = [];
      for await (const model of models) ids.push(model.id);
      return c.json({ models: ids.sort() });
    }
    const models = await new GoogleGenAI({ apiKey: key }).models.list({
      config: { pageSize: 100, abortSignal: c.req.raw.signal },
    });
    const ids: string[] = [];
    for await (const model of models) {
      if (c.req.raw.signal.aborted) break;
      if (model.name) ids.push(model.name.replace(/^models\//, ''));
    }
    return c.json({ models: ids.sort() });
  } catch (error) {
    if (isAuthError(error)) return c.json({ error: 'auth_failed' }, 401);
    return c.json({ error: 'provider_request_failed' }, 502);
  }
});
app.post(
  '/api/:operation/stream',
  bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'request_too_large' }, 413) }),
  async (c) => {
    const operation = c.req.param('operation');
    if (operation !== 'translate' && operation !== 'minutes')
      return c.json({ error: 'not_found' }, 404);
    let data: Record<string, unknown>;
    try {
      data = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (
      !data ||
      !isProvider(data.provider) ||
      typeof data.model !== 'string' ||
      !data.model.trim() ||
      typeof data.text !== 'string' ||
      !data.text.trim() ||
      data.text.length > 300_000 ||
      typeof data.targetLanguage !== 'string' ||
      !data.targetLanguage.trim() ||
      data.targetLanguage.length > 80
    )
      return c.json({ error: 'invalid_request' }, 400);
    if (
      operation === 'minutes' &&
      (!['polish', 'translate_and_polish'].includes(String(data.action)) ||
        !['standard', 'action_items', 'detailed'].includes(String(data.style)))
    )
      return c.json({ error: 'invalid_request' }, 400);
    const key = providerKey(c, data.provider);
    if (!key) return c.json({ error: 'missing_api_key' }, 401);
    const model = data.model.trim();
    const targetLanguage = data.targetLanguage.trim();
    const sourceLanguage =
      typeof data.sourceLanguage === 'string' && data.sourceLanguage.trim()
        ? data.sourceLanguage.trim().slice(0, 80)
        : 'the detected language';
    const selectedLanguages =
      operation === 'translate'
        ? [
            typeof data.sourceLanguage === 'string' ? data.sourceLanguage.trim().slice(0, 80) : '',
            targetLanguage,
          ]
        : targetLanguage === '雙語對照' && typeof data.meetingLanguages === 'string'
          ? data.meetingLanguages
              .slice(0, 160)
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean)
          : [targetLanguage];
    const isBilingualMinutes = targetLanguage === '雙語對照' && selectedLanguages.length >= 2;
    const effectiveLanguage =
      targetLanguage === '雙語對照' ? selectedLanguages[0] || '繁體中文' : targetLanguage;
    const instruction =
      (operation === 'translate'
        ? `Translate the current speech between ${sourceLanguage} and ${targetLanguage}. Detect which of the two languages the current speech uses and translate it into the other. Treat prior context only as context. Return only the current speech translation, without commentary.`
        : `Create accurate meeting minutes ${isBilingualMinutes ? `in both selected languages (${selectedLanguages.join(' and ')}), paired for each section even if only one was spoken` : `in ${effectiveLanguage}`}. ${data.action === 'polish' ? 'Polish and summarize the transcript in the specified output language.' : 'Translate and polish the transcript into the specified output language.'} Style: ${data.style}. Preserve uncertainty, do not invent facts, and use Markdown.`) +
      ' ' +
      languageInstruction(selectedLanguages);
    const provider = data.provider,
      input = data.text;
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      const onReqAbort = () => controller.abort();
      if (c.req.raw.signal.aborted) controller.abort();
      else c.req.raw.signal.addEventListener('abort', onReqAbort, { once: true });
      stream.onAbort(() => controller.abort());
      let writeQueue = Promise.resolve();
      const enqueueWrite = (task: () => Promise<unknown>) => {
        writeQueue = writeQueue.then(async () => {
          await task();
        });
        return writeQueue;
      };
      const keepalive = setInterval(() => {
        if (!controller.signal.aborted && !stream.aborted && !stream.closed) {
          void enqueueWrite(() => stream.write(': keepalive\n\n')).catch(() => {});
        }
      }, 15_000);
      try {
        const convert = scriptConverter(selectedLanguages);
        const chunks = generateText(provider, key, model, instruction, input, controller.signal);
        const output = convert ? streamConvertedText(chunks, convert, operation) : chunks;
        for await (const text of output) {
          if (controller.signal.aborted || stream.aborted) return;
          if (text) {
            await enqueueWrite(() =>
              stream.writeSSE({ event: 'delta', data: JSON.stringify({ text }) }),
            );
          }
        }
        if (controller.signal.aborted || stream.aborted) return;
        await enqueueWrite(() => stream.writeSSE({ event: 'done', data: '{}' }));
      } catch {
        if (!controller.signal.aborted && !stream.aborted) {
          await enqueueWrite(() =>
            stream.writeSSE({
              event: 'error',
              data: JSON.stringify({ error: 'provider_request_failed' }),
            }),
          );
        }
      } finally {
        clearInterval(keepalive);
        c.req.raw.signal.removeEventListener('abort', onReqAbort);
        await writeQueue.catch(() => {});
      }
    });
  },
);

app.post(
  '/api/transcribe-file',
  bodyLimit({
    maxSize: 24 * 1024 * 1024,
    onError: (c) => c.json({ error: 'file_too_large' }, 413),
  }),
  async (c) => {
    const length = Number(c.req.header('content-length') || 0);
    if (length > 24 * 1024 * 1024) return c.json({ error: 'file_too_large' }, 413);
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const provider = form.get('provider'),
      model = form.get('model'),
      file = form.get('file');
    const languageHints = form
      .getAll('language')
      .filter(
        (value): value is string => typeof value === 'string' && /^[a-z]{2}-[A-Z]{2}$/.test(value),
      )
      .slice(0, 2);
    const convert =
      scriptConverter(languageHints, true) || ((text: string, _language?: string) => text);
    const mimeType = file instanceof File ? file.type.split(';')[0].trim().toLowerCase() : '';
    if (
      !isProvider(provider) ||
      typeof model !== 'string' ||
      !model.trim() ||
      !(file instanceof File) ||
      !file.size ||
      file.size > 23 * 1024 * 1024 ||
      !mimeType.startsWith('audio/')
    )
      return c.json({ error: 'invalid_request' }, 400);
    const trimmedModel = model.trim();
    const key = providerKey(c, provider);
    if (!key) return c.json({ error: 'missing_api_key' }, 401);
    try {
      if (provider === 'openai') {
        const result = await new OpenAI({ apiKey: key }).audio.transcriptions.create(
          {
            file,
            model: trimmedModel,
            ...openAITranscriptionFormat(trimmedModel),
            ...(languageHints.length === 1 ? { language: languageHints[0].split('-')[0] } : {}),
          },
          { signal: c.req.raw.signal },
        );
        const transcript = parseOpenAITranscript(result);
        return c.json(
          'segments' in transcript
            ? {
                segments: transcript.segments.map((segment) => ({
                  ...segment,
                  text: convert(segment.text),
                })),
              }
            : { text: convert(transcript.text) },
        );
      }
      const client = new GoogleGenAI({ apiKey: key });
      let uploaded = await client.files.upload({ file, config: { mimeType } });
      const uploadedName = uploaded.name;
      let cleanupWarning = false;
      let segments: ReturnType<typeof parseTimedTranscript> = [];
      let failed = false;
      let authFailed = false;
      try {
        for (let attempts = 0; uploaded.state === 'PROCESSING' && attempts < 60; attempts++) {
          if (!uploaded.name || c.req.raw.signal.aborted) throw new Error('upload interrupted');
          await new Promise((resolve) => setTimeout(resolve, 1000));
          uploaded = await client.files.get({ name: uploaded.name });
        }
        if (
          uploaded.state === 'PROCESSING' ||
          uploaded.state === 'FAILED' ||
          !uploaded.uri ||
          !uploaded.mimeType
        )
          throw new Error('upload failed');
        if (c.req.raw.signal.aborted) throw new Error('upload interrupted');
        const result = await client.models.generateContent({
          model: trimmedModel,
          contents: createUserContent([
            createPartFromUri(uploaded.uri, uploaded.mimeType),
            `Transcribe all spoken words faithfully in the original languages. ${languageHints.length ? languageInstruction(languageHints) : ''} Add languageCode per utterance using the selected language tags when identifiable. Split at speaker changes and into coherent utterances with approximate start and end times in seconds relative to the beginning of this audio. If multiple speakers can be distinguished, use stable anonymous speaker labels (語者 A, 語者 B, and so on) consistently throughout this audio; do not guess names and omit speaker when uncertain. Return an empty segments array if no speech is present.`,
          ]),
          config: {
            responseMimeType: 'application/json',
            responseJsonSchema: transcriptSchema,
            abortSignal: c.req.raw.signal,
          },
        });
        segments = parseTimedTranscript(result.text || '').map(({ languageCode, ...segment }) => ({
          ...segment,
          text: convert(segment.text, languageCode),
        }));
      } catch (error) {
        failed = true;
        authFailed = isAuthError(error);
      } finally {
        if (uploadedName)
          await client.files.delete({ name: uploadedName }).catch(() => {
            cleanupWarning = true;
          });
        else cleanupWarning = true;
      }
      if (authFailed) return c.json({ error: 'auth_failed', cleanupWarning }, 401);
      if (failed) return c.json({ error: 'provider_request_failed', cleanupWarning }, 502);
      return c.json({ segments, cleanupWarning });
    } catch (error) {
      if (isAuthError(error)) return c.json({ error: 'auth_failed' }, 401);
      return c.json({ error: 'provider_request_failed' }, 502);
    }
  },
);

app.get('/', serveStatic({ path: './dist/index.html' }));
app.get('/assets/*', serveStatic({ root: './dist' }));
app.get('/audio-worklet.js', serveStatic({ path: './dist/audio-worklet.js' }));
