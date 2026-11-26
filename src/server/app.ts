import { createHash, timingSafeEqual } from 'node:crypto';
import { WORKSPACE_ACCOUNT_HEADER, WORKSPACE_SESSION_HEADER } from '../shared/protocol';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { GoogleGenAI, createPartFromUri, createUserContent } from '@google/genai';
import OpenAI from 'openai';
import type {
  AuthUser,
  KeySource,
  UsageSessionKind,
  UsageTimeInterval,
  UsageResolution,
} from '../shared/types';
import {
  authenticateUser,
  buildClearSessionCookie,
  buildSessionCookie,
  changeOwnPassword,
  checkLoginRateLimit,
  clearLoginFailures,
  createInitialAdmin,
  createSession,
  createUser,
  deleteSessionByCookie,
  deleteUserSessions,
  getSessionUser,
  hasAnyUsers,
  listUsers,
  recordLoginFailure,
  updateUser,
  validateUsername,
} from './auth';
import { envProviderKey, isProvider, requestHost, resolveProviderKey } from './config';
import { generateText, type ProviderTextUsage } from './providers/text';
import {
  openAITranscriptionFormat,
  parseOpenAITranscript,
  parseTimedTranscript,
  transcriptSchema,
} from './providers/transcription';
import { isAllowedOrigin } from './origin';
import { languageInstruction, scriptConverter, streamConvertedText } from './language';
import {
  buildUnsettledUsageCsv,
  buildUsageCsv,
  completeUsageSession,
  deleteModelPricing,
  discardRejectedUsage,
  finishPendingUsage,
  getCurrencySettings,
  getMeetingUsageSummary,
  getUsageCalendar,
  listModelPricing,
  listUnsettledUsage,
  queryUsageReport,
  recordUsageEvent,
  renameMeetingUsage,
  resolveUnsettledUsage,
  saveUsageProviderReference,
  setCurrencySettings,
  upsertModelPricing,
} from './usage';

function providerErrorStatus(error: unknown): number {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number(error.status)
    : 0;
}

function isAuthError(error: unknown): boolean {
  const status = providerErrorStatus(error);
  return status === 401 || status === 403;
}

function isProviderRejection(error: unknown): boolean {
  return [400, 401, 403, 404, 413, 415, 422, 429].includes(providerErrorStatus(error));
}

function providerReference(value: unknown): string | undefined {
  if (typeof value !== 'object' || !value) return undefined;
  if ('requestID' in value && typeof value.requestID === 'string') return value.requestID;
  if ('_request_id' in value && typeof value._request_id === 'string') return value._request_id;
  if ('responseId' in value && typeof value.responseId === 'string') return value.responseId;
}

function isHttpsRequest(c: Context): boolean {
  const forwarded = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  return forwarded === 'https' || c.req.url.startsWith('https://');
}

function clientIp(c: Context): string {
  return (
    c.req
      .header('x-forwarded-for')
      ?.split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .at(-1) ||
    c.req.header('x-real-ip')?.trim() ||
    'local'
  );
}

function requireAuth(c: Context): AuthUser | null {
  return getSessionUser(c.req.header('cookie')) ?? null;
}

function parseOptionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, maxLength);
  return trimmed || undefined;
}

function parseKeySourceParam(
  value: string | undefined,
  fallback: KeySource | 'all',
): KeySource | 'all' {
  if (value === 'all' || value === 'server_env' || value === 'byok') return value;
  return fallback;
}

function setupToken(): string | undefined {
  const configured = process.env.POLYMEET_SETUP_TOKEN?.trim();
  return configured && configured.length >= 32 ? configured : undefined;
}

function canSetUp(token: unknown): boolean {
  const configured = setupToken();
  if (!configured || typeof token !== 'string') return false;
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(configured), hash(token.trim()));
}

export const app = new Hono();

app.use('*', async (c, next) => {
  const host = requestHost(c);
  const origin = c.req.header('origin');
  if (!isAllowedOrigin(host, origin)) {
    console.warn(
      `[origin_blocked] host="${host}" origin="${origin}" path="${c.req.path}" forwarded-host="${c.req.header('x-forwarded-host')}"`,
    );
    return c.json({ error: 'origin_not_allowed' }, 403);
  }
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  if (c.req.path.startsWith('/api/')) {
    c.header('Cache-Control', 'no-store');
  }
});

