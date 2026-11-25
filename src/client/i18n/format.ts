import { usageDurationParts } from '../../shared/pricing';
import type { Translator, UiLocale } from './messagesLocale';

export function formatDuration(t: Translator, seconds: number): string {
  const { hours, minutes, remainder } = usageDurationParts(seconds);
  const paddedSeconds = String(remainder).padStart(2, '0');
  if (hours > 0)
    return t('{1} 小時 {2} 分 {3} 秒', hours, String(minutes).padStart(2, '0'), paddedSeconds);
  if (minutes > 0) return t('{1} 分 {2} 秒', minutes, paddedSeconds);
  return t('{1} 秒', remainder);
}

// Billing days come from the server and represent calendar dates in its billing time zone.
export function formatBillingDate(date: string, locale: UiLocale): string {
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return date;
  return day.toLocaleDateString(locale, { dateStyle: 'medium', timeZone: 'UTC' });
}

export function formatMeetingTitle(t: Translator, title: string): string {
  return !title || title === '未命名會議' ? t('未命名會議') : title;
}

export function formatSpeakerLabel(t: Translator, label: string): string {
  if (label === '我方' || label === '對方' || label === '音檔') return t(label);
  const part = /^(.+)（第 (\d+) 部分）$/.exec(label);
  return part ? t('{1}（第 {2} 部分）', part[1], part[2]) : label;
}
