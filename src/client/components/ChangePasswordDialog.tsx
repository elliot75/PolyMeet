import { useI18n } from '../i18n/preferences';
import { useEffect, useId, useRef, useState, type FormEvent, type HTMLAttributes } from 'react';
import { changeOwnPassword } from '../services/authClient';
import { closeDialogAnimated, isPointerOutsideDialog, openDialogModal } from '../utils/dialog';
import { IconAlertCircle, IconCheckCircle, IconX } from './Icons';

export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, localize } = useI18n();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const pressedOutside = useRef(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (open) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setError('');
      setDone(false);
      openDialogModal(dialog.current);
    } else if (dialog.current?.open) {
      void closeDialogAnimated(dialog.current);
    }
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (newPassword !== confirmPassword) {
      setError('新密碼與確認密碼不一致。');
      return;
    }
    setBusy(true);
    try {
      await changeOwnPassword({ currentPassword, newPassword });
      setDone(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '變更密碼失敗。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="speaker-dialog"
      aria-labelledby={titleId}
      {...({ closedby: busy ? 'none' : 'any' } as HTMLAttributes<HTMLDialogElement>)}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) void closeDialogAnimated(dialog.current);
      }}
      onPointerDown={(event) => {
        if (!busy && !('closedBy' in HTMLDialogElement.prototype) && dialog.current) {
          pressedOutside.current = isPointerOutsideDialog(event, dialog.current);
        }
      }}
      onPointerUp={(event) => {
        if (
          !busy &&
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
          <div className="eyebrow">{t('帳號安全')}</div>
          <h2 id={titleId}>{t('變更密碼')}</h2>
        </div>
        <button
          type="button"
          className="close"
          aria-label={t('關閉變更密碼視窗')}
          disabled={busy}
          onClick={() => void closeDialogAnimated(dialog.current)}
        >
          <IconX size={18} />
        </button>
      </div>

      <form className="speaker-form" onSubmit={(e) => void submit(e)}>
        <label>
          <span>{t('目前密碼')}</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={currentPassword}
            disabled={busy}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </label>
        <label>
          <span>{t('新密碼（至少 6 碼）')}</span>
          <input
            type="password"
            required
            minLength={6}
            autoComplete="new-password"
            value={newPassword}
            disabled={busy}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </label>
        <label>
          <span>{t('確認新密碼')}</span>
          <input
            type="password"
            required
            minLength={6}
            autoComplete="new-password"
            value={confirmPassword}
            disabled={busy}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </label>

        {error && (
          <p className="error" role="alert">
            <IconAlertCircle size={15} />
            <span>{localize(error)}</span>
          </p>
        )}
        {done && (
          <p className="hint status-feedback" role="status">
            <IconCheckCircle size={15} /> {t('密碼已更新。')}
          </p>
        )}

        <div className="dialog-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void closeDialogAnimated(dialog.current)}
          >
            {t('關閉')}
          </button>
          <button type="submit" className="record" disabled={busy}>
            {busy ? t('儲存中…') : t('更新密碼')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
