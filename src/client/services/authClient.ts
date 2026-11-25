import { workspaceFetch } from './workspaceSession';
import type {
  AuthUser,
  CurrencySettings,
  KeySource,
  ModelPricing,
  ProviderId,
  UsageReportResponse,
  UsageSessionKind,
  UsageSessionSummary,
  UsageTimeInterval,
  UsageCalendar,
  UnsettledUsage,
  UsageResolution,
  UserRole,
} from '../../shared/types';

export interface AuthState {
  authenticated: boolean;
  needsSetup: boolean;
  setupAvailable: boolean;
  user: AuthUser | null;
  serverKeys?: { openai: boolean; gemini: boolean };
}

const ERROR_MESSAGES: Record<string, string> = {
  unauthenticated: '請先登入帳號。',
  forbidden: '您沒有權限執行此操作。',
  setup_not_authorized: '初始化代碼無效，請向部署管理員確認。',
  account_changed: '登入帳號已變更，請重新開啟工作區。',
  setup_required: '系統尚未建立管理員帳號，請先完成初始設定。',
  setup_already_completed: '系統已完成初始化，請直接登入。',
  invalid_credentials: '帳號或密碼錯誤。',
  too_many_attempts: '登入失敗次數過多，請稍後再試。',
  username_taken: '此帳號名稱已被使用。',
  invalid_username: '帳號需為 2–40 個字元（僅限小寫英數字、.、_、-）。',
  invalid_password: '密碼長度需至少 6 個字元。',
  invalid_display_name: '請輸入 1–60 個字元的顯示名稱。',
  user_not_found: '找不到該帳號。',
  last_admin_protected: '系統必須至少保留一位啟用中的管理員。',
  usage_already_resolved: '這筆用量已完成計價，請重新載入報表。',
  invalid_resolution: '請輸入有效的費用、用量及核對依據。',
  invalid_pricing: '費率數值不可為負數或無效數字。',
  invalid_currency: '幣別代碼需為 2–10 碼英數字（如 TWD、JPY），留空表示僅顯示美金。',
  invalid_exchange_rate: '匯率必須為大於或等於 0 的數字。',
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const request = ['/api/auth/me', '/api/auth/login', '/api/auth/setup'].includes(url)
    ? fetch
    : workspaceFetch;
  const response = await request(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof body?.error === 'string' ? body.error : '';
    const message =
      ERROR_MESSAGES[code] ||
      (response.status === 401
        ? '請先登入帳號。'
        : response.status === 403
          ? '權限不足或來源不受允許。'
          : '請求失敗，請稍後再試。');
    throw new Error(message);
  }
  return body as T;
}

export function fetchAuthMe(): Promise<AuthState> {
  return requestJson<AuthState>('/api/auth/me');
}

export function setupInitialAdmin(payload: {
  setupToken: string;
  username: string;
  displayName: string;
  password: string;
}): Promise<{ user: AuthUser }> {
  return requestJson<{ user: AuthUser }>('/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function loginUser(payload: {
  username: string;
  password: string;
}): Promise<{ user: AuthUser }> {
  return requestJson<{ user: AuthUser }>('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function logoutUser(): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
}

export function changeOwnPassword(payload: {
  currentPassword: string;
  newPassword: string;
}): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>('/api/auth/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function completeUsageSession(payload: {
  usageSessionId: string;
  meetingId: string;
  meetingTitle: string;
  kind: UsageSessionKind;
  startedAt: number;
  endedAt: number;
  durationSeconds: number;
  activeIntervals?: UsageTimeInterval[];
}): Promise<{ summary: UsageSessionSummary }> {
  return requestJson<{ summary: UsageSessionSummary }>('/api/usage/sessions/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function fetchMeetingUsage(meetingId: string): Promise<{ summary: UsageSessionSummary }> {
  return requestJson<{ summary: UsageSessionSummary }>(
    `/api/usage/meetings/${encodeURIComponent(meetingId)}`,
  );
}

export function renameMeetingUsage(
  meetingId: string,
  meetingTitle: string,
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/usage/meetings/${encodeURIComponent(meetingId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetingTitle }),
  });
}

