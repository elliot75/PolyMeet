import { formatBillingDate, formatDuration, formatMeetingTitle } from '../i18n/format';
import { useI18n } from '../i18n/preferences';
import { useUsageCalendar } from '../services/useUsageCalendar';
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
} from 'react';
import {
  formatConvertedCurrency,
  formatTokens,
  formatUsd,
  operationLabel,
} from '../../shared/pricing';
import type {
  CurrencySettings,
  DailyMeetingUsage,
  KeySource,
  UsageReportResponse,
} from '../../shared/types';
import { downloadCsvFromUrl, fetchMyUsage, myUsageCsvUrl } from '../services/authClient';
import { closeDialogAnimated, isPointerOutsideDialog, openDialogModal } from '../utils/dialog';
import { IconAlertCircle, IconChevronDown, IconDownload, IconRefresh, IconX } from './Icons';

export function UsageDashboardDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale, localize } = useI18n();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const pressedOutside = useRef(false);

  const { from, to, preset, setPreset, setDate, ready, timeZone, calendarError } =
    useUsageCalendar(open);
  const [keySource, setKeySource] = useState<KeySource | 'all'>('all');
  const [search, setSearch] = useState('');
  const [report, setReport] = useState<UsageReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const reportRequest = useRef(0);
  const load = useCallback(async () => {
    if (!ready) return;
    const request = ++reportRequest.current;
    setLoading(true);
    setError('');
    try {
      const data = await fetchMyUsage({ from, to, keySource, search });
      if (request === reportRequest.current) setReport(data);
    } catch (err) {
      if (request === reportRequest.current)
        setError(err instanceof Error ? err.message : '無法讀取用量紀錄。');
    } finally {
      if (request === reportRequest.current) setLoading(false);
    }
  }, [from, to, keySource, search, ready]);

  useEffect(() => {
    if (open) {
      openDialogModal(dialog.current);
      void load();
    } else if (dialog.current?.open) {
      void closeDialogAnimated(dialog.current);
    }
    return () => {
      reportRequest.current += 1;
    };
  }, [open, load]);

  function toggleExpand(key: string) {
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const currency: CurrencySettings = useMemo(
    () => ({
      currencyCode: report?.currencyCode || '',
      exchangeRate: report?.exchangeRate || 0,
    }),
    [report?.currencyCode, report?.exchangeRate],
  );

  const days = useMemo(() => {
    const groups = new Map<
      string,
      {
        usageDate: string;
        meetings: DailyMeetingUsage[];
        durationSeconds: number;
        totalTokens: number;
        costUsd: number;
      }
    >();
    for (const meeting of report?.dailyMeetings ?? []) {
      let group = groups.get(meeting.usageDate);
      if (!group) {
        group = {
          usageDate: meeting.usageDate,
          meetings: [],
          durationSeconds: 0,
          totalTokens: 0,
          costUsd: 0,
        };
        groups.set(meeting.usageDate, group);
      }
      group.meetings.push(meeting);
      group.durationSeconds += meeting.durationSeconds;
      group.totalTokens += meeting.totalTokens;
      group.costUsd += meeting.costUsd;
    }
    return [...groups.values()];
  }, [report?.dailyMeetings]);

  const grandConverted = report
    ? formatConvertedCurrency(report.totals.costUsd, currency, locale)
    : null;

  return (
    <dialog
      ref={dialog}
      className="usage-dialog wide-dialog"
      aria-labelledby={titleId}
      {...({ closedby: 'any' } as HTMLAttributes<HTMLDialogElement>)}
      onCancel={(event) => {
        event.preventDefault();
        void closeDialogAnimated(dialog.current);
      }}
      onPointerDown={(event) => {
        if (!('closedBy' in HTMLDialogElement.prototype) && dialog.current) {
          pressedOutside.current = isPointerOutsideDialog(event, dialog.current);
        }
      }}
      onPointerUp={(event) => {
        if (
          !('closedBy' in HTMLDialogElement.prototype) &&
          pressedOutside.current &&
          dialog.current &&
          isPointerOutsideDialog(event, dialog.current)
        ) {
          void closeDialogAnimated(dialog.current);
        }
        pressedOutside.current = false;
      }}
      onClose={onClose}
    >
      <div className="dialog-header">
        <div>
          <div className="eyebrow">{t('個人費用紀錄')}</div>
          <h2 id={titleId}>{t('個人每日與會議費用統計')}</h2>
        </div>
        <button
          type="button"
          className="close"
          aria-label={t('關閉個人費用統計')}
          onClick={() => void closeDialogAnimated(dialog.current)}
        >
          <IconX size={18} />
        </button>
      </div>

      <div className="filter-bar">
        {timeZone && <p className="hint">{t('帳務時區 {1}', timeZone)}</p>}
        {calendarError && (
          <p className="error" role="alert">
            {localize(calendarError)}
          </p>
        )}
        <div className="preset-pills" role="group" aria-label={t('日期範圍')}>
          {(
            [
              ['today', t('今日')],
              ['week', t('本週')],
              ['month', t('本月')],
              ['last_month', t('上月')],
              ['all', t('全部')],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={preset === id ? 'active' : ''}
              onClick={() => setPreset(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="filter-inputs">
          <label>
            <span>{t('起始日期')}</span>
            <input type="date" value={from} onChange={(e) => setDate('from', e.target.value)} />
          </label>
          <label>
            <span>{t('結束日期')}</span>
            <input type="date" value={to} onChange={(e) => setDate('to', e.target.value)} />
          </label>
          <label>
            <span>{t('金鑰來源')}</span>
            <select
              value={keySource}
              onChange={(e) => setKeySource(e.target.value as KeySource | 'all')}
            >
              <option value="all">{t('全部來源')}</option>
              <option value="server_env">{t('系統 .env 金鑰')}</option>
              <option value="byok">{t('個人 BYOK 金鑰')}</option>
            </select>
          </label>
          <label>
            <span>{t('搜尋會議或模型')}</span>
            <input
              type="search"
              placeholder={t('會議名稱或模型 ID…')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <div className="filter-actions">
            <button
              type="button"
              className="secondary small-button"
              disabled={!ready || loading}
              onClick={() => void load()}
            >
              <IconRefresh size={14} />
              <span>{t('重新整理')}</span>
            </button>
            <button
              type="button"
              className="secondary small-button"
              disabled={!ready || loading || !report?.dailyMeetings.length}
              onClick={() =>
                void downloadCsvFromUrl(
                  myUsageCsvUrl({ from, to, keySource, search }),
                  'polymeet-my-usage.csv',
                ).catch((err) => setError(err instanceof Error ? err.message : '匯出失敗'))
              }
            >
              <IconDownload size={14} />
              <span>{t('匯出 CSV')}</span>
            </button>
          </div>
        </div>
      </div>

      {error && (
        <p className="error" role="alert">
          <IconAlertCircle size={15} />
          <span>{localize(error)}</span>
        </p>
      )}

      {report && (
        <>
          <div className="usage-kpis">
            <div className="usage-kpi highlight">
              <span>{t('期間已計價費用')}</span>
              <strong>{formatUsd(report.totals.costUsd)}</strong>
              {grandConverted && <small>{grandConverted}</small>}
              {report.totals.pendingCalls > 0 && (
                <small className="warn-note">
                  {t('{1} 筆待核對，費用小計尚未包含', report.totals.pendingCalls)}
                </small>
              )}
            </div>
            <div className="usage-kpi">
              <span>{t('累計使用時間')}</span>
              <strong>{formatDuration(t, report.totals.durationSeconds)}</strong>
            </div>
            <div className="usage-kpi">
              <span>{t('總 Token 數')}</span>
              <strong>{formatTokens(report.totals.totalTokens, locale)}</strong>
            </div>
            <div className="usage-kpi">
              <span>{t('會議場次')}</span>
              <strong>{t('{1} 場', report.totals.meetingCount)}</strong>
            </div>
          </div>

          {days.length > 0 ? (
            <div className="day-groups">
              {days.map((day) => {
                const dayConverted = formatConvertedCurrency(day.costUsd, currency, locale);
                return (
                  <section key={day.usageDate} className="day-group">
                    <header className="day-group-head">
                      <div>
                        <strong>{formatBillingDate(day.usageDate, locale)}</strong>
                        <span>
                          {t('{1} 場會議', day.meetings.length)} ·{' '}
                          {formatDuration(t, day.durationSeconds)} ·{' '}
                          {t('{1} Token', day.totalTokens)}
                        </span>
                      </div>
                      <div className="day-subtotal">
                        <small>{t('當日小計')}</small>
                        <strong>{formatUsd(day.costUsd)}</strong>
                        {dayConverted && <em>{dayConverted}</em>}
                      </div>
                    </header>

                    <div className="table-scroll">
                      <table className="usage-table">
                        <thead>
                          <tr>
                            <th>{t('會議')}</th>
                            <th>{t('金鑰')}</th>
                            <th>{t('使用時間')}</th>
                            <th className="num">{t('總 Token')}</th>
                            <th className="num">{t('會議小計')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {day.meetings.map((meeting) => {
                            const rowKey = `${day.usageDate}::${meeting.meetingId}`;
                            const isOpen = expanded.has(rowKey);
                            const meetingConverted = formatConvertedCurrency(
                              meeting.costUsd,
                              currency,
                            );
                            return (
                              <Fragment key={rowKey}>
                                <tr className="expandable-row">
                                  <td>
                                    <button
                                      type="button"
                                      className="expand-toggle"
                                      disabled={!meeting.models.length}
                                      aria-expanded={isOpen}
                                      onClick={() => toggleExpand(rowKey)}
                                    >
                                      <IconChevronDown
                                        size={14}
                                        className={isOpen ? 'rotated' : ''}
                                      />
                                      <span>{formatMeetingTitle(t, meeting.meetingTitle)}</span>
                                    </button>
                                  </td>
                                  <td>
                                    <div className="key-pill-group">
                                      {!meeting.keySources.length && <span>{t('本機錄音')}</span>}
                                      {meeting.keySources.map((src) => (
                                        <span
                                          key={src}
                                          className={`key-source-pill ${src === 'server_env' ? 'env' : 'byok'}`}
                                        >
                                          {src === 'server_env' ? '.env' : 'BYOK'}
                                        </span>
                                      ))}
                                    </div>
                                  </td>
                                  <td>{formatDuration(t, meeting.durationSeconds)}</td>
                                  <td className="num">
                                    {formatTokens(meeting.totalTokens, locale)}
                                  </td>
                                  <td className="num">
                                    <strong>{formatUsd(meeting.costUsd)}</strong>
                                    {meetingConverted && (
                                      <small className="token-sub">{meetingConverted}</small>
                                    )}
                                  </td>
                                </tr>
                                {isOpen && meeting.models.length > 0 && (
                                  <tr className="detail-row">
                                    <td colSpan={5}>
                                      <div className="nested-models">
                                        <table className="usage-table nested">
                                          <thead>
                                            <tr>
                                              <th>{t('功能')}</th>
                                              <th>{t('模型')}</th>
                                              <th>{t('金鑰')}</th>
                                              <th>{t('時長 / 音訊')}</th>
                                              <th className="num">{t('輸入 Token')}</th>
                                              <th className="num">{t('輸出 Token')}</th>
                                              <th className="num">{t('總 Token')}</th>
                                              <th className="num">{t('費用')}</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {meeting.models.map((m) => {
                                              const rowIn = m.textInputTokens + m.audioInputTokens;
                                              return (
                                                <tr
                                                  key={`${m.operation}:${m.provider}:${m.model}:${m.keySource}`}
                                                >
                                                  <td>{localize(operationLabel(m.operation))}</td>
                                                  <td>
                                                    <code>{m.model}</code>{' '}
                                                    <small>{t('({1} 次)', m.calls)}</small>
                                                  </td>
                                                  <td>
                                                    {m.keySource === 'server_env' ? '.env' : 'BYOK'}
                                                  </td>
                                                  <td>
                                                    {m.audioSeconds > 0
                                                      ? formatDuration(t, m.audioSeconds)
                                                      : formatDuration(t, m.durationSeconds)}
                                                  </td>
                                                  <td className="num">
                                                    {formatTokens(rowIn, locale)}
                                                  </td>
                                                  <td className="num">
                                                    {formatTokens(m.outputTokens, locale)}
                                                  </td>
                                                  <td className="num">
                                                    {formatTokens(m.totalTokens, locale)}
                                                  </td>
                                                  <td className="num">
                                                    {m.pendingCalls === m.calls
                                                      ? t('待確認')
                                                      : formatUsd(m.costUsd)}
                                                    {m.pricingMissing && (
                                                      <small className="warn-note">
                                                        {t('未設定費率')}
                                                      </small>
                                                    )}
                                                    {m.pendingCalls > 0 && (
                                                      <small className="warn-note">
                                                        {t('{1} 筆待核對', m.pendingCalls)}
                                                      </small>
                                                    )}
                                                  </td>
                                                </tr>
                                              );
                                            })}
                                          </tbody>
                                        </table>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <p className="hint usage-empty-note">
              {loading ? t('載入中…') : t('此篩選條件下尚無使用紀錄。')}
            </p>
          )}
        </>
      )}

      <div className="dialog-actions">
        <button
          type="button"
          className="record"
          onClick={() => void closeDialogAnimated(dialog.current)}
        >
          {t('關閉')}
        </button>
      </div>
    </dialog>
  );
}
