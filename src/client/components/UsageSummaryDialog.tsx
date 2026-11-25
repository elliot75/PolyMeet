import { formatBillingDate, formatDuration, formatMeetingTitle } from '../i18n/format';
import { useI18n } from '../i18n/preferences';
import { useEffect, useId, useRef, type HTMLAttributes } from 'react';
import {
  formatConvertedCurrency,
  formatTokens,
  formatUsd,
  keySourceLabel,
  operationLabel,
} from '../../shared/pricing';
import type { CurrencySettings, UsageSessionSummary } from '../../shared/types';
import { closeDialogAnimated, isPointerOutsideDialog, openDialogModal } from '../utils/dialog';
import { IconBarChart, IconX } from './Icons';

export function UsageSummaryDialog({
  summary,
  mode,
  currency,
  onClose,
  onOpenDashboard,
}: {
  summary: UsageSessionSummary | null;
  mode: 'session' | 'meeting';
  currency: CurrencySettings;
  onClose: () => void;
  onOpenDashboard: () => void;
}) {
  const { t, locale, localize } = useI18n();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const pressedOutside = useRef(false);

  useEffect(() => {
    if (summary) {
      openDialogModal(dialog.current);
    } else if (dialog.current?.open) {
      void closeDialogAnimated(dialog.current);
    }
  }, [summary]);

  const totalInput = summary ? summary.textInputTokens + summary.audioInputTokens : 0;
  const convertedTotal = summary
    ? formatConvertedCurrency(summary.costUsd, currency, locale)
    : null;

  return (
    <dialog
      ref={dialog}
      className="usage-dialog"
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
      {summary && (
        <>
          <div className="dialog-header">
            <div>
              <div className="eyebrow">
                {mode === 'session' ? t('使用摘要') : t('會議用量明細')}
              </div>
              <h2 id={titleId}>
                {mode === 'session' ? t('本次使用費用摘要') : t('本場會議費用明細')}
              </h2>
            </div>
            <button
              type="button"
              className="close"
              aria-label={t('關閉費用摘要')}
              onClick={() => void closeDialogAnimated(dialog.current)}
            >
              <IconX size={18} />
            </button>
          </div>

          <div className="usage-meta-row">
            <strong>{formatMeetingTitle(t, summary.meetingTitle)}</strong>
            <span className="usage-date-pill">{formatBillingDate(summary.usageDate, locale)}</span>
            {summary.keySources.map((src) => (
              <span
                key={src}
                className={`key-source-pill ${src === 'server_env' ? 'env' : 'byok'}`}
              >
                {localize(keySourceLabel(src))}
              </span>
            ))}
          </div>

          <div className="usage-kpis">
            <div className="usage-kpi">
              <span>{t('使用時間')}</span>
              <strong>{formatDuration(t, summary.durationSeconds)}</strong>
            </div>
            {summary.audioSeconds > 0 && (
              <div className="usage-kpi">
                <span>{t('音訊處理量')}</span>
                <strong>{formatDuration(t, summary.audioSeconds)}</strong>
              </div>
            )}
            <div className="usage-kpi">
              <span>{t('總 Token 數')}</span>
              <strong>{formatTokens(summary.totalTokens, locale)}</strong>
            </div>
            <div className="usage-kpi highlight">
              <span>{summary.pendingCalls > 0 ? t('已計價費用') : t('費用小計')}</span>
              <strong>{formatUsd(summary.costUsd)}</strong>
              {convertedTotal && <small>{convertedTotal}</small>}
              {summary.pendingCalls > 0 && (
                <small className="warn-note">
                  {t('{1} 筆待核對，費用小計尚未包含', summary.pendingCalls)}
                </small>
              )}
            </div>
          </div>

          {summary.models.length > 0 ? (
            <div className="table-scroll">
              <table className="usage-table">
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
                  {summary.models.map((row) => {
                    const rowIn = row.textInputTokens + row.audioInputTokens;
                    const rowConverted = formatConvertedCurrency(row.costUsd, currency, locale);
                    return (
                      <tr key={`${row.operation}:${row.provider}:${row.model}:${row.keySource}`}>
                        <td>{localize(operationLabel(row.operation))}</td>
                        <td>
                          <div className="model-cell">
                            <code>{row.model}</code>
                            <small>
                              {row.provider === 'openai' ? 'OpenAI' : 'Gemini'}
                              {row.calls > 1 ? t(' · {1} 次', row.calls) : ''}
                            </small>
                          </div>
                        </td>
                        <td>
                          <span
                            className={`key-source-pill ${row.keySource === 'server_env' ? 'env' : 'byok'}`}
                          >
                            {row.keySource === 'server_env' ? '.env' : 'BYOK'}
                          </span>
                        </td>
                        <td>
                          {row.audioSeconds > 0
                            ? formatDuration(t, row.audioSeconds)
                            : formatDuration(t, row.durationSeconds)}
                        </td>
                        <td className="num">
                          <div>{formatTokens(rowIn, locale)}</div>
                          {(row.audioInputTokens > 0 || row.cachedInputTokens > 0) && (
                            <small className="token-sub">
                              {row.audioInputTokens > 0
                                ? t('音訊 {1}', formatTokens(row.audioInputTokens, locale))
                                : ''}
                              {row.audioInputTokens > 0 && row.cachedInputTokens > 0 ? ' · ' : ''}
                              {row.cachedInputTokens > 0
                                ? t('快取 {1}', formatTokens(row.cachedInputTokens, locale))
                                : ''}
                            </small>
                          )}
                        </td>
                        <td className="num">{formatTokens(row.outputTokens, locale)}</td>
                        <td className="num">{formatTokens(row.totalTokens, locale)}</td>
                        <td className="num">
                          <div>
                            {row.pendingCalls === row.calls ? t('待確認') : formatUsd(row.costUsd)}
                          </div>
                          {rowConverted && row.pendingCalls < row.calls && (
                            <small className="token-sub">{rowConverted}</small>
                          )}
                          {row.pricingMissing && (
                            <small className="warn-note">{t('未設定費率')}</small>
                          )}
                          {row.pendingCalls > 0 && (
                            <small className="warn-note">
                              {t('{1} 筆待核對', row.pendingCalls)}
                            </small>
                          )}
                          {row.estimated && !row.pricingMissing && row.pendingCalls === 0 && (
                            <small className="token-sub">{t('依時長計費')}</small>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="hint usage-empty-note">
              {t('本次作業未呼叫雲端 AI 模型（費用為 $0.0000），僅記錄本機錄音使用時間。')}
            </p>
          )}

          <div className="usage-subtotal">
            <div>
              <strong>{t('小計')}</strong>
              <span>
                {t(
                  '使用時間 {1} · 輸入 {2} + 輸出 {3} = {4} Token',
                  formatDuration(t, summary.durationSeconds),
                  totalInput,
                  summary.outputTokens,
                  summary.totalTokens,
                )}
              </span>
            </div>
            <div className="usage-subtotal-amount">
              <strong>{formatUsd(summary.costUsd)}</strong>
              {convertedTotal && <small>{convertedTotal}</small>}
              {summary.pendingCalls > 0 && (
                <small className="warn-note">{t('{1} 筆待核對', summary.pendingCalls)}</small>
              )}
            </div>
          </div>

          <div className="dialog-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => {
                void closeDialogAnimated(dialog.current).then(onOpenDashboard);
              }}
            >
              <IconBarChart size={15} />
              <span>{t('查看個人費用總覽')}</span>
            </button>
            <button
              type="button"
              className="record"
              onClick={() => void closeDialogAnimated(dialog.current)}
            >
              {t('完成')}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
