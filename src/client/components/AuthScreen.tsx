import { LanguageSelect, useI18n } from '../i18n/preferences';
import { useId, useState, type FormEvent } from 'react';
import type { AuthUser } from '../../shared/types';
import { loginUser, setupInitialAdmin } from '../services/authClient';
import { IconAlertCircle, IconBrandMark, IconKey, IconShield } from './Icons';

export function AuthScreen({
  needsSetup,
  setupAvailable,
  onAuthenticated,
}: {
  needsSetup: boolean;
  setupAvailable: boolean;
  onAuthenticated: (user: AuthUser) => void;
}) {
  const { t, localize } = useI18n();
  const [username, setUsername] = useState(needsSetup ? 'admin' : '');
  const [enteredDisplayName, setDisplayName] = useState<string | null>(null);
  const displayName = enteredDisplayName ?? t('系統管理員');
  const setupTokenId = useId();
  const [setupToken, setSetupToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');

    if (needsSetup && password !== confirmPassword) {
      setError('兩次輸入的密碼不一致。');
      return;
    }

    setBusy(true);
    try {
      const result = needsSetup
        ? await setupInitialAdmin({
            username: username.trim(),
            displayName: displayName.trim() || username.trim(),
            password,
            setupToken,
          })
        : await loginUser({ username: username.trim(), password });
      onAuthenticated(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登入失敗，請重試。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-card-header">
          <div className="auth-brand">
            <span className="brandmark" aria-hidden="true">
              <IconBrandMark size={22} />
            </span>
            <div>
              <strong>PolyMeet</strong>
              <small>{t('會議工作區')}</small>
            </div>
          </div>

          <LanguageSelect />
        </div>

        <div className="auth-heading">
          <div className="eyebrow">{needsSetup ? t('初始管理員設定') : t('帳號登入')}</div>
          <h1>{needsSetup ? t('建立初始管理員帳號') : t('登入 PolyMeet')}</h1>
          <p className="hint">
            {needsSetup
              ? t(
                  '首次啟動請建立管理員帳號，之後可於管理後台新增成員帳號、控管 .env 金鑰權限與統計對價費用。',
                )
              : t(
                  '請輸入個人帳號與密碼。每次使用結束後將自動顯示時間、模型 Token 用量與費用明細。',
                )}
          </p>
        </div>

        {needsSetup && !setupAvailable ? (
          <p role="status" className="hint">
            {t('請由部署管理員在伺服器設定初始管理員，或啟用初始化代碼，然後重新整理頁面。')}
          </p>
        ) : (
          <form className="auth-form" onSubmit={(e) => void handleSubmit(e)}>
            {needsSetup && (
              <label htmlFor={setupTokenId}>
                <span>{t('初始化代碼（必填）')}</span>
                <input
                  id={setupTokenId}
                  type="password"
                  required
                  autoComplete="off"
                  value={setupToken}
                  disabled={busy}
                  onChange={(event) => setSetupToken(event.target.value)}
                />
              </label>
            )}
            <label>
              <span>{t('帳號')}</span>
              <input
                type="text"
                required
                autoFocus
                autoComplete="username"
                placeholder={t('例如 alice 或 admin')}
                value={username}
                disabled={busy}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>

            {needsSetup && (
              <label>
                <span>{t('顯示名稱')}</span>
                <input
                  type="text"
                  required
                  placeholder={t('例如 系統管理員')}
                  value={displayName}
                  disabled={busy}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </label>
            )}

            <label>
              <span>{t('密碼')}</span>
              <input
                type="password"
                required
                minLength={6}
                autoComplete={needsSetup ? 'new-password' : 'current-password'}
                placeholder={t('至少 6 個字元')}
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>

            {needsSetup && (
              <label>
                <span>{t('確認密碼')}</span>
                <input
                  type="password"
                  required
                  minLength={6}
                  autoComplete="new-password"
                  placeholder={t('再次輸入密碼')}
                  value={confirmPassword}
                  disabled={busy}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </label>
            )}

            {error && (
              <p className="error" role="alert">
                <IconAlertCircle size={15} />
                <span>{localize(error)}</span>
              </p>
            )}

            <button type="submit" className="record auth-submit" disabled={busy}>
              {needsSetup ? <IconShield size={16} /> : <IconKey size={16} />}
              <span>
                {busy
                  ? needsSetup
                    ? t('建立中…')
                    : t('登入中…')
                  : needsSetup
                    ? t('建立管理員並登入')
                    : t('登入')}
              </span>
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
