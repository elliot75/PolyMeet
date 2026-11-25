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