app.use('/api/*', async (c, next) => {
  const expected = c.req.header(WORKSPACE_ACCOUNT_HEADER);
  if (expected !== undefined) {
    const user = requireAuth(c);
    if (!user || user.id !== expected) {
      c.header(WORKSPACE_SESSION_HEADER, user ? 'changed' : 'expired');
      return user
        ? c.json({ error: 'account_changed' }, 409)
        : c.json({ error: 'unauthenticated' }, 401);
    }
  }
  await next();
});

app.get('/api/health', (c) => {
  const user = requireAuth(c);
  const needsSetup = !hasAnyUsers();
  const canRevealServerKeys = Boolean(user?.allowServerKeys);
  return c.json({
    status: 'ok',
    authenticated: Boolean(user),
    needsSetup,
    setupAvailable: needsSetup && Boolean(setupToken()),
    user,
    serverKeys: canRevealServerKeys
      ? {
          openai: Boolean(envProviderKey('openai')),
          gemini: Boolean(envProviderKey('gemini')),
        }
      : { openai: false, gemini: false },
  });
});

app.get('/api/auth/me', (c) => {
  const user = requireAuth(c);
  const needsSetup = !hasAnyUsers();
  return c.json({
    authenticated: Boolean(user),
    needsSetup,
    setupAvailable: needsSetup && Boolean(setupToken()),
    user,
  });
});

app.post(
  '/api/auth/setup',
  bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: 'request_too_large' }, 413) }),
  async (c) => {
    let data: Record<string, unknown>;
    try {
      data = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (!canSetUp(data?.setupToken)) return c.json({ error: 'setup_not_authorized' }, 403);
    try {
      const user = createInitialAdmin({
        username: String(data.username ?? ''),
        displayName: String(data.displayName ?? data.username ?? ''),
        password: String(data.password ?? ''),
      });
      const session = createSession(user.id);
      c.header(
        'Set-Cookie',
        buildSessionCookie(session.token, isHttpsRequest(c), session.maxAgeSeconds),
      );
      return c.json({ user }, 201);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'invalid_request';
      if (code === 'setup_already_completed') return c.json({ error: code }, 409);
      return c.json({ error: code }, 400);
    }
  },
);

app.post(
  '/api/auth/login',
  bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: 'request_too_large' }, 413) }),
  async (c) => {
    if (!hasAnyUsers()) return c.json({ error: 'setup_required' }, 409);
    let data: Record<string, unknown>;
    try {
      data = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const rawUsername = String(data.username ?? '');
    const normalized = validateUsername(rawUsername) ?? rawUsername.trim().toLowerCase();
    const ipKey = `ip:${clientIp(c)}:${normalized}`;
    const accountKey = `acct:${normalized}`;
    const ipRate = checkLoginRateLimit(ipKey);
    const accountRate = checkLoginRateLimit(accountKey);
    if (!ipRate.allowed || !accountRate.allowed) {
      return c.json(
        {
          error: 'too_many_attempts',
          retryAfterSeconds: Math.max(ipRate.retryAfterSeconds, accountRate.retryAfterSeconds),
        },
        429,
      );
    }
    const user = authenticateUser(rawUsername, String(data.password ?? ''));
    if (!user) {
      recordLoginFailure(ipKey);
      recordLoginFailure(accountKey);
      return c.json({ error: 'invalid_credentials' }, 401);
    }
    clearLoginFailures(ipKey);
    clearLoginFailures(accountKey);
    deleteSessionByCookie(c.req.header('cookie'));
    const session = createSession(user.id);
    c.header(
      'Set-Cookie',
      buildSessionCookie(session.token, isHttpsRequest(c), session.maxAgeSeconds),
    );
    return c.json({ user });
  },
);

app.post('/api/auth/logout', (c) => {
  deleteSessionByCookie(c.req.header('cookie'));
  c.header('Set-Cookie', buildClearSessionCookie(isHttpsRequest(c)));
  return c.json({ ok: true });
});

