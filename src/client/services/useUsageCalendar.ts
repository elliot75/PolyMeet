import { useEffect, useState } from 'react';
import type { UsageCalendar, UsageDatePreset } from '../../shared/types';
import { fetchUsageCalendar } from './authClient';

export function useUsageCalendar(open: boolean) {
  const [calendar, setCalendar] = useState<UsageCalendar>();
  const [preset, setPreset] = useState<UsageDatePreset | null>('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) {
      setCalendar(undefined);
      setError('');
      return;
    }
    let timer: number | undefined;
    let request: AbortController | undefined;
    const refresh = async () => {
      request?.abort();
      window.clearTimeout(timer);
      const controller = new AbortController();
      request = controller;
      try {
        const data = await fetchUsageCalendar(controller.signal);
        if (!controller.signal.aborted) {
          setCalendar(data);
          setError('');
          timer = window.setTimeout(refresh, Math.max(1000, data.refreshInMs + 100));
        }
      } catch {
        if (!controller.signal.aborted) {
          setCalendar(undefined);
          setError('無法讀取伺服器的帳務日期。');
          timer = window.setTimeout(refresh, 60_000);
        }
      }
    };
    void refresh();
    window.addEventListener('focus', refresh);
    return () => {
      request?.abort();
      window.clearTimeout(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [open]);

  const range = preset ? (calendar?.ranges[preset] ?? { from: '', to: '' }) : custom;
  return {
    ...range,
    preset,
    setPreset,
    ready: preset === null || Boolean(calendar),
    timeZone: calendar?.timeZone,
    calendarError: error,
    setDate: (key: 'from' | 'to', value: string) => {
      setCustom({ ...range, [key]: value });
      setPreset(null);
    },
  };
}
