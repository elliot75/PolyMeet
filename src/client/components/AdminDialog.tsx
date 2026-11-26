import { formatBillingDate, formatDuration, formatMeetingTitle } from '../i18n/format';
import { useI18n, message, type LocalizedMessage } from '../i18n/preferences';
import { UsageReconciliation } from './UsageReconciliation';
import { useUsageCalendar } from '../services/useUsageCalendar';
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type HTMLAttributes,
} from 'react';
import {
  formatConvertedCurrency,
  formatTokens,
  formatUsd,
  operationLabel,
} from '../../shared/pricing';
import type {
  AuthUser,
  CurrencySettings,
  KeySource,
  ModelPricing,
  ProviderId,
  UsageReportResponse,
  UserRole,
} from '../../shared/types';
import {
  adminCreateUser,
  adminDeletePricing,
  adminFetchPricing,
  adminFetchUsage,
  adminListUsers,
  adminSetCurrency,
  adminUpdateUser,
  adminUpsertPricing,
  adminUsageCsvUrl,
  downloadCsvFromUrl,
} from '../services/authClient';
import { closeDialogAnimated, isPointerOutsideDialog, openDialogModal } from '../utils/dialog';
import {
  IconAlertCircle,
  IconChevronDown,
  IconDownload,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from './Icons';

type AdminTab = 'reconciliation' | 'users' | 'pricing';
export function AdminDialog({
  open,
  currentUser,
  onClose,
  onPricingChanged,
}: {
  open: boolean;
  currentUser: AuthUser;
  onClose: () => void;
  onPricingChanged?: () => void;
}) {
  const { t, locale, localize } = useI18n();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const pressedOutside = useRef(false);

  const [tab, setTab] = useState<AdminTab>('reconciliation');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<LocalizedMessage>('');

  // Tab 1: Reconciliation state
  const { from, to, preset, setPreset, setDate, ready, timeZone, calendarError } =
    useUsageCalendar(open);
  const [keySource, setKeySource] = useState<KeySource | 'all'>('server_env');
  const [userIdFilter, setUserIdFilter] = useState('');
  const [search, setSearch] = useState('');
  const [report, setReport] = useState<UsageReportResponse | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Tab 2: Users state
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('user');
  const [newAllowServerKeys, setNewAllowServerKeys] = useState(true);
  const [resetTargetId, setResetTargetId] = useState<string | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState('');

  // Tab 3: Pricing & Currency state
  const [pricingList, setPricingList] = useState<ModelPricing[]>([]);
  const [currencyCode, setCurrencyCode] = useState('');
  const [exchangeRate, setExchangeRate] = useState('0');
  const [pProvider, setPProvider] = useState<ProviderId>('openai');
  const [pModel, setPModel] = useState('');
  const [pInput, setPInput] = useState('0');
  const [pAudioInput, setPAudioInput] = useState('0');
  const [pCached, setPCached] = useState('0');
  const [pOutput, setPOutput] = useState('0');
  const [pPerMin, setPPerMin] = useState('0');

  const usageFilters = useMemo(
    () => ({
      userId: userIdFilter || undefined,
      keySource,
      from,
      to,
      search,
    }),
    [userIdFilter, keySource, from, to, search],
  );
  const reportRequest = useRef(0);
  const loadReport = useCallback(async () => {
    if (!ready) return;
    const request = ++reportRequest.current;
    setLoadingReport(true);
    setError('');
    try {
      const data = await adminFetchUsage(usageFilters);
      if (request === reportRequest.current) setReport(data);
    } catch (err) {
      if (request === reportRequest.current) {
        setError(err instanceof Error ? err.message : '無法讀取管理員對價報表。');
      }
    } finally {
      if (request === reportRequest.current) setLoadingReport(false);
    }
  }, [ready, usageFilters]);

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    setError('');
    try {
      const data = await adminListUsers();
      setUsers(data.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : '無法讀取帳號清單。');
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  const loadPricing = useCallback(async () => {
    setError('');
    try {
      const data = await adminFetchPricing();
      setPricingList(data.pricing);
      setCurrencyCode(data.currency.currencyCode);
      setExchangeRate(String(data.currency.exchangeRate || 0));
    } catch (err) {
      setError(err instanceof Error ? err.message : '無法讀取費率設定。');
    }
  }, []);

  useEffect(() => {
    if (open) {
      setError('');
      setNotice('');
      openDialogModal(dialog.current);
      void loadUsers();
      void loadPricing();
    } else if (dialog.current?.open) {
      void closeDialogAnimated(dialog.current);
    }
  }, [open, loadUsers, loadPricing]);

  useEffect(() => {
    if (open && tab === 'reconciliation') void loadReport();
    return () => {
      reportRequest.current += 1;
    };
  }, [open, tab, loadReport]);

  const currency: CurrencySettings = useMemo(
    () => ({
      currencyCode: report?.currencyCode || currencyCode,
      exchangeRate: report?.exchangeRate ?? (Number(exchangeRate) || 0),
    }),
    [report?.currencyCode, report?.exchangeRate, currencyCode, exchangeRate],
  );

  function toggleExpand(key: string) {
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleCreateUser(event: FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    try {
      const { user } = await adminCreateUser({
        username: newUsername,
        displayName: newDisplayName || newUsername,
        password: newPassword,
        role: newRole,
        allowServerKeys: newAllowServerKeys,
      });
      setUsers((old) => [...old, user]);
      setNewUsername('');
      setNewDisplayName('');
      setNewPassword('');
      setNewRole('user');
      setNewAllowServerKeys(true);
      setNotice(message('已建立帳號 @{1}。', user.username));
    } catch (err) {
      setError(err instanceof Error ? err.message : '建立帳號失敗。');
    }
  }

  async function handlePatchUser(
    id: string,
    patch: Parameters<typeof adminUpdateUser>[1],
    feedback?: LocalizedMessage,
  ) {
    setError('');
    setNotice('');
    try {
      const { user } = await adminUpdateUser(id, patch);
      setUsers((old) => old.map((item) => (item.id === id ? user : item)));
      if (feedback) setNotice(feedback);
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新帳號失敗。');
    }
  }

  async function handleSaveCurrency(event: FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    try {
      const { currency: saved } = await adminSetCurrency({
        currencyCode: currencyCode.trim().toUpperCase(),
        exchangeRate: Number(exchangeRate) || 0,
      });
      setCurrencyCode(saved.currencyCode);
      setExchangeRate(String(saved.exchangeRate));
      onPricingChanged?.();
      void loadReport();
      setNotice('幣別與匯率設定已儲存。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '無法儲存幣別設定。');
    }
  }

  async function handleSavePricing(event: FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    try {
      const { settledCount } = await adminUpsertPricing({
        provider: pProvider,
        model: pModel,
        inputPer1M: Number(pInput) || 0,
        audioInputPer1M: Number(pAudioInput) || 0,
        cachedInputPer1M: Number(pCached) || 0,
        outputPer1M: Number(pOutput) || 0,
        perMinute: Number(pPerMin) || 0,
      });
      setPModel('');
      await loadPricing();
      void loadReport();
      onPricingChanged?.();
      setNotice(
        settledCount
          ? message('模型費率已儲存，並已自動重算 {1} 筆未計價紀錄。', settledCount)
          : '模型費率已儲存（新產生的用量將依新費率計算）。',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '無法儲存模型費率。');
    }
  }

  const grandConverted = report
    ? formatConvertedCurrency(report.totals.costUsd, currency, locale)
    : null;

  return (
    <dialog
      ref={dialog}
      className="usage-dialog admin-dialog wide-dialog"
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
          <div className="eyebrow">{t('管理與對價')}</div>
          <h2 id={titleId}>{t('管理員控制台與 .env 對價統計')}</h2>
        </div>
        <button
          type="button"
          className="close"
          aria-label={t('關閉管理後台')}
          onClick={() => void closeDialogAnimated(dialog.current)}
        >
          <IconX size={18} />
        </button>
      </div>

      <div className="segmented-control admin-tabs" role="tablist" aria-label={t('管理分頁')}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'reconciliation'}
          className={tab === 'reconciliation' ? 'active' : ''}
          onClick={() => setTab('reconciliation')}
        >
          {t('.env 金鑰對價統計')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'users'}
          className={tab === 'users' ? 'active' : ''}
          onClick={() => setTab('users')}
        >
          {t('帳號管理（{1}）', users.length)}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'pricing'}
          className={tab === 'pricing' ? 'active' : ''}
          onClick={() => setTab('pricing')}
        >
          {t('模型費率與幣別')}
        </button>
      </div>

      {error && (
        <p className="error" role="alert">
          <IconAlertCircle size={15} />
          <span>{localize(error)}</span>
        </p>
      )}
      {notice && (
        <p className="hint status-feedback" role="status">
          {localize(notice)}
        </p>
      )}

      {tab === 'reconciliation' && (
        <div className="admin-panel">
          <div className="filter-bar">
            {timeZone && <p className="hint">{t('帳務時區 {1}', timeZone)}</p>}
            {calendarError && (
              <p className="error" role="alert">
                {localize(calendarError)}
              </p>
            )}
            <div className="preset-pills" role="group" aria-label={t('對價日期範圍')}>
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
                <span>{t('金鑰來源')}</span>
                <select
                  value={keySource}
                  onChange={(e) => setKeySource(e.target.value as KeySource | 'all')}
                >
                  <option value="server_env">{t('僅系統 .env 金鑰（對價用）')}</option>
                  <option value="all">{t('全部金鑰來源')}</option>
                  <option value="byok">{t('僅個人 BYOK 金鑰')}</option>
                </select>
              </label>
              <label>
                <span>{t('篩選帳號')}</span>
                <select value={userIdFilter} onChange={(e) => setUserIdFilter(e.target.value)}>
                  <option value="">{t('全部帳號')}</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.displayName} (@{u.username})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t('起始日期')}</span>
                <input type="date" value={from} onChange={(e) => setDate('from', e.target.value)} />
              </label>
              <label>
                <span>{t('結束日期')}</span>
                <input type="date" value={to} onChange={(e) => setDate('to', e.target.value)} />
              </label>
              <label>
                <span>{t('搜尋')}</span>
                <input
                  type="search"
                  placeholder={t('帳號 / 會議 / 模型…')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <div className="filter-actions">
                <button
                  type="button"
                  className="secondary small-button"
                  disabled={!ready || loadingReport}
                  onClick={() => void loadReport()}
                >
                  <IconRefresh size={14} />
                  <span>{t('刷新')}</span>
                </button>
                <button
                  type="button"
                  className="secondary small-button"
                  disabled={!ready || loadingReport || !report?.accounts.length}
                  onClick={() =>
                    void downloadCsvFromUrl(
                      adminUsageCsvUrl(
                        { userId: userIdFilter || undefined, keySource, from, to, search },
                        'account',
                      ),
                      'polymeet-env-account-summary.csv',
                    ).catch((err) => setError(err instanceof Error ? err.message : '匯出失敗'))
                  }
                >
                  <IconDownload size={14} />
                  <span>{t('帳號彙總 CSV')}</span>
                </button>
                <button
                  type="button"
                  className="secondary small-button"
                  disabled={!ready || loadingReport || !report?.dailyMeetings.length}
                  onClick={() =>
                    void downloadCsvFromUrl(
                      adminUsageCsvUrl(
                        { userId: userIdFilter || undefined, keySource, from, to, search },
                        'detail',
                      ),
                      'polymeet-env-reconciliation-detail.csv',
                    ).catch((err) => setError(err instanceof Error ? err.message : '匯出失敗'))
                  }
                >
                  <IconDownload size={14} />
                  <span>{t('對價明細 CSV')}</span>
                </button>
              </div>
            </div>
          </div>

          {report && (
            <>
              <div className="usage-kpis">
                <div className="usage-kpi highlight">
                  <span>{keySource === 'server_env' ? t('.env 已計價費用') : t('已計價費用')}</span>
                  <strong>{formatUsd(report.totals.costUsd)}</strong>
                  {grandConverted && <small>{grandConverted}</small>}
                  {report.totals.pendingCalls > 0 && (
                    <small className="warn-note">
                      {t('{1} 筆待核對，費用小計尚未包含', report.totals.pendingCalls)}
                    </small>
                  )}
                </div>
                <div className="usage-kpi">
                  <span>{t('使用帳號數')}</span>
                  <strong>{t('{1} 人', report.accounts.length)}</strong>
                </div>
                <div className="usage-kpi">
                  <span>{t('會議場次')}</span>
                  <strong>{t('{1} 場', report.totals.meetingCount)}</strong>
                </div>
                <div className="usage-kpi">
                  <span>{t('總使用時間')}</span>
                  <strong>{formatDuration(t, report.totals.durationSeconds)}</strong>
                </div>
                <div className="usage-kpi">
                  <span>{t('總 Token 數')}</span>
                  <strong>{formatTokens(report.totals.totalTokens, locale)}</strong>
                </div>
              </div>

              {ready && timeZone && report.totals.pendingCalls > 0 && (
                <UsageReconciliation
                  key={JSON.stringify(usageFilters)}
                  filters={usageFilters}
                  timeZone={timeZone}
                  onResolved={() => {
                    setNotice('已完成這筆用量的核對。');
                    void loadReport();
                  }}
                />
              )}

              <div className="admin-section">
                <h3>{t('各帳號用量小計')}</h3>
                {report.accounts.length > 0 ? (
                  <div
                    className="table-scroll"
                    role="region"
                    aria-label={t('各帳號用量小計')}
                    tabIndex={0}
                  >
                    <table className="usage-table">
                      <thead>
                        <tr>
                          <th>{t('帳號')}</th>
                          <th>{t('顯示名稱')}</th>
                          <th className="num">{t('會議場數')}</th>
                          <th>{t('使用時間')}</th>
                          <th className="num">{t('輸入 Token')}</th>
                          <th className="num">{t('輸出 Token')}</th>
                          <th className="num">{t('總 Token')}</th>
                          <th className="num">{t('費用小計')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.accounts.map((acc) => {
                          const accIn = acc.textInputTokens + acc.audioInputTokens;
                          const accConverted = formatConvertedCurrency(
                            acc.costUsd,
                            currency,
                            locale,
                          );
                          const selected = userIdFilter === acc.userId;
                          return (
                            <tr key={acc.userId} className={selected ? 'selected-account-row' : ''}>
                              <td>
                                <button
                                  type="button"
                                  className="account-filter-link"
                                  onClick={() => setUserIdFilter(selected ? '' : acc.userId)}
                                >
                                  @{acc.username}
                                </button>
                              </td>
                              <td>
                                {acc.displayName}
                                {!acc.active && (
                                  <span className="status-tag off">{t('已停用')}</span>
                                )}
                              </td>
                              <td className="num">{acc.meetingCount}</td>
                              <td>{formatDuration(t, acc.durationSeconds)}</td>
                              <td className="num">{formatTokens(accIn, locale)}</td>
                              <td className="num">{formatTokens(acc.outputTokens, locale)}</td>
                              <td className="num">{formatTokens(acc.totalTokens, locale)}</td>
                              <td className="num">
                                <strong>{formatUsd(acc.costUsd)}</strong>
                                {accConverted && (
                                  <small className="token-sub">{accConverted}</small>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="hint">{t('此條件下尚無帳號用量紀錄。')}</p>
                )}
              </div>

              <div className="admin-section">
                <h3>{t('帳號 × 日期 × 會議對價明細')}</h3>
                {report.dailyMeetings.length > 0 ? (
                  <div
                    className="table-scroll"
                    role="region"
                    aria-label={t('帳號 × 日期 × 會議對價明細')}
                    tabIndex={0}
                  >
                    <table className="usage-table">
                      <thead>
                        <tr>
                          <th>{t('日期')}</th>
                          <th>{t('帳號')}</th>
                          <th>{t('會議名稱')}</th>
                          <th>{t('使用時間')}</th>
                          <th className="num">{t('總 Token')}</th>
                          <th className="num">{t('費用小計')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.dailyMeetings.map((dm) => {
                          const rowKey = `${dm.usageDate}::${dm.userId}::${dm.meetingId}`;
                          const isOpen = expanded.has(rowKey);
                          const dmConverted = formatConvertedCurrency(dm.costUsd, currency, locale);
                          return (
                            <Fragment key={rowKey}>
                              <tr className="expandable-row">
                                <td>{formatBillingDate(dm.usageDate, locale)}</td>
                                <td>
                                  <strong>{dm.displayName}</strong>{' '}
                                  <small className="muted-inline">@{dm.username}</small>
                                </td>
                                <td>
                                  <button
                                    type="button"
                                    className="expand-toggle"
                                    disabled={!dm.models.length}
                                    aria-expanded={isOpen}
                                    onClick={() => toggleExpand(rowKey)}
                                  >
                                    <IconChevronDown
                                      size={14}
                                      className={isOpen ? 'rotated' : ''}
                                    />
                                    <span>{formatMeetingTitle(t, dm.meetingTitle)}</span>
                                  </button>
                                </td>
                                <td>{formatDuration(t, dm.durationSeconds)}</td>
                                <td className="num">{formatTokens(dm.totalTokens, locale)}</td>
                                <td className="num">
                                  <strong>{formatUsd(dm.costUsd)}</strong>
                                  {dmConverted && (
                                    <small className="token-sub">{dmConverted}</small>
                                  )}
                                </td>
                              </tr>
                              {isOpen && dm.models.length > 0 && (
                                <tr className="detail-row">
                                  <td colSpan={6}>
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
                                          {dm.models.map((m) => (
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
                                                {formatTokens(
                                                  m.textInputTokens + m.audioInputTokens,
                                                  locale,
                                                )}
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
                                          ))}
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
                ) : (
                  <p className="hint">
                    {loadingReport ? t('讀取中…') : t('此條件下尚無會議對價明細。')}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'users' && (
        <div className="admin-panel">
          <form className="admin-create-form" onSubmit={(e) => void handleCreateUser(e)}>
            <h3>{t('新增使用者帳號')}</h3>
            <div className="admin-form-grid">
              <label>
                <span>{t('帳號')}</span>
                <input
                  type="text"
                  required
                  placeholder={t('例如 bob')}
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                />
              </label>
              <label>
                <span>{t('顯示名稱')}</span>
                <input
                  type="text"
                  required
                  placeholder={t('例如 王小明')}
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                />
              </label>
              <label>
                <span>{t('初始密碼（至少 6 碼）')}</span>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </label>
              <label>
                <span>{t('角色')}</span>
                <select value={newRole} onChange={(e) => setNewRole(e.target.value as UserRole)}>
                  <option value="user">{t('一般成員')}</option>
                  <option value="admin">{t('管理員')}</option>
                </select>
              </label>
            </div>
            <div className="admin-form-footer">
              <label className="remember-keys">
                <input
                  type="checkbox"
                  checked={newAllowServerKeys}
                  onChange={(e) => setNewAllowServerKeys(e.target.checked)}
                />
                <span>{t('允許使用伺服器 .env 金鑰')}</span>
              </label>
              <button type="submit" className="record">
                <IconPlus size={15} />
                <span>{t('建立帳號')}</span>
              </button>
            </div>
          </form>

          <div className="admin-section">
            <h3>{t('帳號列表')}</h3>
            <div className="table-scroll" role="region" aria-label={t('帳號列表')} tabIndex={0}>
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>{t('帳號')}</th>
                    <th>{t('顯示名稱')}</th>
                    <th>{t('角色')}</th>
                    <th>{t('允許使用 .env 金鑰')}</th>
                    <th>{t('狀態')}</th>
                    <th>{t('密碼管理')}</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <code>@{u.username}</code>
                        {u.id === currentUser.id && (
                          <small className="muted-inline"> {t('(目前)')}</small>
                        )}
                      </td>
                      <td>{u.displayName}</td>
                      <td>
                        <select
                          aria-label={t('{1} 角色', u.username)}
                          value={u.role}
                          disabled={loadingUsers}
                          onChange={(e) =>
                            void handlePatchUser(
                              u.id,
                              { role: e.target.value as UserRole },
                              message('已更新 @{1} 角色。', u.username),
                            )
                          }
                        >
                          <option value="user">{t('一般成員')}</option>
                          <option value="admin">{t('管理員')}</option>
                        </select>
                      </td>
                      <td>
                        <label className="inline-check">
                          <input
                            type="checkbox"
                            checked={u.allowServerKeys}
                            onChange={(e) =>
                              void handlePatchUser(
                                u.id,
                                { allowServerKeys: e.target.checked },
                                message(
                                  '已{1} @{2} 的 .env 金鑰權限。',
                                  e.target.checked ? message('開啟') : message('停用'),
                                  u.username,
                                ),
                              )
                            }
                          />
                          <span>{u.allowServerKeys ? t('允許') : t('僅 BYOK')}</span>
                        </label>
                      </td>
                      <td>
                        <button
                          type="button"
                          className={`secondary small-button ${u.active ? '' : 'danger-outline'}`}
                          onClick={() =>
                            void handlePatchUser(
                              u.id,
                              { active: !u.active },
                              message(
                                '已{1} @{2}。',
                                u.active ? message('停用') : message('啟用'),
                                u.username,
                              ),
                            )
                          }
                        >
                          {u.active ? t('啟用中') : t('已停用')}
                        </button>
                      </td>
                      <td>
                        {resetTargetId === u.id ? (
                          <div className="inline-reset">
                            <input
                              type="password"
                              minLength={6}
                              placeholder={t('新密碼（≥6碼）')}
                              value={resetPasswordValue}
                              onChange={(e) => setResetPasswordValue(e.target.value)}
                            />
                            <button
                              type="button"
                              className="record small-button"
                              disabled={resetPasswordValue.length < 6}
                              onClick={() => {
                                void handlePatchUser(
                                  u.id,
                                  { password: resetPasswordValue },
                                  message('已重設 @{1} 密碼。', u.username),
                                ).then(() => {
                                  setResetTargetId(null);
                                  setResetPasswordValue('');
                                });
                              }}
                            >
                              {t('儲存')}
                            </button>
                            <button
                              type="button"
                              className="secondary small-button"
                              onClick={() => {
                                setResetTargetId(null);
                                setResetPasswordValue('');
                              }}
                            >
                              {t('取消')}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="secondary small-button"
                            onClick={() => {
                              setResetTargetId(u.id);
                              setResetPasswordValue('');
                            }}
                          >
                            {t('重設密碼')}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'pricing' && (
        <div className="admin-panel">
          <form className="admin-create-form" onSubmit={(e) => void handleSaveCurrency(e)}>
            <h3>{t('輔助顯示幣別與匯率')}</h3>
            <p className="hint">
              {t('費用預設以美金 (USD) 精確結算；設定匯率後將在各報表與小計同步顯示折合金額。')}
            </p>
            <div className="admin-form-grid currency-grid">
              <label>
                <span>{t('幣別代碼（留空僅顯示 USD）')}</span>
                <input
                  type="text"
                  placeholder={t('例如 TWD 或 JPY')}
                  value={currencyCode}
                  onChange={(e) => setCurrencyCode(e.target.value)}
                />
              </label>
              <label>
                <span>{t('1 USD 兌換匯率')}</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={exchangeRate}
                  onChange={(e) => setExchangeRate(e.target.value)}
                />
              </label>
              <div className="currency-submit">
                <button type="submit" className="secondary">
                  {t('儲存匯率')}
                </button>
              </div>
            </div>
          </form>

          <form className="admin-create-form" onSubmit={(e) => void handleSavePricing(e)}>
            <h3>{t('新增或更新模型費率（USD）')}</h3>
            <div className="admin-form-grid pricing-grid">
              <label>
                <span>{t('供應商')}</span>
                <select
                  value={pProvider}
                  onChange={(e) => setPProvider(e.target.value as ProviderId)}
                >
                  <option value="openai">OpenAI</option>
                  <option value="gemini">Google Gemini</option>
                </select>
              </label>
              <label>
                <span>{t('模型 ID')}</span>
                <input
                  type="text"
                  required
                  placeholder={t('例如 gpt-5-mini')}
                  value={pModel}
                  onChange={(e) => setPModel(e.target.value)}
                />
              </label>
              <label>
                <span>{t('文字輸入 / 1M')}</span>
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  value={pInput}
                  onChange={(e) => setPInput(e.target.value)}
                />
              </label>
              <label>
                <span>{t('音訊輸入 / 1M')}</span>
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  value={pAudioInput}
                  onChange={(e) => setPAudioInput(e.target.value)}
                />
              </label>
              <label>
                <span>{t('快取輸入 / 1M')}</span>
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  value={pCached}
                  onChange={(e) => setPCached(e.target.value)}
                />
              </label>
              <label>
                <span>{t('輸出 / 1M')}</span>
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  value={pOutput}
                  onChange={(e) => setPOutput(e.target.value)}
                />
              </label>
              <label>
                <span>{t('音訊計費 / 分鐘')}</span>
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  value={pPerMin}
                  onChange={(e) => setPPerMin(e.target.value)}
                />
              </label>
            </div>
            <div className="admin-form-footer">
              <span className="hint">
                {t('Token 計費優先於分鐘計費；純時長計費模型請填「每分鐘」。')}
              </span>
              <button type="submit" className="record">
                {t('儲存模型費率')}
              </button>
            </div>
          </form>

          <div className="admin-section">
            <h3>{t('現行模型費率表')}</h3>
            <div
              className="table-scroll"
              role="region"
              aria-label={t('現行模型費率表')}
              tabIndex={0}
            >
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>{t('供應商')}</th>
                    <th>{t('模型')}</th>
                    <th className="num">{t('文字 / 1M')}</th>
                    <th className="num">{t('音訊 / 1M')}</th>
                    <th className="num">{t('快取 / 1M')}</th>
                    <th className="num">{t('輸出 / 1M')}</th>
                    <th className="num">{t('每分鐘')}</th>
                    <th>{t('操作')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pricingList.map((item) => (
                    <tr key={`${item.provider}:${item.model}`}>
                      <td>{item.provider === 'openai' ? 'OpenAI' : 'Gemini'}</td>
                      <td>
                        <code>{item.model}</code>
                      </td>
                      <td className="num">${item.inputPer1M}</td>
                      <td className="num">${item.audioInputPer1M}</td>
                      <td className="num">${item.cachedInputPer1M}</td>
                      <td className="num">${item.outputPer1M}</td>
                      <td className="num">${item.perMinute}</td>
                      <td>
                        <div className="inline-actions">
                          <button
                            type="button"
                            className="secondary small-button"
                            onClick={() => {
                              setPProvider(item.provider);
                              setPModel(item.model);
                              setPInput(String(item.inputPer1M));
                              setPAudioInput(String(item.audioInputPer1M));
                              setPCached(String(item.cachedInputPer1M));
                              setPOutput(String(item.outputPer1M));
                              setPPerMin(String(item.perMinute));
                            }}
                          >
                            {t('編輯')}
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={t('刪除 {1} 費率', item.model)}
                            onClick={() => {
                              void adminDeletePricing(item.provider, item.model)
                                .then(async () => {
                                  await loadPricing();
                                  onPricingChanged?.();
                                  setNotice(message('已刪除 {1} 費率。', item.model));
                                })
                                .catch((err) =>
                                  setError(err instanceof Error ? err.message : '刪除失敗'),
                                );
                            }}
                          >
                            <IconTrash size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
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
