import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AuthUser, UserRole } from '../shared/types';
import { getDb } from './db';
import { hashPassword, verifyPassword } from './password';

export const SESSION_COOKIE_NAME = 'polymeet_session';
const DEFAULT_SESSION_TTL_HOURS = 168;
const MAX_LOGIN_FAILURES = 10;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: UserRole;
  allow_server_keys: number;
  active: number;
  created_at: number;
}

const authChangeListeners = new Set<() => void>();

export function subscribeToAuthChanges(listener: () => void): () => void {
  authChangeListeners.add(listener);
  return () => authChangeListeners.delete(listener);
}

function notifyAuthChanged(): void {
  for (const listener of authChangeListeners) listener();
}

const loginFailures = new Map<string, { count: number; resetAt: number }>();

function mapUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    allowServerKeys: Boolean(row.allow_server_keys),
    active: Boolean(row.active),
    createdAt: row.created_at,
  };
}

function sessionTtlMs(): number {
  const raw = Number(process.env.POLYMEET_SESSION_TTL_HOURS);
  const hours =
    Number.isFinite(raw) && raw > 0 ? Math.min(raw, 24 * 365) : DEFAULT_SESSION_TTL_HOURS;
  return Math.round(hours * 3600 * 1000);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function validateUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  return /^[a-z0-9._-]{2,40}$/.test(normalized) ? normalized : null;
}

export function validatePassword(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return raw.length >= 6 && raw.length <= 200 ? raw : null;
}

export function validateDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length >= 1 && trimmed.length <= 60 ? trimmed : null;
}

export function hasAnyUsers(): boolean {
  const row = getDb().prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  return row.count > 0;
}

export function listUsers(): AuthUser[] {
  const rows = getDb()
    .prepare(
      `SELECT id, username, display_name, password_hash, role, allow_server_keys, active, created_at
       FROM users
       ORDER BY created_at ASC`,
    )
    .all() as unknown as UserRow[];
  return rows.map(mapUser);
}

export function getUserById(id: string): AuthUser | undefined {
  const row = getDb()
    .prepare(
      `SELECT id, username, display_name, password_hash, role, allow_server_keys, active, created_at
       FROM users
       WHERE id = ?`,
    )
    .get(id) as UserRow | undefined;
  return row ? mapUser(row) : undefined;
}

interface CreateUserInput {
  username: string;
  displayName: string;
  password: string;
  role?: UserRole;
  allowServerKeys?: boolean;
}

export function createInitialAdmin(
  input: Pick<CreateUserInput, 'username' | 'displayName' | 'password'>,
) {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (hasAnyUsers()) throw new Error('setup_already_completed');
    const user = createUser({ ...input, role: 'admin', allowServerKeys: true });
    db.exec('COMMIT');
    return user;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createUser(input: CreateUserInput): AuthUser {
  const db = getDb();
  const username = validateUsername(input.username);
  const displayName = validateDisplayName(input.displayName);
  const password = validatePassword(input.password);
  const role: UserRole = input.role === 'admin' ? 'admin' : 'user';
  const allowServerKeys = input.allowServerKeys ?? true;

  if (!username) throw new Error('invalid_username');
  if (!displayName) throw new Error('invalid_display_name');
  if (!password) throw new Error('invalid_password');

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) throw new Error('username_taken');

  const user: AuthUser = {
    id: randomUUID(),
    username,
    displayName,
    role,
    allowServerKeys,
    active: true,
    createdAt: Date.now(),
  };

  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role, allow_server_keys, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    user.id,
    user.username,
    user.displayName,
    hashPassword(password),
    user.role,
    user.allowServerKeys ? 1 : 0,
    user.createdAt,
  );

  return user;
}

export function authenticateUser(usernameRaw: string, password: string): AuthUser | null {
  const username = validateUsername(usernameRaw);
  if (!username || typeof password !== 'string' || !password) return null;

  const row = getDb()
    .prepare(
      `SELECT id, username, display_name, password_hash, role, allow_server_keys, active, created_at
       FROM users
       WHERE username = ?`,
    )
    .get(username) as UserRow | undefined;

  if (!row || !row.active) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return mapUser(row);
}

