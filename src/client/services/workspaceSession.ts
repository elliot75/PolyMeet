import { WORKSPACE_ACCOUNT_HEADER, WORKSPACE_SESSION_HEADER } from '../../shared/protocol';

export const WORKSPACE_SESSION_CHANGED = 'polymeet-session-changed';
let accountId: string | undefined;

// Pin credentials expectations to the document so old async jobs never pick up a new identity.
export function bindWorkspaceAccount(nextAccountId: string): boolean {
  accountId ??= nextAccountId;
  return accountId === nextAccountId;
}

export function workspaceAccountId(): string | undefined {
  return accountId;
}

export function announceSessionChange() {
  try {
    localStorage.setItem(WORKSPACE_SESSION_CHANGED, crypto.randomUUID());
  } catch {
    // Focus and pageshow checks also revalidate the session when storage is unavailable.
  }
}

export async function workspaceFetch(input: string, init?: RequestInit): Promise<Response> {
  if (!accountId) return fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set(WORKSPACE_ACCOUNT_HEADER, accountId);
  const response = await fetch(input, { ...init, headers });
  if (response.headers.get(WORKSPACE_SESSION_HEADER)) {
    window.dispatchEvent(new Event(WORKSPACE_SESSION_CHANGED));
  }
  return response;
}