app.post(
  '/api/auth/password',
  bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: 'request_too_large' }, 413) }),
  async (c) => {
    const user = requireAuth(c);
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    let data: Record<string, unknown>;
    try {
      data = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    try {
      changeOwnPassword(
        user.id,
        String(data.currentPassword ?? ''),
        String(data.newPassword ?? ''),
      );
      deleteUserSessions(user.id);
      const session = createSession(user.id);
      c.header(
        'Set-Cookie',
        buildSessionCookie(session.token, isHttpsRequest(c), session.maxAgeSeconds),
      );
      return c.json({ ok: true });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'invalid_request';
      if (code === 'invalid_credentials') return c.json({ error: code }, 401);
      return c.json({ error: code }, 400);
    }
  },
);

app.get('/api/models', async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const provider = c.req.query('provider');
  if (!isProvider(provider)) return c.json({ error: 'invalid_provider' }, 400);
  const resolved = resolveProviderKey(c, provider, user);
  if (!resolved) return c.json({ error: 'missing_api_key' }, 401);
  try {
    if (provider === 'openai') {
      const models = await new OpenAI({ apiKey: resolved.key }).models.list({
        signal: c.req.raw.signal,
      });
      const ids: string[] = [];
      for await (const model of models) ids.push(model.id);
      return c.json({ models: ids.sort() });
    }
    const models = await new GoogleGenAI({ apiKey: resolved.key }).models.list({
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
    const user = requireAuth(c);
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
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
    const resolved = resolveProviderKey(c, data.provider, user);
    if (!resolved) return c.json({ error: 'missing_api_key' }, 401);

    const model = data.model.trim();
    const meetingId = parseOptionalString(data.meetingId, 120);
    const meetingTitle = parseOptionalString(data.meetingTitle, 200);
    const usageSessionId = parseOptionalString(data.usageSessionId, 120);
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
    const startedAt = Date.now();

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
      const usageContext = {
        userId: user.id,
        meetingId,
        meetingTitle,
        usageSessionId,
        operation: operation === 'translate' ? ('translation' as const) : ('minutes' as const),
        provider,
        model,
        keySource: resolved.keySource,
        startedAt,
      };
      let usageId: string | undefined;
      let textUsage: ProviderTextUsage | undefined;
      let reference: string | undefined;
      let providerRejected = false;
      let failed = false;
      let finalText: string | undefined;
      const clientGone = () => controller.signal.aborted || stream.aborted || stream.closed;
      try {
        const convert = scriptConverter(selectedLanguages);
        if (clientGone()) return;
        usageId = recordUsageEvent({
          ...usageContext,
          endedAt: startedAt,
          pendingReconciliation: true,
        }).id;
        const upstreamSignal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(5 * 60 * 1000),
        ]);
        const chunks = generateText(
          provider,
          resolved.key,
          model,
          operation,
          instruction,
          input,
          upstreamSignal,
          (usage) => {
            textUsage = usage;
          },
          (id) => {
            if (reference === id) return;
            reference = id;
            if (usageId) saveUsageProviderReference(usageId, id);
          },
        );
        // Stream the draft immediately and normalize the complete text after generation.
        const correctDraft =
          operation === 'translate' && data.streamDraft === '1' ? convert : undefined;
        const output =
          convert && !correctDraft ? streamConvertedText(chunks, convert, operation) : chunks;
        let draft = '';
        for await (const value of output) {
          if (value && !clientGone()) {
            if (correctDraft) draft += value;
            await enqueueWrite(() =>
              stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: value }) }),
            ).catch(() => controller.abort());
          }
        }
        if (correctDraft && !clientGone()) {
          const corrected = correctDraft(draft);
          if (corrected !== draft) finalText = corrected;
        }
      } catch (error) {
        failed = true;
        providerRejected = !textUsage && isProviderRejection(error);
        reference ??= providerReference(error);
      } finally {
        clearInterval(keepalive);
        c.req.raw.signal.removeEventListener('abort', onReqAbort);
        await writeQueue.catch(() => {});
      }

      let recorded;
      if (usageId) {
        try {
          if (providerRejected) discardRejectedUsage(usageId);
          else
            recorded = recordUsageEvent({
              ...usageContext,
              id: usageId,
              endedAt: Date.now(),
              textInputTokens: textUsage?.inputTokens,
              cachedInputTokens: textUsage?.cachedInputTokens,
              outputTokens: textUsage?.outputTokens,
              totalTokens: textUsage?.totalTokens,
              pendingReconciliation: !textUsage,
              providerReference: reference,
            });
        } catch {
          failed = true;
        }
      }
      if (clientGone()) return;
      if (failed) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: 'provider_request_failed', usage: recorded }),
        });
      } else {
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({ usage: recorded, finalText }),
        });
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
    const user = requireAuth(c);
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
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
    const meetingId = parseOptionalString(form.get('meetingId'), 120);
    const meetingTitle = parseOptionalString(form.get('meetingTitle'), 200);
    const usageSessionId = parseOptionalString(form.get('usageSessionId'), 120);
    const rawAudioSeconds = Number(form.get('audioSeconds') || 0);
    const formAudioSeconds =
      Number.isFinite(rawAudioSeconds) && rawAudioSeconds > 0 ? rawAudioSeconds : 0;

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
    const resolved = resolveProviderKey(c, provider, user);
    if (!resolved) return c.json({ error: 'missing_api_key' }, 401);
    const startedAt = Date.now();
    const usageContext = {
      userId: user.id,
      meetingId,
      meetingTitle,
      usageSessionId,
      operation: 'file_stt' as const,
      provider,
      model: trimmedModel,
      keySource: resolved.keySource,
      startedAt,
    };
    let usageId: string | undefined;
    let reference: string | undefined;
    let providerRejected = false;
    const beginFileUsage = () => {
      c.req.raw.signal.throwIfAborted();
      usageId = recordUsageEvent({
        ...usageContext,
        endedAt: startedAt,
        pendingReconciliation: true,
      }).id;
    };
    try {
      if (provider === 'openai') {
        beginFileUsage();
        const result = await new OpenAI({ apiKey: resolved.key }).audio.transcriptions.create(
          {
            file,
            model: trimmedModel,
            ...openAITranscriptionFormat(trimmedModel),
            ...(languageHints.length === 1 ? { language: languageHints[0].split('-')[0] } : {}),
          },
          { signal: c.req.raw.signal },
        );
        reference = providerReference(result);
        const transcript = parseOpenAITranscript(result);
        const endedAt = Date.now();
        let textInputTokens = 0;
        let audioInputTokens = 0;
        let outputTokens = 0;
        let totalTokens = 0;
        let providerAudioSeconds: number | undefined;
        let audioSeconds = formAudioSeconds;
        if (result && typeof result === 'object') {
          const raw = result as {
            duration?: unknown;
            usage?: {
              type?: unknown;
              seconds?: unknown;
              input_tokens?: unknown;
              output_tokens?: unknown;
              total_tokens?: unknown;
              input_token_details?: { audio_tokens?: unknown; text_tokens?: unknown };
            };
          };
          if (
            typeof raw.duration === 'number' &&
            Number.isFinite(raw.duration) &&
            raw.duration > 0
          ) {
            providerAudioSeconds = raw.duration;
          }
          if (raw.usage?.type === 'tokens') {
            const totalIn = Number(raw.usage.input_tokens) || 0;
            const explicitAudio = Number(raw.usage.input_token_details?.audio_tokens) || 0;
            const explicitText = Number(raw.usage.input_token_details?.text_tokens) || 0;
            if (explicitAudio > 0 || explicitText > 0) {
              audioInputTokens = explicitAudio;
              textInputTokens = Math.max(0, totalIn - explicitAudio);
            } else {
              audioInputTokens = totalIn;
            }
            outputTokens = Number(raw.usage.output_tokens) || 0;
            totalTokens = Number(raw.usage.total_tokens) || totalIn + outputTokens;
          } else if (
            raw.usage?.type === 'duration' &&
            typeof raw.usage.seconds === 'number' &&
            Number.isFinite(raw.usage.seconds) &&
            raw.usage.seconds >= 0
          ) {
            providerAudioSeconds = raw.usage.seconds;
          }
        }
        if (
          providerAudioSeconds === undefined &&
          'segments' in transcript &&
          transcript.segments.length
        ) {
          const maxEnd = Math.max(...transcript.segments.map((segment) => segment.endSeconds));
          if (Number.isFinite(maxEnd) && maxEnd > audioSeconds) audioSeconds = maxEnd;
        }
        audioSeconds = providerAudioSeconds ?? audioSeconds;
        const usage = recordUsageEvent({
          ...usageContext,
          id: usageId,
          providerReference: reference,
          endedAt,
          durationSeconds: Math.max(0, (endedAt - startedAt) / 1000),
          audioSeconds,
          textInputTokens,
          audioInputTokens,
          outputTokens,
          totalTokens,
          estimated: totalTokens === 0 && providerAudioSeconds === undefined && audioSeconds > 0,
          pendingReconciliation:
            totalTokens === 0 && providerAudioSeconds === undefined && audioSeconds === 0,
        });
        return c.json(
          'segments' in transcript
            ? {
                segments: transcript.segments.map((segment) => ({
                  ...segment,
                  text: convert(segment.text),
                })),
                usage,
              }
            : { text: convert(transcript.text), usage },
        );
      }
      const client = new GoogleGenAI({ apiKey: resolved.key });
      let uploaded = await client.files.upload({ file, config: { mimeType } });
      const uploadedName = uploaded.name;
      let cleanupWarning = false;
      let segments: ReturnType<typeof parseTimedTranscript> = [];
      let geminiUsage:
        | {
            promptTokenCount?: number;
            cachedContentTokenCount?: number;
            candidatesTokenCount?: number;
            thoughtsTokenCount?: number;
            totalTokenCount?: number;
            promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
          }
        | undefined;
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
        beginFileUsage();
        const result = await client.models.generateContent({
          model: trimmedModel,
          contents: createUserContent([
            createPartFromUri(uploaded.uri, uploaded.mimeType),
            `Transcribe all spoken words faithfully in the original languages. ${languageHints.length ? languageInstruction(languageHints) : ''} Add languageCode per utterance using the selected language tags when identifiable. Split at speaker changes and into coherent utterances with approximate start and end times in seconds relative to the beginning of this audio. If multiple speakers can be distinguished, use stable anonymous speaker labels (語者 A, 語者 B, and so on) consistently throughout this audio; do not guess names and omit speaker when uncertain. Return an empty segments array if no speech is present.`,
          ]),
          config: {
            responseMimeType: 'application/json',
            responseJsonSchema: transcriptSchema,
            abortSignal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(5 * 60 * 1000)]),
          },
        });
        reference = providerReference(result);
        geminiUsage = result.usageMetadata;
        segments = parseTimedTranscript(result.text || '').map(({ languageCode, ...segment }) => ({
          ...segment,
          text: convert(segment.text, languageCode),
        }));
      } catch (error) {
        failed = true;
        authFailed = isAuthError(error);
        providerRejected = !geminiUsage && isProviderRejection(error);
        reference ??= providerReference(error);
      } finally {
        if (uploadedName)
          await client.files.delete({ name: uploadedName }).catch(() => {
            cleanupWarning = true;
          });
        else cleanupWarning = true;
      }
      if (authFailed) return c.json({ error: 'auth_failed', cleanupWarning }, 401);
      if (failed) return c.json({ error: 'provider_request_failed', cleanupWarning }, 502);

      const endedAt = Date.now();
      let audioSeconds = formAudioSeconds;
      if (segments.length) {
        const maxEnd = Math.max(...segments.map((s) => s.endSeconds));
        if (Number.isFinite(maxEnd) && maxEnd > audioSeconds) audioSeconds = maxEnd;
      }
      const promptTokens = Number(geminiUsage?.promptTokenCount) || 0;
      const detailsAudio =
        geminiUsage?.promptTokensDetails
          ?.filter((d) => String(d.modality || '').toUpperCase() === 'AUDIO')
          .reduce((sum, d) => sum + (Number(d.tokenCount) || 0), 0) ?? 0;
      const audioInputTokens =
        detailsAudio > 0 ? Math.min(detailsAudio, promptTokens || detailsAudio) : promptTokens;
      const textInputTokens = Math.max(0, promptTokens - audioInputTokens);
      const cachedInputTokens = Number(geminiUsage?.cachedContentTokenCount) || 0;
      const outputTokens =
        (Number(geminiUsage?.candidatesTokenCount) || 0) +
        (Number(geminiUsage?.thoughtsTokenCount) || 0);
      const totalTokens =
        Number(geminiUsage?.totalTokenCount) || textInputTokens + audioInputTokens + outputTokens;

      const usage = recordUsageEvent({
        ...usageContext,
        id: usageId,
        providerReference: reference,
        endedAt,
        durationSeconds: Math.max(0, (endedAt - startedAt) / 1000),
        audioSeconds,
        textInputTokens,
        audioInputTokens,
        cachedInputTokens,
        outputTokens,
        totalTokens,
        pendingReconciliation: !geminiUsage,
      });

      return c.json({ segments, cleanupWarning, usage });
    } catch (error) {
      providerRejected = isProviderRejection(error);
      reference ??= providerReference(error);
      if (isAuthError(error)) return c.json({ error: 'auth_failed' }, 401);
      return c.json({ error: 'provider_request_failed' }, 502);
    } finally {
      if (usageId && providerRejected) discardRejectedUsage(usageId);
      else if (usageId) finishPendingUsage(usageId, reference);
    }
  },
);

