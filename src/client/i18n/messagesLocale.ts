import { messages, type MessageKey } from './messages';

export const uiLanguages = [
  { locale: 'zh-Hant', label: '繁體中文' },
  { locale: 'zh-Hans', label: '简体中文' },
  { locale: 'vi', label: 'Tiếng Việt' },
  { locale: 'en', label: 'English' },
] as const;

export type UiLocale = (typeof uiLanguages)[number]['locale'];
export const defaultLocale = 'zh-Hant' satisfies UiLocale;
export const localeStorageKey = 'polymeet.ui-language';

const translationIndex = { 'zh-Hans': 0, vi: 1, en: 2 } as const;

type MessageValue = LocalizedMessage | number | null | undefined;
export type LocalizedMessage = string | { key: MessageKey; values: MessageValue[] };

export type Translator = (key: MessageKey, ...values: MessageValue[]) => string;

export function message(key: MessageKey, ...values: MessageValue[]): LocalizedMessage {
  return { key, values };
}

export function isUiLocale(value: unknown): value is UiLocale {
  return uiLanguages.some(({ locale }) => locale === value);
}

export function translate(locale: UiLocale, key: MessageKey, ...values: MessageValue[]): string {
  const template = locale === defaultLocale ? key : messages[key][translationIndex[locale]];
  return template.replace(/\{(\d+)\}/g, (_, index) => {
    const value = values[Number(index) - 1];
    if (typeof value === 'number') return value.toLocaleString(locale);
    if (typeof value === 'object' && value) return translate(locale, value.key, ...value.values);
    return value ?? '';
  });
}

export function localizeMessage(locale: UiLocale, value: LocalizedMessage): string {
  if (typeof value !== 'string') return translate(locale, value.key, ...value.values);
  return Object.hasOwn(messages, value) ? translate(locale, value as MessageKey) : value;
}

export function readUiLocale(storage: Pick<Storage, 'getItem'>): UiLocale {
  try {
    const saved = storage.getItem(localeStorageKey);
    if (isUiLocale(saved)) return saved;
  } catch {
    // Storage may be disabled.
  }
  return defaultLocale;
}
