export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'color-scheme';

function syncMetaColorScheme(preference: ThemePreference) {
  if (typeof document === 'undefined') return;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) {
    meta.setAttribute('content', preference === 'system' ? 'light dark' : preference);
  }
}

export function getThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function applyThemePreference(preference: ThemePreference) {
  syncMetaColorScheme(preference);
  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    /* Ignore storage errors when site data is restricted. */
  }
}

export function getSystemColorScheme(): 'light' | 'dark' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function subscribeThemeStorage(onChange: (preference: ThemePreference) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    const next = getThemePreference();
    syncMetaColorScheme(next);
    onChange(next);
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
