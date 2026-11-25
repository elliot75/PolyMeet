import { randomUUID } from 'node:crypto';
import {
  builtinPricingAt,
  calculateUsageCost,
  findModelPricing,
  formatUsageDuration,
  keySourceLabel,
  localDateString,
  operationLabel,
} from '../shared/pricing';
import type {
  AccountUsageSummary,
  CurrencySettings,
  DailyMeetingUsage,
  KeySource,
  ModelPricing,
  ModelUsageRow,
  ProviderId,
  UsageMetric,
  UsageOperation,
  UsageReportResponse,
  UsageCalendar,
  UnsettledUsage,
  UsageResolution,
  UsageTimeInterval,
  UsageSessionKind,
  UsageSessionSummary,
} from '../shared/types';
import { getDb } from './db';

interface PricingRow {
  provider: ProviderId;
  model: string;
  input_per_1m: number;
  audio_input_per_1m: number;
  cached_input_per_1m: number;
  output_per_1m: number;
  per_minute: number;
  updated_at: number;
  is_builtin: number;
}

interface UsageEventRow {
  id: string;
  user_id: string;
  meeting_id: string;
  meeting_title: string;
  usage_session_id: string;
  operation: UsageOperation;
  provider: ProviderId;
  model: string;
  key_source: KeySource;
  usage_date: string;
  started_at: number;
  ended_at: number;
  duration_seconds: number;
  audio_seconds: number;
  text_input_tokens: number;
  audio_input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  estimated: number;
  pricing_missing: number;
  pending_reconciliation: number;
  provider_reference: string | null;
}

interface UsageSessionRow {
  id: string;
  user_id: string;
  meeting_id: string;
  meeting_title: string;
  kind: UsageSessionKind;
  active_intervals: string | null;
  started_at: number;
  ended_at: number;
  duration_seconds: number;
}

function mapPricing(row: PricingRow): ModelPricing {
  return {
    provider: row.provider,
    model: row.model,
    inputPer1M: row.input_per_1m,
    audioInputPer1M: row.audio_input_per_1m,
    cachedInputPer1M: row.cached_input_per_1m,
    outputPer1M: row.output_per_1m,
    perMinute: row.per_minute,
    updatedAt: row.updated_at,
  };
}

export function listModelPricing(at = Date.now()): ModelPricing[] {
  const rows = getDb()
    .prepare(
      `SELECT provider, model, input_per_1m, audio_input_per_1m,
              cached_input_per_1m, output_per_1m, per_minute, updated_at, is_builtin
       FROM model_pricing
       ORDER BY provider ASC, model ASC`,
    )
    .all() as unknown as PricingRow[];
  return rows.map((row) => {
    const price = mapPricing(row);
    return row.is_builtin ? builtinPricingAt(price, at) : price;
  });
}

