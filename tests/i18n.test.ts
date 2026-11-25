import { describe, expect, it } from 'vitest';
import { formatBillingDate, formatDuration, formatMeetingTitle } from '../src/client/i18n/format';
import { messages } from '../src/client/i18n/messages';
import {
  localizeMessage,
  message,
  readUiLocale,
  translate,
  uiLanguages,
} from '../src/client/i18n/messagesLocale';

describe('interface language', () => {
  it('restores each supported language and falls back when storage cannot be read', () => {
    for (const { locale } of uiLanguages) {
      expect(readUiLocale({ getItem: () => locale })).toBe(locale);
    }
    expect(readUiLocale({ getItem: () => 'unsupported' })).toBe('zh-Hant');
    expect(
      readUiLocale({
        getItem: () => {
          throw new Error('Storage disabled');
        },
      }),
    ).toBe('zh-Hant');
  });

  it('supplies every translation and preserves each interpolation slot', () => {
    const slots = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort();
    for (const [key, translations] of Object.entries(messages)) {
      expect(translations, key).toHaveLength(uiLanguages.length - 1);
      for (const translation of translations) {
        expect(translation.trim(), key).not.toBe('');
        expect(slots(translation), key).toEqual(slots(key));
      }
    }
  });

  it('retranslates existing feedback and preserves inserted account names', () => {
    const result = message('已建立帳號 @{1}。', 'al{1}ice');
    expect(localizeMessage('en', result)).toBe('Created account @al{1}ice.');
    expect(localizeMessage('vi', result)).toBe('Đã tạo tài khoản @al{1}ice.');
    expect(localizeMessage('zh-Hans', '帳號或密碼錯誤。')).toBe('账号或密码错误。');
    expect(localizeMessage('en', 'Provider detail')).toBe('Provider detail');
  });

  it('localizes duration, placeholders, and dates without changing the billing day', () => {
    const t = translate.bind(null, 'en');
    expect(formatDuration(t, 3665)).toBe('1h 01m 05s');
    expect(formatMeetingTitle(t, '')).toBe('Untitled meeting');
    expect(formatMeetingTitle(t, '週會')).toBe('週會');
    expect(formatBillingDate('2026-11-25', 'en')).toBe('Nov 25, 2026');
  });
});
