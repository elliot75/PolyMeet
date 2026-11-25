import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/server/app';
import {
  createSession,
  createUser,
  resetLoginRateLimitsForTesting,
  SESSION_COOKIE_NAME,
} from '../src/server/auth';
import { getDb, resetDbForTesting } from '../src/server/db';
import {
  completeUsageSession,
  getUsageCalendar,
  queryUsageReport,
  recordUsageEvent,
} from '../src/server/usage';

const setupToken = 'fixture-only-setup-token-at-least-32-characters';

function extractCookie(response: Response): string {
  const header = response.headers.get('set-cookie') || '';
  return header.split(';')[0];
}

describe('auth, user isolation, and admin .env billing reconciliation', () => {
  const origOpenAi = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    vi.stubEnv('POLYMEET_SETUP_TOKEN', setupToken);
    resetDbForTesting(':memory:');
    resetLoginRateLimitsForTesting();
    process.env.OPENAI_API_KEY = 'server-env-secret';
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (origOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = origOpenAi;
  });

  it('supports first-run admin setup, login, password change, rate limiting, and session teardown', async () => {
    const initial = await app.request('/api/auth/me');
    expect(await initial.json()).toEqual({
      authenticated: false,
      needsSetup: true,
      setupAvailable: true,
      user: null,
    });

    const setupRes = await app.request('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        setupToken,
        displayName: '主管',
        password: 'admin-password',
      }),
    });
    expect(setupRes.status).toBe(201);
    const adminCookie = extractCookie(setupRes);
    expect(adminCookie).toContain('polymeet_session=');

    // Second setup attempt must fail with 409.
    const secondSetup = await app.request('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'admin2',
        setupToken,
        displayName: 'Admin 2',
        password: 'admin-password',
      }),
    });
    expect(secondSetup.status).toBe(409);

    // Create a second session for the same admin to verify password change revokes all old sessions
    const secondLogin = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-password' }),
    });
    const otherDeviceCookie = extractCookie(secondLogin);

    // Change own password rotates current session and revokes all previous sessions
    const pwdRes = await app.request('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        currentPassword: 'admin-password',
        newPassword: 'new-admin-password',
      }),
    });
    expect(pwdRes.status).toBe(200);
    const rotatedAdminCookie = extractCookie(pwdRes);
    expect(rotatedAdminCookie).toContain('polymeet_session=');
    expect(rotatedAdminCookie).not.toBe(adminCookie);
    expect(
      (await (await app.request('/api/auth/me', { headers: { Cookie: adminCookie } })).json())
        .authenticated,
    ).toBe(false);
    expect(
      (await (await app.request('/api/auth/me', { headers: { Cookie: otherDeviceCookie } })).json())
        .authenticated,
    ).toBe(false);
    expect(
      (
        await (
          await app.request('/api/auth/me', { headers: { Cookie: rotatedAdminCookie } })
        ).json()
      ).authenticated,
    ).toBe(true);

    // Logout clears rotated session
    const logoutRes = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: rotatedAdminCookie },
    });
    expect(logoutRes.status).toBe(200);
    const afterLogout = await app.request('/api/auth/me', {
      headers: { Cookie: rotatedAdminCookie },
    });
    expect((await afterLogout.json()).authenticated).toBe(false);

    // Failed logins hit rate limit even when X-Forwarded-For is spoofed on every attempt
    for (let i = 0; i < 10; i++) {
      const bad = await app.request('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': `203.0.113.${i + 1}, 198.51.100.${i + 1}`,
        },
        body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
      });
      expect(bad.status).toBe(401);
    }
    const blocked = await app.request('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.99',
      },
      body: JSON.stringify({ username: 'admin', password: 'new-admin-password' }),
    });
    expect(blocked.status).toBe(429);

    resetLoginRateLimitsForTesting();
    const okLogin = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'new-admin-password' }),
    });
    expect(okLogin.status).toBe(200);
    expect((await okLogin.json()).user.role).toBe('admin');
  });

  it('requires a configured setup token and allows only one initialization', async () => {
    const createAdmin = (username: string, token?: string) =>
      app.request('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, setupToken: token, password: 'fixture-password' }),
      });
    vi.stubEnv('POLYMEET_SETUP_TOKEN', '');
    expect((await createAdmin('admin')).status).toBe(403);
    vi.stubEnv('POLYMEET_SETUP_TOKEN', setupToken);
    expect((await createAdmin('admin', 'incorrect')).status).toBe(403);
    const results = await Promise.all([
      createAdmin('admin', setupToken),
      createAdmin('another', setupToken),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
  });

  it('accepts a bound workspace only for the account in the current cookie', async () => {
    const alice = createUser({
      username: 'alice',
      displayName: 'Alice',
      password: 'fixture-password',
    });
    const bob = createUser({ username: 'bob', displayName: 'Bob', password: 'fixture-password' });
    const { token } = createSession(bob.id);
    const cookie = `${SESSION_COOKIE_NAME}=${token}`;
    const requestUsage = (id: string, currentCookie: string) =>
      app.request('/api/usage/my', {
        headers: { Cookie: currentCookie, 'X-PolyMeet-Account': id },
      });

    expect((await requestUsage(bob.id, cookie)).status).toBe(200);
    const mismatch = await requestUsage(alice.id, cookie);
    expect(mismatch.status).toBe(409);
    expect(mismatch.headers.get('X-PolyMeet-Session-State')).toBe('changed');
    expect((await requestUsage(bob.id, '')).status).toBe(401);
  });

  it('splits time at midnight, deduplicates overlapping tracks, and scopes time to the key source', () => {
    const user = createUser({
      username: 'reporter',
      displayName: 'Reporter',
      password: 'fixture-password',
    });
    const startedAt = new Date(2026, 10, 24, 23, 59).getTime();
    const endedAt = startedAt + 120_000;
    const meeting = {
      userId: user.id,
      meetingId: 'meeting',
      meetingTitle: 'Meeting',
      usageSessionId: 'recording',
    };
    const live = {
      ...meeting,
      startedAt,
      endedAt,
      durationSeconds: 120,
      audioSeconds: 120,
      provider: 'openai',
      model: 'gpt-live-transcribe',
      operation: 'live_stt',
      keySource: 'byok',
    } as const;
    recordUsageEvent(live);
    recordUsageEvent(live);
    recordUsageEvent({
      ...meeting,
      startedAt: endedAt - 2_000,
      endedAt,
      durationSeconds: 2,
      textInputTokens: 100,
      provider: 'openai',
      model: 'gpt-5-mini',
      operation: 'translation',
      keySource: 'server_env',
    });
    completeUsageSession({
      ...meeting,
      startedAt,
      endedAt,
      durationSeconds: 120,
      kind: 'recording',
    });

    const all = queryUsageReport({ userId: user.id });
    expect(all.dailyMeetings.map((day) => [day.usageDate, day.durationSeconds])).toEqual([
      ['2026-11-25', 60],
      ['2026-11-24', 60],
    ]);
    expect(all.totals.durationSeconds).toBe(120);
    expect(all.accounts[0].durationSeconds).toBe(120);
    expect(queryUsageReport({ keySource: 'server_env' }).totals.durationSeconds).toBe(2);
    const nextDay = queryUsageReport({ keySource: 'byok', fromDate: '2026-11-25' });
    expect(nextDay.dailyMeetings).toHaveLength(1);
    expect(nextDay.totals).toMatchObject({ durationSeconds: 60, costUsd: 0 });
  });

  it('uses active recording intervals and keeps zero-cost local recordings in personal history', async () => {
    const user = createUser({
      username: 'interval-user',
      displayName: 'Recorder',
      password: 'fixture-password',
    });
    const { token } = createSession(user.id);
    const cookie = `${SESSION_COOKIE_NAME}=${token}`;
    const startedAt = new Date(2026, 10, 24, 23, 58).getTime();
    const endedAt = startedAt + 240_000;
    vi.spyOn(Date, 'now').mockReturnValue(endedAt + 60_000);
    const key = { meetingId: 'paused', meetingTitle: 'Paused', usageSessionId: 'paused-session' };
    const live = {
      ...key,
      userId: user.id,
      startedAt: startedAt - 2000,
      endedAt: endedAt + 3000,
      audioSeconds: 90,
      provider: 'openai',
      model: 'gpt-live-transcribe',
      operation: 'live_stt',
      keySource: 'server_env',
    } as const;
    recordUsageEvent(live);
    recordUsageEvent(live);
    const complete = (body: Record<string, unknown>) =>
      app.request('/api/usage/sessions/complete', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const session = {
      ...key,
      startedAt,
      endedAt,
      kind: 'recording',
      durationSeconds: 90,
      activeIntervals: [
        [startedAt, startedAt + 60_000],
        [startedAt + 210_000, endedAt],
      ],
    };
    expect((await complete(session)).status).toBe(200);
    expect(
      (
        await complete({
          ...session,
          activeIntervals: [
            [startedAt, endedAt],
            [startedAt, endedAt],
          ],
        })
      ).status,
    ).toBe(400);
    const system = queryUsageReport({ userId: user.id, keySource: 'server_env' });
    expect(system.dailyMeetings.map((row) => [row.usageDate, row.durationSeconds])).toEqual([
      ['2026-11-25', 30],
      ['2026-11-24', 60],
    ]);
    expect(system.totals.durationSeconds).toBe(90);

    expect(
      (
        await complete({
          meetingId: 'local-only',
          meetingTitle: 'Local only',
          usageSessionId: 'local-session',
          kind: 'recording',
          startedAt,
          endedAt: startedAt + 45_000,
          durationSeconds: 45,
          activeIntervals: [[startedAt, startedAt + 45_000]],
        })
      ).status,
    ).toBe(200);
    const local = await app.request('/api/usage/my?search=Local%20only', {
      headers: { Cookie: cookie },
    });
    expect((await local.json()).dailyMeetings).toMatchObject([
      {
        meetingId: 'local-only',
        durationSeconds: 45,
        totalTokens: 0,
        costUsd: 0,
        models: [],
      },
    ]);
    expect(
      queryUsageReport({ userId: user.id, keySource: 'server_env' }).dailyMeetings.some(
        (row) => row.meetingId === 'local-only',
      ),
    ).toBe(false);
    const csv = await app.request('/api/usage/my?search=Local%20only&format=csv', {
      headers: { Cookie: cookie },
    });
    expect(await csv.text()).toContain('本機錄音');
  });

  it('derives calendar presets from the server timezone at midnight', async () => {
    vi.stubEnv('TZ', 'Asia/Taipei');
    const calendar = getUsageCalendar(new Date('2026-11-30T16:00:00Z'));
    expect(calendar.timeZone).toBe('Asia/Taipei');
    expect(calendar.ranges.today).toEqual({ from: '2026-12-01', to: '2026-12-01' });
    expect(calendar.ranges.month).toEqual({ from: '2026-12-01', to: '2026-12-01' });
    expect(calendar.ranges.last_month).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    const user = createUser({
      username: 'calendar-user',
      displayName: 'Recorder',
      password: 'fixture-password',
    });
    const { token } = createSession(user.id);
    const response = await app.request('/api/usage/calendar', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    expect(await response.json()).toMatchObject({ timeZone: 'Asia/Taipei' });
  });

  it('surfaces missing rates in reports and lets an admin resolve one call with an audit entry', async () => {
    const admin = createUser({
      username: 'auditor',
      displayName: 'Auditor',
      password: 'fixture-password',
      role: 'admin',
    });
    const user = createUser({
      username: 'member',
      displayName: 'Member',
      password: 'fixture-password',
    });
    const authCookie = (userId: string) => `${SESSION_COOKIE_NAME}=${createSession(userId).token}`;
    const adminCookie = authCookie(admin.id);
    const memberCookie = authCookie(user.id);
    const startedAt = Date.now();
    const context = {
      userId: user.id,
      operation: 'minutes',
      provider: 'openai',
      model: 'unpriced-fixture',
      keySource: 'server_env',
      startedAt,
      endedAt: startedAt + 1000,
      textInputTokens: 150,
      outputTokens: 20,
      providerReference: 'fixture-provider-id',
      meetingTitle: 'Monthly review',
    } as const;
    const usage = recordUsageEvent(context);
    expect(queryUsageReport({ keySource: 'server_env' }).totals.pendingCalls).toBe(1);
    const csv = await app.request('/api/admin/usage?format=csv', {
      headers: { Cookie: adminCookie },
    });
    const csvText = await csv.text();
    expect(csvText).toContain('未設定費率');
    expect(csvText).toContain(',未設定費率,0.000000');

    const pending = await app.request('/api/admin/usage/pending', {
      headers: { Cookie: adminCookie },
    });
    expect((await pending.json()).entries).toMatchObject([
      {
        id: usage.id,
        username: 'member',
        model: 'unpriced-fixture',
        startedAt,
        providerReference: 'fixture-provider-id',
        pendingReconciliation: false,
        pricingMissing: true,
      },
    ]);
    const pendingCsv = await app.request('/api/admin/usage/pending?format=csv', {
      headers: { Cookie: adminCookie },
    });
    expect(await pendingCsv.text()).toContain(`${usage.id},fixture-provider-id`);
    const confirm = (cookie: string, data: unknown) =>
      app.request(`/api/admin/usage/pending/${usage.id}`, {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    const resolution = {
      note: '供應商帳單',
      costUsd: 0.004,
      tokens: {
        textInputTokens: 180,
        audioInputTokens: 0,
        cachedInputTokens: 15,
        outputTokens: 30,
      },
    };
    expect((await confirm(memberCookie, resolution)).status).toBe(403);
    expect((await confirm(adminCookie, { ...resolution, note: '' })).status).toBe(400);
    expect((await confirm(adminCookie, resolution)).status).toBe(200);
    expect((await confirm(adminCookie, resolution)).status).toBe(409);
    expect(
      getDb()
        .prepare(
          'SELECT admin_id, note, previous_cost_usd FROM usage_resolutions WHERE event_id = ?',
        )
        .get(usage.id),
    ).toMatchObject({ admin_id: admin.id, note: '供應商帳單', previous_cost_usd: 0 });

    recordUsageEvent({ ...context, id: usage.id, pendingReconciliation: true });
    expect(queryUsageReport({ keySource: 'server_env' }).totals).toMatchObject({
      pendingCalls: 0,
      totalTokens: 210,
      costUsd: 0.004,
    });

    // Adding pricing later automatically settles unpriced historical calls while keeping pending_reconciliation rows untouched
    const autoSettleTarget = recordUsageEvent({
      ...context,
      model: 'custom-auto-model',
      textInputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    const stillPending = recordUsageEvent({
      ...context,
      model: 'custom-auto-model',
      textInputTokens: 0,
      outputTokens: 0,
      pendingReconciliation: true,
    });
    expect(autoSettleTarget.pricingMissing).toBe(true);
    expect(stillPending.pendingReconciliation).toBe(true);
    expect(queryUsageReport({ keySource: 'server_env' }).totals.pendingCalls).toBe(2);

    const priceRes = await app.request('/api/admin/pricing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        provider: 'openai',
        model: 'custom-auto-model',
        inputPer1M: 1,
        audioInputPer1M: 0,
        cachedInputPer1M: 0,
        outputPer1M: 2,
        perMinute: 0,
      }),
    });
    expect(priceRes.status).toBe(200);
    expect((await priceRes.json()).settledCount).toBe(1);
    const settledReport = queryUsageReport({ keySource: 'server_env' });
    expect(settledReport.totals.pendingCalls).toBe(1);
    expect(settledReport.totals.costUsd).toBeCloseTo(0.004 + 2.0, 6);
  });

  it('enforces admin user management, last-admin protection, and .env key permissions', async () => {
    const setupRes = await app.request('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        setupToken,
        displayName: 'Admin',
        password: 'password123',
      }),
    });
    const adminBody = await setupRes.json();
    const adminCookie = extractCookie(setupRes);

    // Cannot demote or deactivate the last active admin.
    const demoteSelf = await app.request(`/api/admin/users/${adminBody.user.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ role: 'user' }),
    });
    expect(demoteSelf.status).toBe(400);
    expect((await demoteSelf.json()).error).toBe('last_admin_protected');

    // Create alice (allowed .env) and bob (restricted to BYOK).
    const aliceRes = await app.request('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        username: 'alice',
        displayName: 'Alice',
        password: 'password123',
        role: 'user',
        allowServerKeys: true,
      }),
    });
    expect(aliceRes.status).toBe(201);
    const alice = (await aliceRes.json()).user;

    const bobRes = await app.request('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        username: 'bob',
        displayName: 'Bob',
        password: 'password123',
        role: 'user',
        allowServerKeys: false,
      }),
    });
    expect(bobRes.status).toBe(201);
    const bob = (await bobRes.json()).user;

    const bobLogin = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'password123' }),
    });
    const bobCookie = extractCookie(bobLogin);

    // Non-admin cannot hit admin endpoints.
    expect((await app.request('/api/admin/users', { headers: { Cookie: bobCookie } })).status).toBe(
      403,
    );

    // Restricted bob cannot use .env key.
    const bobNoKey = await app.request('/api/minutes/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: bobCookie },
      body: JSON.stringify({
        provider: 'openai',
        model: 'gpt-5-mini',
        text: 'hello',
        targetLanguage: '繁體中文',
        action: 'polish',
        style: 'standard',
      }),
    });
    expect(bobNoKey.status).toBe(401);
    expect(await bobNoKey.json()).toEqual({ error: 'missing_api_key' });

    // Deactivating alice immediately invalidates her session.
    const aliceLogin = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'password123' }),
    });
    const aliceCookie = extractCookie(aliceLogin);
    await app.request(`/api/admin/users/${alice.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ active: false }),
    });
    const aliceCheck = await app.request('/api/auth/me', { headers: { Cookie: aliceCookie } });
    expect((await aliceCheck.json()).authenticated).toBe(false);
    expect(bob.allowServerKeys).toBe(false);

    // An admin with allowServerKeys=false must not be told serverKeys are available in /api/health
    await app.request(`/api/admin/users/${adminBody.user.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ allowServerKeys: false }),
    });
    const adminHealth = await (
      await app.request('/api/health', { headers: { Cookie: adminCookie } })
    ).json();
    expect(adminHealth.serverKeys).toEqual({ openai: false, gemini: false });
  });

  it('tracks multi-user daily/meeting usage, reconciles .env keys, handles dual-track durations, renames, and exports CSV', async () => {
    const setupRes = await app.request('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        setupToken,
        displayName: '管理員',
        password: 'password123',
      }),
    });
    const adminCookie = extractCookie(setupRes);

    const alice = (
      await (
        await app.request('/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({
            username: 'alice',
            displayName: 'Alice Lin',
            password: 'password123',
            role: 'user',
            allowServerKeys: true,
          }),
        })
      ).json()
    ).user;
    const bob = (
      await (
        await app.request('/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify({
            username: 'bob',
            displayName: 'Bob Wu',
            password: 'password123',
            role: 'user',
            allowServerKeys: true,
          }),
        })
      ).json()
    ).user;

    const aliceLogin = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'password123' }),
    });
    const aliceCookie = extractCookie(aliceLogin);

    // Dual-track live_stt + translation during one 120s recording session on 2026-11-24 (.env)
    recordUsageEvent({
      userId: alice.id,
      meetingId: 'm-a1',
      meetingTitle: '=FormulaMeeting',
      usageSessionId: 'sess-rec-1',
      operation: 'live_stt',
      provider: 'openai',
      model: 'gpt-live-transcribe',
      keySource: 'server_env',
      usageDate: '2026-11-24',
      startedAt: 1000,
      endedAt: 121_000,
      durationSeconds: 120,
      audioSeconds: 120,
    });
    recordUsageEvent({
      userId: alice.id,
      meetingId: 'm-a1',
      meetingTitle: '=FormulaMeeting',
      usageSessionId: 'sess-rec-1',
      operation: 'live_stt',
      provider: 'openai',
      model: 'gpt-live-transcribe',
      keySource: 'server_env',
      usageDate: '2026-11-24',
      startedAt: 1000,
      endedAt: 121_000,
      durationSeconds: 120,
      audioSeconds: 120,
    });
    recordUsageEvent({
      userId: alice.id,
      meetingId: 'm-a1',
      meetingTitle: '=FormulaMeeting',
      usageSessionId: 'sess-rec-1',
      operation: 'translation',
      provider: 'openai',
      model: 'gpt-5-mini',
      keySource: 'server_env',
      usageDate: '2026-11-24',
      startedAt: 50_000,
      endedAt: 52_000,
      durationSeconds: 2,
      textInputTokens: 1_000_000,
      outputTokens: 500_000,
      totalTokens: 1_500_000,
    });

    // Complete the session with wall-clock 120s
    const completeRes = await app.request('/api/usage/sessions/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({
        usageSessionId: 'sess-rec-1',
        meetingId: 'm-a1',
        meetingTitle: 'Product Sync',
        kind: 'recording',
        startedAt: 1000,
        endedAt: 121_000,
        durationSeconds: 120,
      }),
    });
    expect(completeRes.status).toBe(200);
    const summaryJson = (await completeRes.json()).summary;
    // 2 * (2 min * 0.017) + (0.25 + 1.0) = 0.068 + 1.25 = 1.318
    expect(summaryJson.durationSeconds).toBe(120);
    expect(summaryJson.audioSeconds).toBe(240);
    expect(summaryJson.costUsd).toBeCloseTo(1.318, 6);
    expect(summaryJson.meetingTitle).toBe('Product Sync');

    // Alice also has a BYOK call on 2026-11-25
    recordUsageEvent({
      userId: alice.id,
      meetingId: 'm-a2',
      meetingTitle: 'Private 1:1',
      usageSessionId: 'sess-byok-1',
      operation: 'minutes',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      keySource: 'byok',
      usageDate: '2026-11-25',
      startedAt: 200_000,
      endedAt: 205_000,
      durationSeconds: 5,
      textInputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
    });

    // Bob uses .env on 2026-11-25
    recordUsageEvent({
      userId: bob.id,
      meetingId: 'm-b1',
      meetingTitle: 'Sales Call',
      usageSessionId: 'sess-bob-1',
      operation: 'file_stt',
      provider: 'openai',
      model: 'whisper-1',
      keySource: 'server_env',
      usageDate: '2026-11-25',
      startedAt: 300_000,
      endedAt: 310_000,
      durationSeconds: 10,
      audioSeconds: 300,
    });

    // Alice personal usage only includes Alice's 2 meetings
    const aliceReport = await (
      await app.request('/api/usage/my', { headers: { Cookie: aliceCookie } })
    ).json();
    expect(aliceReport.dailyMeetings).toHaveLength(2);
    expect(aliceReport.totals.meetingCount).toBe(2);

    // Rename Alice's meeting and verify propagation
    await app.request('/api/usage/meetings/m-a1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({ meetingTitle: '=RenamedFormula' }),
    });

    // Configure TWD currency and custom pricing
    await app.request('/api/admin/currency', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ currencyCode: 'TWD', exchangeRate: 32 }),
    });
    const putPriceRes = await app.request('/api/admin/pricing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        provider: 'openai',
        model: 'custom-model',
        inputPer1M: 1,
        audioInputPer1M: 0,
        cachedInputPer1M: 0,
        outputPer1M: 2,
        perMinute: 0,
      }),
    });
    expect(putPriceRes.status).toBe(200);
    const delPriceRes = await app.request('/api/admin/pricing?provider=openai&model=custom-model', {
      method: 'DELETE',
      headers: { Cookie: adminCookie },
    });
    expect(delPriceRes.status).toBe(200);

    // Admin reconciliation defaults to keySource=server_env (excludes Alice's BYOK meeting m-a2)
    const adminRecon = await (
      await app.request('/api/admin/usage', { headers: { Cookie: adminCookie } })
    ).json();
    expect(adminRecon.currencyCode).toBe('TWD');
    expect(adminRecon.exchangeRate).toBe(32);
    expect(adminRecon.accounts).toHaveLength(2);
    expect(adminRecon.dailyMeetings).toHaveLength(2);
    expect(adminRecon.totals.costUsd).toBeCloseTo(1.318 + 0.03, 6);
    expect(adminRecon.dailyMeetings.map((d: { meetingTitle: string }) => d.meetingTitle)).toEqual([
      'Sales Call',
      '=RenamedFormula',
    ]);

    // CSV export escapes formula cells, includes UTF-8 BOM and totals
    const detailCsvRes = await app.request('/api/admin/usage?format=csv&csvMode=detail', {
      headers: { Cookie: adminCookie },
    });
    const detailBuf = new Uint8Array(await detailCsvRes.arrayBuffer());
    expect(Array.from(detailBuf.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const detailCsv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(detailBuf);
    expect(detailCsv.startsWith('\uFEFF')).toBe(true);
    expect(detailCsv).toContain("'=RenamedFormula");
    expect(detailCsv).toContain('費用 (TWD)');
    expect(detailCsv).toContain('小計');

    const accountCsvRes = await app.request('/api/admin/usage?format=csv&csvMode=account', {
      headers: { Cookie: adminCookie },
    });
    const accountCsv = await accountCsvRes.text();
    expect(accountCsv).toContain('alice,Alice Lin');
    expect(accountCsv).toContain('bob,Bob Wu');
    expect(accountCsv).toContain('小計');
  });
});
