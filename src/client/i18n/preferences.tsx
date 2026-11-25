import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  defaultLocale,
  isUiLocale,
  localeStorageKey,
  localizeMessage,
  readUiLocale,
  translate,
  uiLanguages,
  type Translator,
  type LocalizedMessage,
  type UiLocale,
} from './messagesLocale';

export { message, type LocalizedMessage } from './messagesLocale';

type Preferences = {
  locale: UiLocale;
  setLocale: (locale: UiLocale) => void;
  t: Translator;
  localize: (message: LocalizedMessage) => string;
};

function preferenceFor(locale: UiLocale, setLocale: Preferences['setLocale']): Preferences {
  return {
    locale,
    setLocale,
    t: (key, ...values) => translate(locale, key, ...values),
    localize: (message) => localizeMessage(locale, message),
  };
}

const I18nContext = createContext(preferenceFor(defaultLocale, () => {}));

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState(() =>
    readUiLocale({
      getItem: (key) => window.localStorage.getItem(key),
    }),
  );

  const preferences = useMemo(
    () =>
      preferenceFor(locale, (next) => {
        setLocale(next);
        try {
          window.localStorage.setItem(localeStorageKey, next);
        } catch {
          // The selected locale still applies to the open page.
        }
      }),
    [locale],
  );

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = preferences.t('PolyMeet — 讓每場對話都有跡可循');
  }, [preferences, locale]);

  return <I18nContext value={preferences}>{children}</I18nContext>;
}

export function useI18n() {
  return useContext(I18nContext);
}

export function LanguageSelect() {
  const { locale, setLocale, t } = useI18n();
  const id = useId();
  return (
    <div className="interface-language">
      <label htmlFor={id}>{t('介面語言')}</label>
      <select
        id={id}
        value={locale}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (isUiLocale(next)) setLocale(next);
        }}
      >
        {uiLanguages.map(({ locale, label }) => (
          <option key={locale} value={locale} lang={locale}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}
