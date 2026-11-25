import { formatMeetingTitle } from '../i18n/format';
import { useI18n } from '../i18n/preferences';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { keySourceLabel, operationLabel } from '../../shared/pricing';
import type { UnsettledUsage, UsageResolution } from '../../shared/types';
import {
  adminFetchUnsettledUsage,
  adminResolveUsage,
  adminUnsettledUsageCsvUrl,
  downloadCsvFromUrl,
  type UsageQueryFilters,
} from '../services/authClient';

const tokenFields = [
  ['textInputTokens', '文字輸入 Token'],
  ['audioInputTokens', '音訊輸入 Token'],
  ['cachedInputTokens', '其中快取 Token'],
  ['outputTokens', '輸出 Token'],
] as const;

export function UsageReconciliation({
  filters,
  timeZone,
  onResolved,
}: {
  filters: UsageQueryFilters;
  timeZone: string;
  onResolved: () => void;
}) {
  const { t, locale, localize } = useI18n();
  const formId = useId();
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [entries, setEntries] = useState<UnsettledUsage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<UnsettledUsage>();
  const [loading, setLoading] = useState(false);
  const [replaceTokens, setReplaceTokens] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void adminFetchUnsettledUsage(filters, page * 50, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        if (page > 0 && !result.entries.length) setPage(page - 1);
        setEntries(result.entries);
        setHasMore(result.hasMore);
        setLoading(false);
      },
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : '無法讀取待核對明細。');
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [expanded, filters, page, revision]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || saving) return;
    const data = new FormData(event.currentTarget);
    const resolution: UsageResolution = {
      costUsd: Number(data.get('costUsd')),
      note: String(data.get('note') ?? ''),
    };
    if (data.get('replaceTokens')) {
      resolution.tokens = {
        textInputTokens: Number(data.get('textInputTokens')),
        audioInputTokens: Number(data.get('audioInputTokens')),
        cachedInputTokens: Number(data.get('cachedInputTokens')),
        outputTokens: Number(data.get('outputTokens')),
      };
    }
    setSaving(true);
    setError('');
    try {
      await adminResolveUsage(selected.id, resolution);
      setSelected(undefined);
      setRevision((current) => current + 1);
      onResolved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '無法儲存核對結果。');
    } finally {
      setSaving(false);
    }
  }

  const timestamp = new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'medium',
  });

  return (
    <details
      className="admin-section usage-reconciliation"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>{t('逐筆核對待計價用量')}</summary>
      {error && (
        <p className="error" role="alert">
          {localize(error)}
        </p>
      )}
      {loading && (
        <p className="hint" role="status">
          {t('正在讀取明細…')}
        </p>
      )}
      {!loading && !entries.length && !error && expanded && (
        <p className="hint">{t('沒有符合篩選條件的待核對用量。')}</p>
      )}
      {!loading && entries.length > 0 && (
        <button
          type="button"
          className="secondary small-button"
          onClick={() =>
            void downloadCsvFromUrl(
              adminUnsettledUsageCsvUrl(filters),
              'polymeet-unsettled-usage.csv',
            ).catch((failure: unknown) =>
              setError(failure instanceof Error ? failure.message : '匯出失敗。'),
            )
          }
        >
          {t('匯出待核對 CSV')}
        </button>
      )}
      {!loading && entries.length > 0 && (
        <ul className="reconciliation-entries">
          {entries.map((entry) => (
            <li key={entry.id}>
              <div>
                <strong>{formatMeetingTitle(t, entry.meetingTitle)}</strong> · @{entry.username}
                <div>
                  {timestamp.format(entry.startedAt)} · {localize(operationLabel(entry.operation))}{' '}
                  · {localize(keySourceLabel(entry.keySource))}
                </div>
                <div>
                  {entry.provider} · <code>{entry.model}</code>
                </div>
                <small className="warn-note">
                  {entry.pricingMissing && entry.pendingReconciliation
                    ? t('未設定費率、缺少供應商用量')
                    : entry.pricingMissing
                      ? t('未設定費率')
                      : t('缺少供應商用量')}
                </small>
              </div>
              <button
                type="button"
                className="secondary small-button"
                disabled={saving}
                aria-pressed={selected?.id === entry.id}
                onClick={() => {
                  setError('');
                  setReplaceTokens(false);
                  setSelected(entry);
                }}
              >
                {t('核對此筆')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!loading && (page > 0 || hasMore) && (
        <div className="filter-actions">
          <button
            type="button"
            className="secondary small-button"
            disabled={saving || !page}
            onClick={() => {
              setSelected(undefined);
              setPage(page - 1);
            }}
          >
            {t('上一頁')}
          </button>
          <button
            type="button"
            className="secondary small-button"
            disabled={saving || !hasMore}
            onClick={() => {
              setSelected(undefined);
              setPage(page + 1);
            }}
          >
            {t('下一頁')}
          </button>
        </div>
      )}
      {selected && (
        <form
          key={selected.id}
          aria-labelledby={formId}
          className="admin-create-form reconciliation-form"
          onSubmit={(event) => void submit(event)}
        >
          <h3 id={formId}>{t('核對 {1} 的用量', formatMeetingTitle(t, selected.meetingTitle))}</h3>
          <p className="hint">
            {t('PolyMeet 用量 ID')}
            <code>{selected.id}</code>
          </p>
          {selected.providerReference && (
            <p className="hint">
              {t('供應商參照')}
              <code>{selected.providerReference}</code>
            </p>
          )}
          <div className="admin-form-grid">
            <label htmlFor={`${formId}-cost`}>
              <span>{t('實際費用（USD，必填）')}</span>
              <input
                id={`${formId}-cost`}
                name="costUsd"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                required
                disabled={saving}
              />
            </label>
            <label htmlFor={`${formId}-note`}>
              <span>{t('核對依據（必填）')}</span>
              <input
                id={`${formId}-note`}
                name="note"
                maxLength={1000}
                required
                disabled={saving}
              />
            </label>
          </div>
          <label className="archive-audio" htmlFor={`${formId}-replace`}>
            <input
              id={`${formId}-replace`}
              name="replaceTokens"
              type="checkbox"
              checked={replaceTokens}
              onChange={(event) => setReplaceTokens(event.target.checked)}
              disabled={saving}
            />
            {t('更新已確認的 Token 數')}
          </label>
          {replaceTokens && (
            <div className="admin-form-grid">
              {tokenFields.map(([field, label]) => (
                <label key={field} htmlFor={`${formId}-${field}`}>
                  <span>{t(label)}</span>
                  <input
                    id={`${formId}-${field}`}
                    name={field}
                    type="number"
                    inputMode="numeric"
                    min="0"
                    step="1"
                    defaultValue={selected[field]}
                    required
                    disabled={saving}
                  />
                </label>
              ))}
            </div>
          )}
          <div className="filter-actions">
            <button type="submit" className="record" disabled={saving}>
              {saving ? t('儲存中…') : t('確認入帳')}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={saving}
              onClick={() => setSelected(undefined)}
            >
              {t('取消')}
            </button>
          </div>
        </form>
      )}
    </details>
  );
}