function parseActiveIntervals(
  value: unknown,
  startedAt: number,
  endedAt: number,
): UsageTimeInterval[] | null {
  if (!Array.isArray(value) || value.length > 2048) return null;
  const intervals: UsageTimeInterval[] = [];
  let position = startedAt;
  for (const interval of value) {
    if (!Array.isArray(interval) || interval.length !== 2) return null;
    const [start, end] = interval;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < position ||
      end <= start ||
      end > endedAt
    )
      return null;
    intervals.push([start, end]);
    position = end;
  }
  return intervals;
}

app.get('/api/usage/calendar', (c) => {
  if (!requireAuth(c)) return c.json({ error: 'unauthenticated' }, 401);
  return c.json(getUsageCalendar());
});

app.post(
  '/api/usage/sessions/complete',
  bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json({ error: 'request_too_large' }, 413) }),
  async (c) => {
    const user = requireAuth(c);
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    let data: Record<string, unknown>;
    try {
      data = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (!data) return c.json({ error: 'invalid_request' }, 400);
    const usageSessionId = parseOptionalString(data.usageSessionId, 120);
    const meetingId = parseOptionalString(data.meetingId, 120);
    const meetingTitle = parseOptionalString(data.meetingTitle, 200) ?? '未命名會議';
    const kind = String(data.kind ?? '');
    const validKinds: readonly UsageSessionKind[] = [
      'recording',
      'file_transcription',
      'minutes',
      'translation',
    ];
    if (
      !usageSessionId ||
      !meetingId ||
      !validKinds.includes(kind as UsageSessionKind) ||
      typeof data.startedAt !== 'number' ||
      !Number.isSafeInteger(data.startedAt) ||
      data.startedAt < 0 ||
      typeof data.endedAt !== 'number' ||
      !Number.isSafeInteger(data.endedAt) ||
      data.endedAt < data.startedAt ||
      data.endedAt > Date.now() + 24 * 60 * 60 * 1000 ||
      typeof data.durationSeconds !== 'number' ||
      !Number.isFinite(data.durationSeconds) ||
      data.durationSeconds < 0 ||
      data.durationSeconds > (data.endedAt - data.startedAt) / 1000
    ) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const activeIntervals =
      data.activeIntervals === undefined
        ? undefined
        : parseActiveIntervals(data.activeIntervals, data.startedAt, data.endedAt);
    if (activeIntervals === null || (activeIntervals !== undefined && kind !== 'recording')) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const activeDuration = activeIntervals?.reduce((ms, [start, end]) => ms + end - start, 0);
    const summary = completeUsageSession({
      userId: user.id,
      usageSessionId,
      meetingId,
      meetingTitle,
      kind: kind as UsageSessionKind,
      startedAt: data.startedAt,
      endedAt: data.endedAt,
      durationSeconds: activeDuration !== undefined ? activeDuration / 1000 : data.durationSeconds,
      activeIntervals,
    });
    return c.json({ summary });
  },
);