export function upsertModelPricing(
  entry: Omit<ModelPricing, 'updatedAt'>,
): ModelPricing & { settledCount: number } {
  const model = entry.model.trim().replace(/^models\//, '');
  if (!model || model.length > 200) throw new Error('invalid_model');
  const rates = [
    entry.inputPer1M,
    entry.audioInputPer1M,
    entry.cachedInputPer1M,
    entry.outputPer1M,
    entry.perMinute,
  ];
  if (rates.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw new Error('invalid_pricing');
  }
  const updatedAt = Date.now();
  const saved: ModelPricing = { ...entry, model, updatedAt };
  const db = getDb();
  let settledCount = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO model_pricing (
         provider, model, input_per_1m, audio_input_per_1m,
         cached_input_per_1m, output_per_1m, per_minute, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, model) DO UPDATE SET
         input_per_1m = excluded.input_per_1m,
         audio_input_per_1m = excluded.audio_input_per_1m,
         cached_input_per_1m = excluded.cached_input_per_1m,
         output_per_1m = excluded.output_per_1m,
         per_minute = excluded.per_minute,
         updated_at = excluded.updated_at,
         is_builtin = 0`,
    ).run(
      entry.provider,
      model,
      entry.inputPer1M,
      entry.audioInputPer1M,
      entry.cachedInputPer1M,
      entry.outputPer1M,
      entry.perMinute,
      updatedAt,
    );

    const unpricedRows = db
      .prepare(
        `SELECT id, model, operation, text_input_tokens, audio_input_tokens,
                cached_input_tokens, output_tokens, audio_seconds
         FROM usage_events
         WHERE provider = ? AND pricing_missing = 1 AND pending_reconciliation = 0
           AND NOT EXISTS (SELECT 1 FROM usage_resolutions WHERE event_id = usage_events.id)`,
      )
      .all(entry.provider) as unknown as UsageEventRow[];

    const settleStmt = db.prepare(
      'UPDATE usage_events SET cost_usd = ?, pricing_missing = 0 WHERE id = ?',
    );
    for (const row of unpricedRows) {
      const matched = findModelPricing([saved], entry.provider, row.model);
      if (!matched) continue;
      const calculated = calculateUsageCost(matched, {
        textInputTokens: row.text_input_tokens,
        audioInputTokens: row.audio_input_tokens,
        cachedInputTokens: row.cached_input_tokens,
        outputTokens: row.output_tokens,
        audioSeconds: row.audio_seconds,
        operation: row.operation,
      });
      if (!calculated.pricingMissing) {
        settleStmt.run(calculated.costUsd, row.id);
        settledCount += 1;
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ...saved, settledCount };
}

export function deleteModelPricing(provider: ProviderId, model: string): boolean {
  const clean = model.trim().replace(/^models\//, '');
  const result = getDb()
    .prepare('DELETE FROM model_pricing WHERE provider = ? AND model = ?')
    .run(provider, clean);
  return result.changes > 0;
}

export function getCurrencySettings(): CurrencySettings {
  const rows = getDb()
    .prepare("SELECT key, value FROM app_settings WHERE key IN ('currency_code', 'exchange_rate')")
    .all() as unknown as { key: string; value: string }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const currencyCode = (map.get('currency_code') || '').trim().toUpperCase();
  const rate = Number(map.get('exchange_rate') || '0');
  return {
    currencyCode,
    exchangeRate: Number.isFinite(rate) && rate > 0 ? rate : 0,
  };
}

export function setCurrencySettings(currencyCode: string, exchangeRate: number): CurrencySettings {
  const code = currencyCode.trim().toUpperCase().slice(0, 10);
  if (code && !/^[A-Z0-9]{2,10}$/.test(code)) throw new Error('invalid_currency');
  if (!Number.isFinite(exchangeRate) || exchangeRate < 0) throw new Error('invalid_exchange_rate');
  const effectiveRate = code ? exchangeRate : 0;
  const db = getDb();
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('currency_code', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(code);
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('exchange_rate', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(effectiveRate));
  return { currencyCode: code, exchangeRate: effectiveRate };
}

export interface RecordUsageInput {
  id?: string;
  pendingReconciliation?: boolean;
  providerReference?: string;
  userId: string;
  meetingId?: string;
  meetingTitle?: string;
  usageSessionId?: string;
  operation: UsageOperation;
  provider: ProviderId;
  model: string;
  keySource: KeySource;
  usageDate?: string;
  startedAt: number;
  endedAt: number;
  durationSeconds?: number;
  audioSeconds?: number;
  textInputTokens?: number;
  audioInputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimated?: boolean;
}

function cleanMeetingId(raw: string | undefined): string {
  const trimmed = raw?.trim().slice(0, 120);
  return trimmed || 'standalone';
}

function cleanMeetingTitle(raw: string | undefined): string {
  const trimmed = raw?.trim().slice(0, 200);
  return trimmed || '未命名會議';
}

function nonNegativeInt(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function nonNegativeFloat(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

export function recordUsageEvent(input: RecordUsageInput): UsageMetric {
  const id = input.id ?? randomUUID();
  const meetingId = cleanMeetingId(input.meetingId);
  const meetingTitle = cleanMeetingTitle(input.meetingTitle);
  const usageSessionId = input.usageSessionId?.trim().slice(0, 120) || id;
  const startedAt = Number.isFinite(input.startedAt) ? Math.round(input.startedAt) : Date.now();
  const endedAt = Math.max(
    startedAt,
    Number.isFinite(input.endedAt) ? Math.round(input.endedAt) : startedAt,
  );
  const durationSeconds =
    input.durationSeconds !== undefined
      ? nonNegativeFloat(input.durationSeconds)
      : Math.max(0, (endedAt - startedAt) / 1000);
  const audioSeconds = nonNegativeFloat(input.audioSeconds);
  const textInputTokens = nonNegativeInt(input.textInputTokens);
  const audioInputTokens = nonNegativeInt(input.audioInputTokens);
  const cachedInputTokens = nonNegativeInt(input.cachedInputTokens);
  const outputTokens = nonNegativeInt(input.outputTokens);
  const computedTotal = textInputTokens + audioInputTokens + outputTokens;
  const totalTokens = Math.max(computedTotal, nonNegativeInt(input.totalTokens));
  const model = input.model
    .trim()
    .replace(/^models\//, '')
    .slice(0, 200);
  const usageDate =
    input.usageDate && /^\d{4}-\d{2}-\d{2}$/.test(input.usageDate)
      ? input.usageDate
      : localDateString(startedAt);
  const estimated = Boolean(input.estimated);

  const pricing = findModelPricing(listModelPricing(startedAt), input.provider, model);
  const calculated = calculateUsageCost(pricing, {
    textInputTokens,
    audioInputTokens,
    cachedInputTokens,
    outputTokens,
    audioSeconds,
    operation: input.operation,
  });

  const db = getDb();
  const stored = db
    .prepare(
      `INSERT INTO usage_events (
         id, user_id, meeting_id, meeting_title, usage_session_id,
         operation, provider, model, key_source, usage_date,
         started_at, ended_at, duration_seconds, audio_seconds,
         text_input_tokens, audio_input_tokens, cached_input_tokens,
         output_tokens, total_tokens, cost_usd, estimated, pricing_missing, pending_reconciliation, provider_reference
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ended_at = excluded.ended_at, duration_seconds = excluded.duration_seconds,
         audio_seconds = excluded.audio_seconds, text_input_tokens = excluded.text_input_tokens,
         audio_input_tokens = excluded.audio_input_tokens, cached_input_tokens = excluded.cached_input_tokens,
         output_tokens = excluded.output_tokens, total_tokens = excluded.total_tokens,
         cost_usd = excluded.cost_usd, estimated = excluded.estimated, pricing_missing = excluded.pricing_missing,
         pending_reconciliation = excluded.pending_reconciliation,
         provider_reference = COALESCE(excluded.provider_reference, usage_events.provider_reference)
       WHERE NOT EXISTS (SELECT 1 FROM usage_resolutions WHERE event_id = usage_events.id)
       RETURNING *`,
    )
    .get(
      id,
      input.userId,
      meetingId,
      meetingTitle,
      usageSessionId,
      input.operation,
      input.provider,
      model,
      input.keySource,
      usageDate,
      startedAt,
      endedAt,
      durationSeconds,
      audioSeconds,
      textInputTokens,
      audioInputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens,
      input.pendingReconciliation ? 0 : calculated.costUsd,
      estimated ? 1 : 0,
      calculated.pricingMissing ? 1 : 0,
      input.pendingReconciliation ? 1 : 0,
      input.providerReference?.slice(0, 200) || null,
    ) as UsageEventRow | undefined;

  // An administrator may finish reconciliation while the upstream call is still ending.
  // Keep the reviewed amount and token counts, while finishing the server timestamps.
  const row =
    stored ??
    (db
      .prepare(
        `UPDATE usage_events SET ended_at = MAX(ended_at, ?), duration_seconds = MAX(duration_seconds, ?),
       provider_reference = COALESCE(?, provider_reference)
     WHERE id = ? RETURNING *`,
      )
      .get(endedAt, durationSeconds, input.providerReference?.slice(0, 200) || null, id) as
      UsageEventRow | undefined);
  if (!row) throw new Error('usage_event_not_found');

  return {
    id: row.id,
    userId: row.user_id,
    meetingId: row.meeting_id,
    meetingTitle: row.meeting_title,
    usageSessionId: row.usage_session_id,
    operation: row.operation,
    provider: row.provider,
    model: row.model,
    keySource: row.key_source,
    usageDate: row.usage_date,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    audioSeconds: row.audio_seconds,
    textInputTokens: row.text_input_tokens,
    audioInputTokens: row.audio_input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    estimated: Boolean(row.estimated),
    pricingMissing: Boolean(row.pricing_missing),
    ...(row.pending_reconciliation ? { pendingReconciliation: true } : {}),
  };
}

export function finishPendingUsage(
  id: string,
  providerReference?: string,
  endedAt = Date.now(),
): void {
  getDb()
    .prepare(
      `UPDATE usage_events
     SET ended_at = MAX(started_at, ?), duration_seconds = MAX(0, (? - started_at) / 1000.0),
         provider_reference = COALESCE(?, provider_reference)
     WHERE id = ? AND pending_reconciliation = 1`,
    )
    .run(endedAt, endedAt, providerReference?.slice(0, 200) || null, id);
}

export function saveUsageProviderReference(id: string, reference: string): void {
  getDb()
    .prepare('UPDATE usage_events SET provider_reference = ? WHERE id = ?')
    .run(reference.slice(0, 200), id);
}

export function discardRejectedUsage(id: string): void {
  getDb().prepare('DELETE FROM usage_events WHERE id = ? AND pending_reconciliation = 1').run(id);
}

export function getUsageCalendar(now = new Date()): UsageCalendar {
  const today = localDateString(now.getTime());
  const year = now.getFullYear();
  const month = now.getMonth();
  const weekDay = (now.getDay() + 6) % 7;
  const date = (offset: number, day: number) =>
    localDateString(new Date(year, month + offset, day).getTime());
  return {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    refreshInMs: new Date(year, month, now.getDate() + 1).getTime() - now.getTime(),
    ranges: {
      today: { from: today, to: today },
      week: { from: date(0, now.getDate() - weekDay), to: today },
      month: { from: date(0, 1), to: today },
      last_month: { from: date(-1, 1), to: date(0, 0) },
      all: { from: '', to: '' },
    },
  };
}

export function listUnsettledUsage(
  filters: UsageFilters,
  offset: number | null = 0,
): { entries: UnsettledUsage[]; hasMore: boolean } {
  const { conditions, params } = reportEventConditions(filters);
  conditions.push('(e.pending_reconciliation = 1 OR e.pricing_missing = 1)');
  const { from, to } = reportDateRange(filters);
  if (from) {
    conditions.push('e.usage_date >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('e.usage_date <= ?');
    params.push(to);
  }
  const pageSize = 50;
  const pageClause = offset === null ? '' : 'LIMIT ? OFFSET ?';
  if (offset !== null) params.push(pageSize + 1, offset);
  const rows = getDb()
    .prepare(
      `SELECT e.*, u.username FROM usage_events e JOIN users u ON u.id = e.user_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY e.started_at DESC, e.id DESC ${pageClause}`,
    )
    .all(...params) as unknown as (UsageEventRow & { username: string })[];
  return {
    entries: (offset === null ? rows : rows.slice(0, pageSize)).map((row) => ({
      id: row.id,
      username: row.username,
      meetingTitle: row.meeting_title,
      startedAt: row.started_at,
      provider: row.provider,
      model: row.model,
      providerReference: row.provider_reference,
      operation: row.operation,
      keySource: row.key_source,
      pendingReconciliation: Boolean(row.pending_reconciliation),
      pricingMissing: Boolean(row.pricing_missing),
      textInputTokens: row.text_input_tokens,
      audioInputTokens: row.audio_input_tokens,
      cachedInputTokens: row.cached_input_tokens,
      outputTokens: row.output_tokens,
    })),
    hasMore: offset !== null && rows.length > pageSize,
  };
}

export function resolveUnsettledUsage(
  id: string,
  adminId: string,
  resolution: UsageResolution,
): boolean {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db
      .prepare(
        'SELECT * FROM usage_events WHERE id = ? AND (pending_reconciliation = 1 OR pricing_missing = 1)',
      )
      .get(id) as UsageEventRow | undefined;
    if (!row) {
      db.exec('COMMIT');
      return false;
    }
    db.prepare(
      `INSERT INTO usage_resolutions (event_id, admin_id, resolved_at, note, previous_cost_usd, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, adminId, Date.now(), resolution.note, row.cost_usd, resolution.costUsd);
    db.prepare(
      'UPDATE usage_events SET cost_usd = ?, pending_reconciliation = 0, pricing_missing = 0, estimated = 0 WHERE id = ?',
    ).run(resolution.costUsd, id);
    if (resolution.tokens) {
      const { textInputTokens, audioInputTokens, cachedInputTokens, outputTokens } =
        resolution.tokens;
      db.prepare(
        `UPDATE usage_events SET text_input_tokens = ?, audio_input_tokens = ?, cached_input_tokens = ?,
           output_tokens = ?, total_tokens = ? WHERE id = ?`,
      ).run(
        textInputTokens,
        audioInputTokens,
        cachedInputTokens,
        outputTokens,
        textInputTokens + audioInputTokens + outputTokens,
        id,
      );
    }
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function aggregateModels(events: UsageEventRow[]): ModelUsageRow[] {
  const map = new Map<string, ModelUsageRow>();
  for (const event of events) {
    const key = `${event.operation}::${event.provider}::${event.model}::${event.key_source}`;
    let row = map.get(key);
    if (!row) {
      row = {
        operation: event.operation,
        provider: event.provider,
        model: event.model,
        keySource: event.key_source,
        calls: 0,
        durationSeconds: 0,
        audioSeconds: 0,
        textInputTokens: 0,
        audioInputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        estimated: false,
        pricingMissing: false,
        pendingCalls: 0,
      };
      map.set(key, row);
    }
    row.calls += 1;
    row.durationSeconds += event.duration_seconds;
    row.audioSeconds += event.audio_seconds;
    row.textInputTokens += event.text_input_tokens;
    row.audioInputTokens += event.audio_input_tokens;
    row.cachedInputTokens += event.cached_input_tokens;
    row.outputTokens += event.output_tokens;
    row.totalTokens += event.total_tokens;
    row.costUsd += event.cost_usd;
    if (event.estimated) row.estimated = true;
    if (event.pricing_missing) row.pricingMissing = true;
    if (event.pending_reconciliation || event.pricing_missing) row.pendingCalls += 1;
  }
  return [...map.values()].sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
}

function sessionWallClockSeconds(
  events: UsageEventRow[],
  recordedSession?: UsageSessionRow,
): number {
  if (recordedSession && recordedSession.duration_seconds > 0) {
    return recordedSession.duration_seconds;
  }
  return mergedEventIntervals(events).reduce((seconds, interval) => seconds + interval.seconds, 0);
}

function computeGroupDurationSeconds(
  events: UsageEventRow[],
  sessionsById: Map<string, UsageSessionRow>,
): number {
  const bySession = new Map<string, UsageEventRow[]>();
  for (const event of events) {
    const list = bySession.get(event.usage_session_id);
    if (list) list.push(event);
    else bySession.set(event.usage_session_id, [event]);
  }
  let total = 0;
  for (const [sessionId, sessionEvents] of bySession) {
    total += sessionWallClockSeconds(sessionEvents, sessionsById.get(sessionId));
  }
  return total;
}

function buildSummaryFromEvents(
  events: UsageEventRow[],
  fallback: {
    usageSessionId?: string;
    meetingId: string;
    meetingTitle: string;
    kind?: UsageSessionKind;
    startedAt: number;
    endedAt: number;
    durationSeconds: number;
  },
  sessionsById: Map<string, UsageSessionRow>,
): UsageSessionSummary {
  const models = aggregateModels(events);
  const keySources = [...new Set(events.map((e) => e.key_source))];
  const startedAt = events.length
    ? Math.min(fallback.startedAt, ...events.map((e) => e.started_at))
    : fallback.startedAt;
  const endedAt = events.length
    ? Math.max(fallback.endedAt, ...events.map((e) => e.ended_at))
    : fallback.endedAt;
  const durationSeconds =
    fallback.durationSeconds > 0
      ? fallback.durationSeconds
      : computeGroupDurationSeconds(events, sessionsById);

  return {
    ...(fallback.usageSessionId ? { usageSessionId: fallback.usageSessionId } : {}),
    meetingId: fallback.meetingId,
    meetingTitle: events[0]?.meeting_title || fallback.meetingTitle,
    ...(fallback.kind ? { kind: fallback.kind } : {}),
    usageDate: events[0]?.usage_date || localDateString(startedAt),
    startedAt,
    endedAt,
    durationSeconds,
    audioSeconds: models.reduce((sum, m) => sum + m.audioSeconds, 0),
    textInputTokens: models.reduce((sum, m) => sum + m.textInputTokens, 0),
    audioInputTokens: models.reduce((sum, m) => sum + m.audioInputTokens, 0),
    cachedInputTokens: models.reduce((sum, m) => sum + m.cachedInputTokens, 0),
    outputTokens: models.reduce((sum, m) => sum + m.outputTokens, 0),
    totalTokens: models.reduce((sum, m) => sum + m.totalTokens, 0),
    costUsd: models.reduce((sum, m) => sum + m.costUsd, 0),
    pendingCalls: models.reduce((sum, m) => sum + m.pendingCalls, 0),
    keySources,
    models,
  };
}

export function completeUsageSession(input: {
  userId: string;
  usageSessionId: string;
  meetingId: string;
  meetingTitle: string;
  kind: UsageSessionKind;
  startedAt: number;
  endedAt: number;
  durationSeconds: number;
  activeIntervals?: UsageTimeInterval[];
}): UsageSessionSummary {
  const db = getDb();
  const meetingId = cleanMeetingId(input.meetingId);
  const meetingTitle = cleanMeetingTitle(input.meetingTitle);
  const usageSessionId = input.usageSessionId.trim().slice(0, 120);
  const startedAt = Math.round(input.startedAt);
  const endedAt = Math.max(startedAt, Math.round(input.endedAt));
  const durationSeconds = nonNegativeFloat(input.durationSeconds);

  db.prepare(
    `INSERT INTO usage_sessions (id, user_id, meeting_id, meeting_title, kind, started_at, ended_at, duration_seconds, active_intervals)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET
       meeting_title = excluded.meeting_title,
       started_at = MIN(usage_sessions.started_at, excluded.started_at),
       ended_at = MAX(usage_sessions.ended_at, excluded.ended_at),
       duration_seconds = CASE
         WHEN excluded.active_intervals IS NOT NULL THEN excluded.duration_seconds
         WHEN usage_sessions.active_intervals IS NOT NULL THEN usage_sessions.duration_seconds
         ELSE MAX(usage_sessions.duration_seconds, excluded.duration_seconds)
       END,
       active_intervals = COALESCE(excluded.active_intervals, usage_sessions.active_intervals)
     WHERE usage_sessions.meeting_id = excluded.meeting_id`,
  ).run(
    usageSessionId,
    input.userId,
    meetingId,
    meetingTitle,
    input.kind,
    startedAt,
    endedAt,
    durationSeconds,
    input.activeIntervals === undefined ? null : JSON.stringify(input.activeIntervals),
  );

  db.prepare('UPDATE usage_events SET meeting_title = ? WHERE user_id = ? AND meeting_id = ?').run(
    meetingTitle,
    input.userId,
    meetingId,
  );

  const events = db
    .prepare(
      'SELECT * FROM usage_events WHERE user_id = ? AND meeting_id = ? AND usage_session_id = ? ORDER BY started_at ASC',
    )
    .all(input.userId, meetingId, usageSessionId) as unknown as UsageEventRow[];

  const sessionRow = db
    .prepare('SELECT * FROM usage_sessions WHERE id = ? AND user_id = ? AND meeting_id = ?')
    .get(usageSessionId, input.userId, meetingId) as UsageSessionRow | undefined;
  const sessionsById = new Map<string, UsageSessionRow>();
  if (sessionRow) sessionsById.set(sessionRow.id, sessionRow);

  return buildSummaryFromEvents(
    events,
    {
      usageSessionId,
      meetingId,
      meetingTitle,
      kind: input.kind,
      startedAt,
      endedAt,
      durationSeconds: sessionRow?.duration_seconds ?? durationSeconds,
    },
    sessionsById,
  );
}

export function getMeetingUsageSummary(userId: string, meetingIdRaw: string): UsageSessionSummary {
  const db = getDb();
  const meetingId = cleanMeetingId(meetingIdRaw);
  const events = db
    .prepare(
      'SELECT * FROM usage_events WHERE user_id = ? AND meeting_id = ? ORDER BY started_at ASC',
    )
    .all(userId, meetingId) as unknown as UsageEventRow[];
  const sessions = db
    .prepare('SELECT * FROM usage_sessions WHERE user_id = ? AND meeting_id = ?')
    .all(userId, meetingId) as unknown as UsageSessionRow[];
  const sessionsById = new Map(sessions.map((s) => [s.id, s]));

  const now = Date.now();
  const fallbackStarted = sessions.length
    ? Math.min(...sessions.map((s) => s.started_at))
    : (events[0]?.started_at ?? now);
  const fallbackEnded = sessions.length
    ? Math.max(...sessions.map((s) => s.ended_at))
    : (events.at(-1)?.ended_at ?? fallbackStarted);

  let durationSeconds = computeGroupDurationSeconds(events, sessionsById);
  const eventSessionIds = new Set(events.map((e) => e.usage_session_id));
  for (const session of sessions) {
    if (!eventSessionIds.has(session.id)) {
      durationSeconds += session.duration_seconds;
    }
  }

  return buildSummaryFromEvents(
    events,
    {
      meetingId,
      meetingTitle: events[0]?.meeting_title || sessions[0]?.meeting_title || '未命名會議',
      startedAt: fallbackStarted,
      endedAt: fallbackEnded,
      durationSeconds,
    },
    sessionsById,
  );
}

export function renameMeetingUsage(userId: string, meetingIdRaw: string, meetingTitleRaw: string) {
  const db = getDb();
  const meetingId = cleanMeetingId(meetingIdRaw);
  const meetingTitle = cleanMeetingTitle(meetingTitleRaw);
  db.prepare('UPDATE usage_events SET meeting_title = ? WHERE user_id = ? AND meeting_id = ?').run(
    meetingTitle,
    userId,
    meetingId,
  );
  db.prepare(
    'UPDATE usage_sessions SET meeting_title = ? WHERE user_id = ? AND meeting_id = ?',
  ).run(meetingTitle, userId, meetingId);
}

interface UsageInterval {
  start: number;
  end: number;
  date: string;
  seconds: number;
}

function mergedEventIntervals(events: UsageEventRow[]): UsageInterval[] {
  const intervals: UsageInterval[] = [];
  for (const event of [...events].sort((a, b) => a.started_at - b.started_at)) {
    const interval = {
      start: event.started_at,
      end: event.ended_at,
      date: event.usage_date,
      seconds: event.duration_seconds,
    };
    if (!interval.seconds) continue;
    const last = intervals.at(-1);
    if (
      last &&
      (last.date === interval.date ||
        (last.date === localDateString(last.start) &&
          interval.date === localDateString(interval.start))) &&
      interval.start <= last.end &&
      last.seconds === (last.end - last.start) / 1000 &&
      interval.seconds === (interval.end - interval.start) / 1000
    ) {
      // Both tracks on a recording can overlap. Charge elapsed time once.
      last.end = Math.max(last.end, interval.end);
      last.seconds = (last.end - last.start) / 1000;
    } else {
      intervals.push(interval);
    }
  }
  return intervals;
}

function splitUsageInterval(
  interval: UsageInterval,
  reportDay: (date: string, seconds: number) => void,
) {
  const { start, end, date, seconds } = interval;
  if (!seconds) return;
  if (
    end <= start ||
    !Number.isFinite(new Date(end).getTime()) ||
    date !== localDateString(start)
  ) {
    reportDay(date, seconds);
    return;
  }
  for (let cursor = start; cursor < end;) {
    const midnight = new Date(cursor);
    midnight.setHours(24, 0, 0, 0);
    const cutoff = Math.min(midnight.getTime(), end);
    if (!(cutoff > cursor)) return;
    reportDay(localDateString(cursor), seconds * ((cutoff - cursor) / (end - start)));
    cursor = cutoff;
  }
}

function intervalAt(start: number, end: number, seconds = (end - start) / 1000): UsageInterval {
  return { start, end, seconds, date: localDateString(start) };
}

function recordingIntervals(
  start: number,
  end: number,
  seconds: number,
  saved: string | null,
): UsageInterval[] {
  if (saved !== null) {
    return (JSON.parse(saved) as UsageTimeInterval[]).map(([first, last]) =>
      intervalAt(first, last),
    );
  }
  return seconds > 0 ? [intervalAt(start, end, seconds)] : [];
}

// Sum each wall-clock segment once. A legacy recording's active fraction is an estimate;
// exact intervals from a concurrent model call take precedence over that estimate.
function combineIntervals(intervals: UsageInterval[]): UsageInterval[] {
  const edgesByCalendar = new Map<string, { at: number; rate: number; delta: number }[]>();
  const combined: UsageInterval[] = [];
  for (const { start, end, date, seconds } of intervals) {
    if (seconds <= 0) continue;
    if (end <= start) {
      combined.push({ start, end, date, seconds });
      continue;
    }
    const calendar = date === localDateString(start) ? '' : date;
    const edges = edgesByCalendar.get(calendar) ?? [];
    const rate = seconds / (end - start);
    edges.push({ at: start, rate, delta: 1 }, { at: end, rate, delta: -1 });
    edgesByCalendar.set(calendar, edges);
  }
  for (const [calendar, edges] of edgesByCalendar) {
    edges.sort((a, b) => a.at - b.at);
    const rates = new Map<number, number>();
    let previous = edges[0].at;
    for (const edge of edges) {
      if (rates.size && edge.at > previous) {
        const seconds = (edge.at - previous) * Math.max(...rates.keys());
        combined.push({
          start: previous,
          end: edge.at,
          seconds,
          date: calendar || localDateString(previous),
        });
      }
      const count = (rates.get(edge.rate) ?? 0) + edge.delta;
      if (count) rates.set(edge.rate, count);
      else rates.delete(edge.rate);
      previous = edge.at;
    }
  }
  return combined;
}

function clipLiveInterval(live: UsageInterval, active: UsageInterval): UsageInterval[] {
  const start = Math.max(live.start, active.start);
  const end = Math.min(live.end, active.end);
  if (end <= start || active.end <= active.start) return [];
  const seconds = active.seconds * ((end - start) / (active.end - active.start));
  const date = live.date === localDateString(live.start) ? localDateString(start) : live.date;
  return [{ start, end, seconds, date }];
}

interface UsageFilters {
  userId?: string;
  includeLocalSessions?: boolean;
  keySource?: KeySource | 'all';
  fromDate?: string;
  toDate?: string;
  search?: string;
}

function reportDateRange(filters: UsageFilters) {
  const date = /^\d{4}-\d{2}-\d{2}$/;
  return {
    from: date.test(filters.fromDate ?? '') ? filters.fromDate : undefined,
    to: date.test(filters.toDate ?? '') ? filters.toDate : undefined,
  };
}

function reportEventConditions(filters: UsageFilters) {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  const search = filters.search?.trim().toLowerCase();
  if (filters.userId) {
    conditions.push('e.user_id = ?');
    params.push(filters.userId);
  }
  if (filters.keySource && filters.keySource !== 'all') {
    conditions.push('e.key_source = ?');
    params.push(filters.keySource);
  }
  if (search) {
    conditions.push(
      '(LOWER(e.meeting_title) LIKE ? OR LOWER(u.username) LIKE ? OR LOWER(u.display_name) LIKE ? OR LOWER(e.model) LIKE ?)',
    );
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern, pattern);
  }

  return { conditions, params, search };
}

export function queryUsageReport(filters: UsageFilters): UsageReportResponse {
  const db = getDb();
  const { conditions, params, search } = reportEventConditions(filters);
  const restrictKey = Boolean(filters.keySource && filters.keySource !== 'all');
  const { from, to } = reportDateRange(filters);
  const inRange = (date: string) => (!from || date >= from) && (!to || date <= to);

  type ReportMeeting = {
    user_id: string;
    meeting_id: string;
    meeting_title: string;
    username: string;
    display_name: string;
    allow_server_keys: number;
    active: number;
  };
  type ReportEvent = UsageEventRow &
    ReportMeeting & {
      session_kind: UsageSessionKind | null;
      session_started_at: number | null;
      session_ended_at: number | null;
      session_duration_seconds: number | null;
      session_active_intervals: string | null;
    };
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT e.*, u.username, u.display_name, u.allow_server_keys, u.active,
            s.started_at AS session_started_at, s.ended_at AS session_ended_at,
            s.duration_seconds AS session_duration_seconds, s.kind AS session_kind,
            s.active_intervals AS session_active_intervals
     FROM usage_events e
     JOIN users u ON u.id = e.user_id
     LEFT JOIN usage_sessions s
       ON s.user_id = e.user_id AND s.id = e.usage_session_id AND s.meeting_id = e.meeting_id
     ${where}
     ORDER BY e.started_at DESC`,
    )
    .all(...params) as unknown as ReportEvent[];

  const groups = new Map<
    string,
    {
      date: string;
      meeting: ReportMeeting;
      events: ReportEvent[];
      seconds: number;
      sources: Set<KeySource>;
    }
  >();
  const groupFor = (row: ReportMeeting, date: string) => {
    const key = JSON.stringify([date, row.user_id, row.meeting_id]);
    let group = groups.get(key);
    if (!group) {
      group = { date, meeting: row, events: [], seconds: 0, sources: new Set() };
      groups.set(key, group);
    }
    return group;
  };
  const eventsBySession = new Map<string, ReportEvent[]>();
  for (const row of rows) {
    if (inRange(row.usage_date)) {
      const group = groupFor(row, row.usage_date);
      group.events.push(row);
      group.sources.add(row.key_source);
    }
    const id = JSON.stringify([row.user_id, row.meeting_id, row.usage_session_id]);
    const session = eventsBySession.get(id);
    if (session) session.push(row);
    else eventsBySession.set(id, [row]);
  }

  for (const events of eventsBySession.values()) {
    const row = events[0];
    const sources = new Set(events.map((event) => event.key_source));
    const reportDay = (date: string, seconds: number) => {
      if (!inRange(date)) return;
      const group = groupFor(row, date);
      group.seconds += seconds;
      for (const source of sources) group.sources.add(source);
    };
    const savedStart = row.session_started_at;
    const savedEnd = row.session_ended_at;
    const savedSeconds = row.session_duration_seconds;
    if (savedStart === null || savedEnd === null || savedSeconds === null) {
      for (const interval of mergedEventIntervals(events)) splitUsageInterval(interval, reportDay);
      continue;
    }
    const isRecording = row.session_kind === 'recording';
    const active = recordingIntervals(
      savedStart,
      savedEnd,
      savedSeconds,
      row.session_active_intervals,
    );
    const overrideDate =
      localDateString(row.started_at) === row.usage_date ? undefined : row.usage_date;
    if (!restrictKey && !search && (isRecording || savedSeconds > 0)) {
      for (const interval of active) {
        splitUsageInterval(
          overrideDate ? { ...interval, date: overrideDate } : interval,
          reportDay,
        );
      }
    } else if (isRecording) {
      const live = mergedEventIntervals(events.filter((event) => event.operation === 'live_stt'));
      const other = mergedEventIntervals(events.filter((event) => event.operation !== 'live_stt'));
      const croppedLive = live.flatMap((interval) =>
        active.flatMap((recorded) => clipLiveInterval(interval, recorded)),
      );
      for (const interval of combineIntervals([...croppedLive, ...other]))
        splitUsageInterval(interval, reportDay);
    } else {
      for (const interval of mergedEventIntervals(events)) splitUsageInterval(interval, reportDay);
    }
  }

  if (filters.includeLocalSessions && filters.userId && !restrictKey) {
    const pattern = search ? `%${search}%` : null;
    const localRows = db
      .prepare(
        `SELECT s.*, u.username, u.display_name, u.allow_server_keys, u.active
       FROM usage_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.user_id = ? AND s.kind = 'recording'
         AND (? IS NULL OR LOWER(s.meeting_title) LIKE ? OR LOWER(u.username) LIKE ? OR LOWER(u.display_name) LIKE ?)
         AND NOT EXISTS (
           SELECT 1 FROM usage_events e
           WHERE e.user_id = s.user_id AND e.meeting_id = s.meeting_id AND e.usage_session_id = s.id
         )`,
      )
      .all(filters.userId, pattern, pattern, pattern, pattern) as unknown as (UsageSessionRow &
      ReportMeeting)[];
    for (const row of localRows) {
      const intervals = recordingIntervals(
        row.started_at,
        row.ended_at,
        row.duration_seconds,
        row.active_intervals,
      );
      if (!intervals.length && inRange(localDateString(row.started_at)))
        groupFor(row, localDateString(row.started_at));
      for (const interval of intervals)
        splitUsageInterval(interval, (date, seconds) => {
          if (inRange(date)) groupFor(row, date).seconds += seconds;
        });
    }
  }

  const dailyMeetings: DailyMeetingUsage[] = [...groups.values()]
    .map(({ date, meeting, events, seconds, sources }) => {
      const models = aggregateModels(events);
      return {
        usageDate: date,
        userId: meeting.user_id,
        username: meeting.username,
        displayName: meeting.display_name,
        meetingId: meeting.meeting_id,
        meetingTitle: meeting.meeting_title,
        durationSeconds: seconds,
        audioSeconds: models.reduce((sum, m) => sum + m.audioSeconds, 0),
        textInputTokens: models.reduce((sum, m) => sum + m.textInputTokens, 0),
        audioInputTokens: models.reduce((sum, m) => sum + m.audioInputTokens, 0),
        cachedInputTokens: models.reduce((sum, m) => sum + m.cachedInputTokens, 0),
        outputTokens: models.reduce((sum, m) => sum + m.outputTokens, 0),
        totalTokens: models.reduce((sum, m) => sum + m.totalTokens, 0),
        costUsd: models.reduce((sum, m) => sum + m.costUsd, 0),
        pendingCalls: models.reduce((sum, m) => sum + m.pendingCalls, 0),
        keySources: [...sources],
        models,
      };
    })
    .sort((a, b) => b.usageDate.localeCompare(a.usageDate) || b.costUsd - a.costUsd);

  const sumMeetings = (meetings: DailyMeetingUsage[]) => ({
    meetingCount: meetings.length,
    durationSeconds: meetings.reduce((sum, m) => sum + m.durationSeconds, 0),
    audioSeconds: meetings.reduce((sum, m) => sum + m.audioSeconds, 0),
    textInputTokens: meetings.reduce((sum, m) => sum + m.textInputTokens, 0),
    audioInputTokens: meetings.reduce((sum, m) => sum + m.audioInputTokens, 0),
    cachedInputTokens: meetings.reduce((sum, m) => sum + m.cachedInputTokens, 0),
    outputTokens: meetings.reduce((sum, m) => sum + m.outputTokens, 0),
    totalTokens: meetings.reduce((sum, m) => sum + m.totalTokens, 0),
    costUsd: meetings.reduce((sum, m) => sum + m.costUsd, 0),
    pendingCalls: meetings.reduce((sum, m) => sum + m.pendingCalls, 0),
  });
  const accountMeta = new Map(
    [...groups.values()].map(({ meeting }) => [meeting.user_id, meeting]),
  );
  const byAccount = new Map<string, DailyMeetingUsage[]>();
  for (const meeting of dailyMeetings) {
    const meetings = byAccount.get(meeting.userId);
    if (meetings) meetings.push(meeting);
    else byAccount.set(meeting.userId, [meeting]);
  }
  const accounts: AccountUsageSummary[] = [...byAccount]
    .map(([userId, meetings]) => {
      const row = accountMeta.get(userId)!;
      return {
        userId,
        username: row.username,
        displayName: row.display_name,
        allowServerKeys: Boolean(row.allow_server_keys),
        active: Boolean(row.active),
        ...sumMeetings(meetings),
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  return { ...getCurrencySettings(), totals: sumMeetings(dailyMeetings), accounts, dailyMeetings };
}

function escapeCsvCell(value: unknown): string {
  const str = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function buildUnsettledUsageCsv(entries: UnsettledUsage[]): string {
  const header = [
    '用量 ID',
    '供應商參照',
    '起始時間 (UTC)',
    '帳號',
    '會議名稱',
    '功能',
    '供應商',
    '模型',
    '金鑰來源',
    '缺少供應商用量',
    '未設定費率',
    '文字輸入 Token',
    '音訊輸入 Token',
    '其中快取 Token',
    '輸出 Token',
  ];
  const rows = entries.map((entry) => [
    entry.id,
    entry.providerReference,
    new Date(entry.startedAt).toISOString(),
    entry.username,
    entry.meetingTitle,
    operationLabel(entry.operation),
    entry.provider,
    entry.model,
    keySourceLabel(entry.keySource),
    entry.pendingReconciliation ? '是' : '',
    entry.pricingMissing ? '是' : '',
    entry.textInputTokens,
    entry.audioInputTokens,
    entry.cachedInputTokens,
    entry.outputTokens,
  ]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(escapeCsvCell).join(',')).join('\r\n')}\r\n`;
}

export function buildUsageCsv(report: UsageReportResponse, mode: 'detail' | 'account'): string {
  const hasSecondary = Boolean(report.currencyCode && report.exchangeRate > 0);
  const secondaryHeader = hasSecondary ? `已計價費用 (${report.currencyCode})` : null;
  const formatSecondary = (usd: number) => (usd * report.exchangeRate).toFixed(2);

  const lines: string[] = [];
  if (mode === 'account') {
    const header = [
      '帳號',
      '顯示名稱',
      '使用場次',
      '累計時長 (秒)',
      '累計時長',
      '音訊秒數',
      '文字輸入 Token',
      '音訊輸入 Token',
      '快取 Token',
      '輸出 Token',
      '總 Token',
      '待核對呼叫數（含未設定費率）',
      '已計價費用 (USD)',
      ...(secondaryHeader ? [secondaryHeader] : []),
    ];
    lines.push(header.map(escapeCsvCell).join(','));
    for (const account of report.accounts) {
      const row = [
        account.username,
        account.displayName,
        account.meetingCount,
        account.durationSeconds.toFixed(1),
        formatUsageDuration(account.durationSeconds),
        account.audioSeconds.toFixed(1),
        account.textInputTokens,
        account.audioInputTokens,
        account.cachedInputTokens,
        account.outputTokens,
        account.totalTokens,
        account.pendingCalls,
        account.costUsd.toFixed(6),
        ...(hasSecondary ? [formatSecondary(account.costUsd)] : []),
      ];
      lines.push(row.map(escapeCsvCell).join(','));
    }
    const totalRow = [
      '小計',
      '',
      report.totals.meetingCount,
      report.totals.durationSeconds.toFixed(1),
      formatUsageDuration(report.totals.durationSeconds),
      report.totals.audioSeconds.toFixed(1),
      report.totals.textInputTokens,
      report.totals.audioInputTokens,
      report.totals.cachedInputTokens,
      report.totals.outputTokens,
      report.totals.totalTokens,
      report.totals.pendingCalls,
      report.totals.costUsd.toFixed(6),
      ...(hasSecondary ? [formatSecondary(report.totals.costUsd)] : []),
    ];
    lines.push(totalRow.map(escapeCsvCell).join(','));
  } else {
    const header = [
      '日期',
      '帳號',
      '顯示名稱',
      '會議名稱',
      '會議 ID',
      '功能',
      '供應商',
      '模型',
      '金鑰來源',
      '呼叫次數',
      '會議當日時長 (秒)',
      '模型作業時長 (秒)',
      '模型作業時長',
      '音訊秒數',
      '文字輸入 Token',
      '音訊輸入 Token',
      '快取 Token',
      '輸出 Token',
      '總 Token',
      '待核對呼叫數（含未設定費率）',
      '費率狀態',
      '已計價費用 (USD)',
      ...(secondaryHeader ? [secondaryHeader] : []),
    ];
    lines.push(header.map(escapeCsvCell).join(','));
    for (const meeting of report.dailyMeetings) {
      const detailRows = meeting.models.length ? meeting.models : [null];
      for (const [index, model] of detailRows.entries()) {
        const seconds = model?.durationSeconds ?? 0;
        const row = [
          meeting.usageDate,
          meeting.username,
          meeting.displayName,
          meeting.meetingTitle,
          meeting.meetingId,
          model
            ? operationLabel(model.operation)
            : meeting.keySources.length
              ? '跨日使用時間'
              : '本機錄音',
          model?.provider ?? '',
          model?.model ?? '',
          model
            ? keySourceLabel(model.keySource)
            : meeting.keySources.map(keySourceLabel).join(' / '),
          model?.calls ?? 0,
          index === 0 ? meeting.durationSeconds.toFixed(1) : '',
          seconds.toFixed(1),
          formatUsageDuration(seconds),
          (model?.audioSeconds ?? 0).toFixed(1),
          model?.textInputTokens ?? 0,
          model?.audioInputTokens ?? 0,
          model?.cachedInputTokens ?? 0,
          model?.outputTokens ?? 0,
          model?.totalTokens ?? 0,
          model?.pendingCalls ?? 0,
          model?.pricingMissing ? '未設定費率' : '',
          (model?.costUsd ?? 0).toFixed(6),
          ...(hasSecondary ? [formatSecondary(model?.costUsd ?? 0)] : []),
        ];
        lines.push(row.map(escapeCsvCell).join(','));
      }
    }
    const totalRow = [
      '小計',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      report.totals.durationSeconds.toFixed(1),
      '',
      '',
      report.totals.audioSeconds.toFixed(1),
      report.totals.textInputTokens,
      report.totals.audioInputTokens,
      report.totals.cachedInputTokens,
      report.totals.outputTokens,
      report.totals.totalTokens,
      report.totals.pendingCalls,
      '',
      report.totals.costUsd.toFixed(6),
      ...(hasSecondary ? [formatSecondary(report.totals.costUsd)] : []),
    ];
    lines.push(totalRow.map(escapeCsvCell).join(','));
  }

  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
