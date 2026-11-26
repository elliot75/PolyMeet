import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createUser } from '../src/server/auth';
import { resetDbForTesting } from '../src/server/db';
import {
  listModelPricing,
  queryUsageReport,
  recordUsageEvent,
  upsertModelPricing,
} from '../src/server/usage';

it('refreshes built-in prices on restart while retaining custom rates and recorded charges', () => {
  const directory = mkdtempSync(join(tmpdir(), 'polymeet-rates-'));
  const databasePath = join(directory, 'billing.sqlite');
  const startedAt = Date.UTC(2026, 10, 26);
  try {
    const db = resetDbForTesting(databasePath);
    db.exec(`
      DELETE FROM model_pricing WHERE model IN ('gpt-6-luna', 'gpt-realtime-whisper');
      UPDATE model_pricing SET cached_input_per_1m = 0.075 WHERE model = 'gemini-3.5-flash-lite';
      INSERT INTO model_pricing VALUES ('gemini', 'gemini-2.0-flash', 0.1, 0.7, 0.025, 0.4, 0, 0, 1);
    `);
    const user = createUser({
      username: 'fixture',
      displayName: 'Fixture',
      password: 'fixture-password',
    });
    const event = recordUsageEvent({
      userId: user.id,
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
      operation: 'translation',
      keySource: 'server_env',
      textInputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      startedAt,
      endedAt: startedAt + 1000,
    });
    db.prepare('UPDATE usage_events SET cost_usd = ? WHERE id = ?').run(0.075, event.id);
    const pro = listModelPricing(startedAt).find((row) => row.model === 'gemini-2.5-pro')!;
    upsertModelPricing({ ...pro, cachedInputPer1M: 0.42 });

    resetDbForTesting(databasePath);
    const rates = listModelPricing(startedAt);
    expect(rates.find((row) => row.model === 'gpt-6-luna')).toMatchObject({
      inputPer1M: 0.1,
      cachedInputPer1M: 0.01,
      outputPer1M: 0.5,
    });
    expect(rates.find((row) => row.model === 'gpt-realtime-whisper')?.perMinute).toBe(0.017);
    expect(rates.find((row) => row.model === 'gemini-3.5-flash-lite')?.cachedInputPer1M).toBe(0.03);
    expect(rates.some((row) => row.model === 'gemini-2.0-flash')).toBe(false);
    expect(
      listModelPricing(Date.UTC(2026, 11, 1)).find((row) => row.model === 'gemini-2.5-pro'),
    ).toMatchObject({ cachedInputPer1M: 0.42, outputPer1M: 10 });
    expect(queryUsageReport({ userId: user.id }).totals.costUsd).toBeCloseTo(0.075);
  } finally {
    resetDbForTesting(':memory:');
    rmSync(directory, { recursive: true, force: true });
  }
});

it('updates shipped Gemini pricing and identifiable historical charges on an existing database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'polymeet-billing-'));
  const databasePath = join(directory, 'billing.sqlite');
  const dateBeforeRateChange = Date.UTC(2026, 10, 27);
  const rateChange = Date.UTC(2027, 0, 1);
  try {
    const db = resetDbForTesting(databasePath);
    const user = createUser({
      username: 'fixture',
      displayName: 'User',
      password: 'fixture-password',
    });
    const context = {
      userId: user.id,
      operation: 'minutes',
      provider: 'gemini',
      keySource: 'server_env',
      textInputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      startedAt: dateBeforeRateChange,
      endedAt: dateBeforeRateChange + 1000,
    } as const;
    const known = recordUsageEvent({ ...context, model: 'gemini-3.8-flash' });
    const customized = recordUsageEvent({ ...context, model: 'gemini-3.8-flash' });
    db.prepare('UPDATE usage_events SET cost_usd = ? WHERE id = ?').run(0.1875, known.id);
    db.prepare('UPDATE usage_events SET cost_usd = ? WHERE id = ?').run(0.5, customized.id);
    db.exec(
      "UPDATE model_pricing SET cached_input_per_1m = 0.1875 WHERE model = 'gemini-3.8-flash'",
    );
    db.exec('ALTER TABLE model_pricing DROP COLUMN is_builtin');

    resetDbForTesting(databasePath);
    expect(queryUsageReport({ userId: user.id }).totals.costUsd).toBeCloseTo(0.575);
    const flash = (at: number) =>
      listModelPricing(at).find((row) => row.model === 'gemini-3.8-flash')!;
    expect(flash(dateBeforeRateChange).cachedInputPer1M).toBe(0.075);
    expect(flash(rateChange)).toMatchObject({
      cachedInputPer1M: 0.15,
      inputPer1M: 1.5,
      outputPer1M: 7.5,
    });
    const upcoming = recordUsageEvent({
      ...context,
      model: 'gemini-3.8-flash',
      startedAt: rateChange,
      endedAt: rateChange + 1000,
    });
    expect(upcoming.costUsd).toBeCloseTo(0.15);
    upsertModelPricing({ ...flash(dateBeforeRateChange), cachedInputPer1M: 0.42 });
    resetDbForTesting(databasePath);
    expect(flash(rateChange).cachedInputPer1M).toBe(0.42);
    expect(queryUsageReport({ userId: user.id }).totals.costUsd).toBeCloseTo(0.725);
  } finally {
    resetDbForTesting(':memory:');
    rmSync(directory, { recursive: true, force: true });
  }
});