app.get('/api/usage/meetings/:meetingId', (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const summary = getMeetingUsageSummary(user.id, c.req.param('meetingId'));
  return c.json({ summary });
});

app.patch(
  '/api/usage/meetings/:meetingId',
  bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'request_too_large' }, 413) }),
  async (c) => {
    const user = requireAuth(c);
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    let data: Record<string, unknown>;
    try {
      data = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (typeof data.meetingTitle !== 'string') return c.json({ error: 'invalid_request' }, 400);
    renameMeetingUsage(user.id, c.req.param('meetingId'), data.meetingTitle);
    return c.json({ ok: true });
  },
);

app.get('/api/usage/my', (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const report = queryUsageReport({
    userId: user.id,
    includeLocalSessions: true,
    keySource: parseKeySourceParam(c.req.query('keySource'), 'all'),
    fromDate: c.req.query('from'),
    toDate: c.req.query('to'),
    search: c.req.query('search'),
  });
  if (c.req.query('format') === 'csv') {
    const csv = buildUsageCsv(report, 'detail');
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', 'attachment; filename="polymeet-my-usage.csv"');
    return c.body(csv);
  }
  return c.json(report);
});

app.get('/api/pricing', (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  return c.json({
    pricing: listModelPricing(),
    currency: getCurrencySettings(),
  });
});