export interface UsageQueryFilters {
  userId?: string;
  keySource?: KeySource | 'all';
  from?: string;
  to?: string;
  search?: string;
}

function buildUsageParams(filters: UsageQueryFilters, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  if (filters.userId) params.set('userId', filters.userId);
  if (filters.keySource) params.set('keySource', filters.keySource);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.search?.trim()) params.set('search', filters.search.trim());
  if (extra) {
    for (const [key, value] of Object.entries(extra)) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function fetchUsageCalendar(signal?: AbortSignal): Promise<UsageCalendar> {
  return requestJson<UsageCalendar>('/api/usage/calendar', { signal });
}

export function adminFetchUnsettledUsage(
  filters: UsageQueryFilters,
  offset: number,
  signal?: AbortSignal,
) {
  return requestJson<{ entries: UnsettledUsage[]; hasMore: boolean }>(
    `/api/admin/usage/pending${buildUsageParams(filters, { offset: String(offset) })}`,
    { signal },
  );
}

export function adminUnsettledUsageCsvUrl(filters: UsageQueryFilters) {
  return `/api/admin/usage/pending${buildUsageParams(filters, { format: 'csv' })}`;
}

export function adminResolveUsage(id: string, resolution: UsageResolution) {
  return requestJson<{ ok: true }>(`/api/admin/usage/pending/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(resolution),
  });
}

export function fetchMyUsage(filters: UsageQueryFilters = {}): Promise<UsageReportResponse> {
  return requestJson<UsageReportResponse>(`/api/usage/my${buildUsageParams(filters)}`);
}

export function myUsageCsvUrl(filters: UsageQueryFilters = {}): string {
  return `/api/usage/my${buildUsageParams(filters, { format: 'csv' })}`;
}

export function fetchPricing(): Promise<{ pricing: ModelPricing[]; currency: CurrencySettings }> {
  return requestJson<{ pricing: ModelPricing[]; currency: CurrencySettings }>('/api/pricing');
}

export function adminListUsers(): Promise<{ users: AuthUser[] }> {
  return requestJson<{ users: AuthUser[] }>('/api/admin/users');
}

export function adminCreateUser(payload: {
  username: string;
  displayName: string;
  password: string;
  role: UserRole;
  allowServerKeys: boolean;
}): Promise<{ user: AuthUser }> {
  return requestJson<{ user: AuthUser }>('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function adminUpdateUser(
  id: string,
  patch: {
    displayName?: string;
    role?: UserRole;
    allowServerKeys?: boolean;
    active?: boolean;
    password?: string;
  },
): Promise<{ user: AuthUser }> {
  return requestJson<{ user: AuthUser }>(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function adminFetchUsage(filters: UsageQueryFilters = {}): Promise<UsageReportResponse> {
  return requestJson<UsageReportResponse>(`/api/admin/usage${buildUsageParams(filters)}`);
}

export function adminUsageCsvUrl(
  filters: UsageQueryFilters = {},
  csvMode: 'detail' | 'account' = 'detail',
): string {
  return `/api/admin/usage${buildUsageParams(filters, { format: 'csv', csvMode })}`;
}

export function adminFetchPricing(): Promise<{
  pricing: ModelPricing[];
  currency: CurrencySettings;
}> {
  return requestJson<{ pricing: ModelPricing[]; currency: CurrencySettings }>('/api/admin/pricing');
}

export function adminUpsertPricing(
  entry: Omit<ModelPricing, 'updatedAt'>,
): Promise<{ pricing: ModelPricing; settledCount?: number }> {
  return requestJson<{ pricing: ModelPricing; settledCount?: number }>('/api/admin/pricing', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  });
}

export function adminDeletePricing(provider: ProviderId, model: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `/api/admin/pricing?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`,
    { method: 'DELETE' },
  );
}

export function adminSetCurrency(
  payload: CurrencySettings,
): Promise<{ currency: CurrencySettings }> {
  return requestJson<{ currency: CurrencySettings }>('/api/admin/currency', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function downloadCsvFromUrl(url: string, fallbackFilename: string): Promise<void> {
  const response = await workspaceFetch(url);
  if (!response.ok) {
    throw new Error('匯出 CSV 失敗，請確認權限及連線狀態。');
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fallbackFilename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
