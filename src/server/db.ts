import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  builtinPricingAt,
  calculateUsageCost,
  DEFAULT_MODEL_PRICING,
  normalizeModelKey,
} from '../shared/pricing';
import type { UsageOperation } from '../shared/types';
import { hashPassword } from './password';

let instance: DatabaseSync | undefined;
let currentPath: string | undefined;

export function resolveDbPath(): string {
  const configured = process.env.POLYMEET_DB_PATH?.trim();
  if (configured) return configured;
  if (process.env.VITEST) return ':memory:';
  return join(process.cwd(), 'data', 'polymeet.sqlite');
}

const usageSessionSchema = `
    CREATE TABLE IF NOT EXISTS usage_sessions (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      meeting_id TEXT NOT NULL,
      meeting_title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('recording', 'file_transcription', 'minutes', 'translation')),
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      duration_seconds REAL NOT NULL DEFAULT 0,
      active_intervals TEXT,
      PRIMARY KEY (user_id, id)
    );
`;

function initializeSchema(db: DatabaseSync, dbPath: string) {
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
      allow_server_keys INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      meeting_id TEXT NOT NULL,
      meeting_title TEXT NOT NULL,
      usage_session_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('live_stt', 'file_stt', 'translation', 'minutes')),
      provider TEXT NOT NULL CHECK (provider IN ('openai', 'gemini')),
      model TEXT NOT NULL,
      key_source TEXT NOT NULL CHECK (key_source IN ('server_env', 'byok')),
      usage_date TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      duration_seconds REAL NOT NULL DEFAULT 0,
      audio_seconds REAL NOT NULL DEFAULT 0,
      text_input_tokens INTEGER NOT NULL DEFAULT 0,
      audio_input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      estimated INTEGER NOT NULL DEFAULT 0,
      pricing_missing INTEGER NOT NULL DEFAULT 0,
      pending_reconciliation INTEGER NOT NULL DEFAULT 0,
      provider_reference TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage_events(user_id, usage_date);
    CREATE INDEX IF NOT EXISTS idx_usage_date_key ON usage_events(usage_date, key_source);
    CREATE INDEX IF NOT EXISTS idx_usage_meeting ON usage_events(user_id, meeting_id);
    CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events(user_id, usage_session_id);

    ${usageSessionSchema}
    CREATE INDEX IF NOT EXISTS idx_usage_sessions_meeting ON usage_sessions(user_id, meeting_id);

    CREATE TABLE IF NOT EXISTS model_pricing (
      provider TEXT NOT NULL CHECK (provider IN ('openai', 'gemini')),
      model TEXT NOT NULL,
      input_per_1m REAL NOT NULL DEFAULT 0,
      audio_input_per_1m REAL NOT NULL DEFAULT 0,
      cached_input_per_1m REAL NOT NULL DEFAULT 0,
      output_per_1m REAL NOT NULL DEFAULT 0,
      per_minute REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider, model)
    );

    CREATE TABLE IF NOT EXISTS usage_resolutions (
      event_id TEXT PRIMARY KEY REFERENCES usage_events(id) ON DELETE CASCADE,
      admin_id TEXT NOT NULL REFERENCES users(id),
      resolved_at INTEGER NOT NULL,
      note TEXT NOT NULL,
      previous_cost_usd REAL NOT NULL,
      cost_usd REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.exec('BEGIN IMMEDIATE');
  try {
    const usageColumns = db.prepare('PRAGMA table_info(usage_events)').all();
    if (!usageColumns.some((column) => column.name === 'pending_reconciliation')) {
      db.exec(
        'ALTER TABLE usage_events ADD COLUMN pending_reconciliation INTEGER NOT NULL DEFAULT 0',
      );
    }
    if (!usageColumns.some((column) => column.name === 'provider_reference')) {
      db.exec('ALTER TABLE usage_events ADD COLUMN provider_reference TEXT');
    }
    const sessionColumns = db.prepare('PRAGMA table_info(usage_sessions)').all();
    if (!sessionColumns.some((column) => column.name === 'user_id' && column.pk === 1)) {
      db.exec(`
        ALTER TABLE usage_sessions RENAME TO previous_usage_sessions;
        ${usageSessionSchema}
        INSERT INTO usage_sessions (id, user_id, meeting_id, meeting_title, kind, started_at, ended_at, duration_seconds)
        SELECT id, user_id, meeting_id, meeting_title, kind, started_at, ended_at, duration_seconds
        FROM previous_usage_sessions;
        DROP TABLE previous_usage_sessions;
        CREATE INDEX idx_usage_sessions_meeting ON usage_sessions(user_id, meeting_id);
      `);
    } else if (!sessionColumns.some((column) => column.name === 'active_intervals')) {
      db.exec('ALTER TABLE usage_sessions ADD COLUMN active_intervals TEXT');
    }
    const pricingColumns = db.prepare('PRAGMA table_info(model_pricing)').all();
    if (!pricingColumns.some((column) => column.name === 'is_builtin')) {
      db.exec('ALTER TABLE model_pricing ADD COLUMN is_builtin INTEGER NOT NULL DEFAULT 0');
      correctLegacyGeminiPricing(db);
    }
    db.exec(`
      DELETE FROM model_pricing
        WHERE provider = 'gemini' AND model = 'gemini-2.0-flash' AND is_builtin = 1;
      CREATE INDEX IF NOT EXISTS idx_usage_events_unsettled
        ON usage_events(started_at DESC, id DESC)
        WHERE pending_reconciliation = 1 OR pricing_missing = 1;
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const now = Date.now();
  const insertPricing = db.prepare(`
    INSERT OR IGNORE INTO model_pricing (
      provider, model, input_per_1m, audio_input_per_1m,
      cached_input_per_1m, output_per_1m, per_minute, updated_at, is_builtin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  for (const item of DEFAULT_MODEL_PRICING) {
    insertPricing.run(
      item.provider,
      item.model,
      item.inputPer1M,
      item.audioInputPer1M,
      item.cachedInputPer1M,
      item.outputPer1M,
      item.perMinute,
      now,
    );
  }

  const insertSetting = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)');
  insertSetting.run('currency_code', '');
  insertSetting.run('exchange_rate', '0');

  bootstrapEnvAdmin(db);
}

function correctLegacyGeminiPricing(db: DatabaseSync) {
  const standard = DEFAULT_MODEL_PRICING.find((rate) => rate.model === 'gemini-3.8-flash')!;
  const legacy = { ...standard, cachedInputPer1M: 0.1875 };
  const updated = db
    .prepare(
      `UPDATE model_pricing SET cached_input_per_1m = ?, is_builtin = 1
     WHERE provider = ? AND model = ? AND input_per_1m = ? AND audio_input_per_1m = ?
       AND cached_input_per_1m = ? AND output_per_1m = ? AND per_minute = ?`,
    )
    .run(
      standard.cachedInputPer1M,
      legacy.provider,
      legacy.model,
      legacy.inputPer1M,
      legacy.audioInputPer1M,
      legacy.cachedInputPer1M,
      legacy.outputPer1M,
      legacy.perMinute,
    );
  if (!updated.changes) return;

  const updateCost = db.prepare('UPDATE usage_events SET cost_usd = ? WHERE id = ?');
  const events = db
    .prepare(
      `SELECT id, model, started_at, operation, text_input_tokens, audio_input_tokens,
            cached_input_tokens, output_tokens, audio_seconds, cost_usd
     FROM usage_events WHERE provider = 'gemini' AND model LIKE 'gemini-3.8-flash%'
       AND pending_reconciliation = 0 AND pricing_missing = 0`,
    )
    .iterate();
  for (const row of events) {
    if (normalizeModelKey(String(row.model)) !== legacy.model) continue;
    const usage = {
      textInputTokens: Number(row.text_input_tokens),
      audioInputTokens: Number(row.audio_input_tokens),
      cachedInputTokens: Number(row.cached_input_tokens),
      outputTokens: Number(row.output_tokens),
      audioSeconds: Number(row.audio_seconds),
      operation: row.operation as UsageOperation,
    };
    const previousCost = calculateUsageCost(legacy, usage).costUsd;
    // Only revise entries consistent with the shipped rate. Keep other historical prices.
    if (Math.abs(previousCost - Number(row.cost_usd)) > 1e-10) continue;
    const newCost = calculateUsageCost(
      builtinPricingAt(standard, Number(row.started_at)),
      usage,
    ).costUsd;
    if (newCost !== previousCost) updateCost.run(newCost, row.id);
  }
}

function bootstrapEnvAdmin(db: DatabaseSync) {
  const rawUser = process.env.POLYMEET_ADMIN_USERNAME?.trim().toLowerCase();
  const rawPass = process.env.POLYMEET_ADMIN_PASSWORD;
  if (!rawUser || !rawPass) return;
  if (!/^[a-z0-9._-]{2,40}$/.test(rawUser) || rawPass.length < 6 || rawPass.length > 200) {
    console.warn('[auth] POLYMEET_ADMIN_USERNAME or POLYMEET_ADMIN_PASSWORD is invalid; skipped.');
    return;
  }
  const existing = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (existing) return;
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role, allow_server_keys, active, created_at)
     SELECT ?, ?, ?, ?, 'admin', 1, 1, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
  ).run(randomUUID(), rawUser, '系統管理員', hashPassword(rawPass), Date.now());
}

export function getDb(): DatabaseSync {
  const target = resolveDbPath();
  if (!instance || currentPath !== target) {
    instance?.close();
    if (target !== ':memory:') {
      mkdirSync(dirname(target), { recursive: true });
    }
    instance = new DatabaseSync(target);
    currentPath = target;
    initializeSchema(instance, target);
  }
  return instance;
}

export function closeDb(): void {
  instance?.close();
  instance = undefined;
  currentPath = undefined;
}

export function resetDbForTesting(dbPath = ':memory:'): DatabaseSync {
  process.env.POLYMEET_DB_PATH = dbPath;
  closeDb();
  return getDb();
}