app.use('/api/admin/*', async (c, next) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  if (user.role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  await next();
});

app.get('/api/admin/users', (c) => c.json({ users: listUsers() }));

app.post(
  '/api/admin/users',
  bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: 'request_too_large' }, 413) }),
  async (c) => {
    let data: Record<string, unknown>;
    try {
      data = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    try {
      const created = createUser({
        username: String(data.username ?? ''),
        displayName: String(data.displayName ?? ''),
        password: String(data.password ?? ''),
        role: data.role === 'admin' ? 'admin' : 'user',
        allowServerKeys: data.allowServerKeys !== false,
      });
      return c.json({ user: created }, 201);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'invalid_request';
      if (code === 'username_taken') return c.json({ error: code }, 409);
      return c.json({ error: code }, 400);
    }
  },
);

app.patch(
  '/api/admin/users/:id',
  bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: 'request_too_large' }, 413) }),
  async (c) => {
    let data: Record<string, unknown>;
    try {
      data = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    try {
      const updated = updateUser(c.req.param('id'), {
        ...(data.displayName !== undefined ? { displayName: String(data.displayName) } : {}),
        ...(data.role !== undefined ? { role: data.role === 'admin' ? 'admin' : 'user' } : {}),
        ...(data.allowServerKeys !== undefined
          ? { allowServerKeys: Boolean(data.allowServerKeys) }
          : {}),
        ...(data.active !== undefined ? { active: Boolean(data.active) } : {}),
        ...(data.password !== undefined ? { password: String(data.password) } : {}),
      });
      return c.json({ user: updated });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'invalid_request';
      if (code === 'user_not_found') return c.json({ error: code }, 404);
      return c.json({ error: code }, 400);
    }
  },
);

