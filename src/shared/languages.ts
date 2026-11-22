export const languages = [
  { label: '繁體中文', code: 'zh-TW' },
  { label: '简体中文', code: 'zh-CN' },
  { label: 'English', code: 'en-US' },
  { label: '日本語', code: 'ja-JP' },
  { label: '한국어', code: 'ko-KR' },
  { label: 'Tiếng Việt', code: 'vi-VN' },
  { label: 'ไทย', code: 'th-TH' },
  { label: 'Français', code: 'fr-FR' },
  { label: 'Deutsch', code: 'de-DE' },
  { label: 'Español', code: 'es-ES' },
] as const;
export function languageCode(label: string): string | undefined {
  return languages.find((language) => language.label === label)?.code;
}