export function updateUser(
  id: string,
  patch: {
    displayName?: string;
    role?: UserRole;
    allowServerKeys?: boolean;
    active?: boolean;
    password?: string;
  },
): AuthUser {
  const db = getDb();
  const current = db
    .prepare(
      `SELECT id, username, display_name, password_hash, role, allow_server_keys, active, created_at
       FROM users
       WHERE id = ?`,
    )
    .get(id) as UserRow | undefined;
  if (!current) throw new Error('user_not_found');

  const nextDisplayName =
    patch.displayName !== undefined ? validateDisplayName(patch.displayName) : current.display_name;
  if (!nextDisplayName) throw new Error('invalid_display_name');

  const nextRole: UserRole =
    patch.role !== undefined ? (patch.role === 'admin' ? 'admin' : 'user') : current.role;
  const nextAllowServerKeys =
    patch.allowServerKeys !== undefined
      ? patch.allowServerKeys
      : Boolean(current.allow_server_keys);
  const nextActive = patch.active !== undefined ? patch.active : Boolean(current.active);

  if (
    current.role === 'admin' &&
    Boolean(current.active) &&
    (nextRole !== 'admin' || !nextActive)
  ) {
    const otherAdmins = db
      .prepare(
        "SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND active = 1 AND id != ?",
      )
      .get(id) as { count: number };
    if (otherAdmins.count === 0) throw new Error('last_admin_protected');
  }

  let nextPasswordHash = current.password_hash;
  let passwordChanged = false;
  if (patch.password !== undefined) {
    const validPassword = validatePassword(patch.password);
    if (!validPassword) throw new Error('invalid_password');
    nextPasswordHash = hashPassword(validPassword);
    passwordChanged = true;
  }

  db.prepare(
    `UPDATE users
     SET display_name = ?, password_hash = ?, role = ?, allow_server_keys = ?, active = ?
     WHERE id = ?`,
  ).run(
    nextDisplayName,
    nextPasswordHash,
    nextRole,
    nextAllowServerKeys ? 1 : 0,
    nextActive ? 1 : 0,
    id,
  );

  if (!nextActive || passwordChanged) {
    deleteUserSessions(id);
  } else if (nextAllowServerKeys !== Boolean(current.allow_server_keys)) {
    notifyAuthChanged();
  }

  return {
    id: current.id,
    username: current.username,
    displayName: nextDisplayName,
    role: nextRole,
    allowServerKeys: nextAllowServerKeys,
    active: nextActive,
    createdAt: current.created_at,
  };
}

export function changeOwnPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): void {
  const db = getDb();
  const row = db.prepare('SELECT id, password_hash, active FROM users WHERE id = ?').get(userId) as
    { id: string; password_hash: string; active: number } | undefined;
  if (!row || !row.active) throw new Error('user_not_found');
  if (!verifyPassword(currentPassword, row.password_hash)) throw new Error('invalid_credentials');
  const validNew = validatePassword(newPassword);
  if (!validNew) throw new Error('invalid_password');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(validNew), userId);
}

export function createSession(userId: string): { token: string; maxAgeSeconds: number } {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const ttlMs = sessionTtlMs();
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(hashToken(token), userId, now, now + ttlMs);
  return { token, maxAgeSeconds: Math.floor(ttlMs / 1000) };
}

export function parseSessionToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const rawValue = part.slice(idx + 1).trim();
    if (!rawValue) return undefined;
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return undefined;
}

export function getSessionUser(cookieHeader: string | undefined): AuthUser | undefined {
  const token = parseSessionToken(cookieHeader);
  if (!token) return undefined;
  const db = getDb();
  const now = Date.now();
  const tokenHash = hashToken(token);
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.password_hash, u.role, u.allow_server_keys, u.active, u.created_at, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(tokenHash) as (UserRow & { expires_at: number }) | undefined;
  if (!row) return undefined;
  if (row.expires_at <= now || !row.active) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return undefined;
  }
  return mapUser(row);
}

export function deleteSessionByCookie(cookieHeader: string | undefined): void {
  const token = parseSessionToken(cookieHeader);
  if (!token) return;
  const result = getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  if (result.changes) notifyAuthChanged();
}

export function deleteUserSessions(userId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  notifyAuthChanged();
}

export function buildSessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

export function buildClearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function checkLoginRateLimit(key: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const entry = loginFailures.get(key);
  if (!entry) return { allowed: true, retryAfterSeconds: 0 };
  if (now >= entry.resetAt) {
    loginFailures.delete(key);
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (entry.count >= MAX_LOGIN_FAILURES) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

const MAX_TRACKED_LOGIN_KEYS = 4096;

export function recordLoginFailure(key: string): void {
  const now = Date.now();
  if (loginFailures.size >= MAX_TRACKED_LOGIN_KEYS && !loginFailures.has(key)) {
    for (const [trackedKey, tracked] of loginFailures) {
      if (now >= tracked.resetAt) loginFailures.delete(trackedKey);
    }
    if (loginFailures.size >= MAX_TRACKED_LOGIN_KEYS) {
      const oldestKey = loginFailures.keys().next().value;
      if (oldestKey !== undefined) loginFailures.delete(oldestKey);
    }
  }
  const entry = loginFailures.get(key);
  if (!entry || now >= entry.resetAt) {
    loginFailures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

export function clearLoginFailures(key: string): void {
  loginFailures.delete(key);
}

export function resetLoginRateLimitsForTesting(): void {
  loginFailures.clear();
}