app.get('/api/admin/usage', (c) => {
  const report = queryUsageReport({
    userId: parseOptionalString(c.req.query('userId'), 120),
    keySource: parseKeySourceParam(c.req.query('keySource'), 'server_env'),
    fromDate: c.req.query('from'),
    toDate: c.req.query('to'),
    search: c.req.query('search'),
  });
  if (c.req.query('format') === 'csv') {
    const csvMode = c.req.query('csvMode') === 'account' ? 'account' : 'detail';
    const csv = buildUsageCsv(report, csvMode);
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="polymeet-admin-${csvMode}.csv"`);
    return c.body(csv);
  }
  return c.json(report);
});

app.get('/api/admin/usage/pending', (c) => {
  const exportCsv = c.req.query('format') === 'csv';
  const offset = Number(c.req.query('offset') || 0);
  if (!Number.isSafeInteger(offset) || offset < 0) return c.json({ error: 'invalid_request' }, 400);
  const result = listUnsettledUsage(
    {
      userId: parseOptionalString(c.req.query('userId'), 120),
      keySource: parseKeySourceParam(c.req.query('keySource'), 'server_env'),
      fromDate: c.req.query('from'),
      toDate: c.req.query('to'),
      search: c.req.query('search'),
    },
    exportCsv ? null : offset,
  );
  if (!exportCsv) return c.json(result);
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', 'attachment; filename="polymeet-unsettled-usage.csv"');
  return c.body(buildUnsettledUsageCsv(result.entries));
});

app.patch(
  '/api/admin/usage/pending/:id',
  bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ error: 'request_too_large' }, 413) }),
  async (c) => {
    const admin = requireAuth(c);
    if (!admin) return c.json({ error: 'unauthenticated' }, 401);
    let data: Partial<UsageResolution> | null;
    try {
      data = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const note = typeof data?.note === 'string' ? data.note.trim() : '';
    const costUsd = data?.costUsd;
    if (
      !note ||
      note.length > 1000 ||
      typeof costUsd !== 'number' ||
      !Number.isFinite(costUsd) ||
      costUsd < 0
    ) {
      return c.json({ error: 'invalid_resolution' }, 400);
    }
    const tokens = data?.tokens;
    if (tokens !== undefined) {
      if (!tokens || typeof tokens !== 'object')
        return c.json({ error: 'invalid_resolution' }, 400);
      const { textInputTokens, audioInputTokens, cachedInputTokens, outputTokens } = tokens;
      if (
        ![textInputTokens, audioInputTokens, cachedInputTokens, outputTokens].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ) ||
        !Number.isSafeInteger(textInputTokens + audioInputTokens + outputTokens) ||
        cachedInputTokens > textInputTokens + audioInputTokens
      )
        return c.json({ error: 'invalid_resolution' }, 400);
    }
    if (!resolveUnsettledUsage(c.req.param('id'), admin.id, { note, costUsd, tokens })) {
      return c.json({ error: 'usage_already_resolved' }, 409);
    }
    return c.json({ ok: true });
  },
);

app.get('/api/admin/pricing', (c) =>
  c.json({
    pricing: listModelPricing(),
    currency: getCurrencySettings(),
  }),
);

app.put(
  '/api/admin/pricing',
  bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: 'request_too_large' }, 413) }),
  async (c) => {
    let data: Record<string, unknown>;
    try {
      data = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (!isProvider(data.provider) || typeof data.model !== 'string') {
      return c.json({ error: 'invalid_request' }, 400);
    }
    try {
      const { settledCount, ...pricing } = upsertModelPricing({
        provider: data.provider,
        model: data.model,
        inputPer1M: Number(data.inputPer1M ?? 0),
        audioInputPer1M: Number(data.audioInputPer1M ?? 0),
        cachedInputPer1M: Number(data.cachedInputPer1M ?? 0),
        outputPer1M: Number(data.outputPer1M ?? 0),
        perMinute: Number(data.perMinute ?? 0),
      });
      return c.json({ pricing, settledCount });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'invalid_pricing' }, 400);
    }
  },
);

app.delete('/api/admin/pricing', async (c) => {
  let provider = c.req.query('provider');
  let model = c.req.query('model');
  if (!provider || !model) {
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      provider = typeof body.provider === 'string' ? body.provider : provider;
      model = typeof body.model === 'string' ? body.model : model;
    } catch {
      // Query params only.
    }
  }
  if (!isProvider(provider) || !model?.trim()) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const deleted = deleteModelPricing(provider, model);
  if (!deleted) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

app.put(
  '/api/admin/currency',
  bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'request_too_large' }, 413) }),
  async (c) => {
    let data: Record<string, unknown>;
    try {
      data = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    try {
      const currency = setCurrencySettings(
        String(data.currencyCode ?? ''),
        Number(data.exchangeRate ?? 0),
      );
      return c.json({ currency });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'invalid_currency' }, 400);
    }
  },
);

app.get('/', serveStatic({ path: './dist/index.html' }));
app.get('/assets/*', serveStatic({ root: './dist' }));
app.get('/audio-worklet.js', serveStatic({ path: './dist/audio-worklet.js' }));
