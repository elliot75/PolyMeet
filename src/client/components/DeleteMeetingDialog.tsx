import { useI18n } from '../i18n/preferences';
import { useRef, useState, type HTMLAttributes } from 'react';
import { closeDialogAnimated, isPointerOutsideDialog, openDialogModal } from '../utils/dialog';
import { IconTrash } from './Icons';

export function DeleteMeetingDialog({
  title,
  disabled,
  onDelete,
}: {
  title: string;
  disabled: boolean;
  onDelete: () => Promise<void>;
}) {
  const { t, localize } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const keepButtonRef = useRef<HTMLButtonElement>(null);
  const pressedOutside = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function remove() {
    setBusy(true);
    setError('');
    try {
      await onDelete();
      await closeDialogAnimated(dialog.current);
    } catch {
      setError('無法刪除會議，請重試。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="delete-trigger"
        disabled={disabled}
        onClick={() => {
          setError('');
          openDialogModal(dialog.current);
          keepButtonRef.current?.focus();
        }}
      >
        <IconTrash size={14} />
        <span>{t('刪除會議')}</span>
      </button>
      <dialog
        ref={dialog}
        className="confirm-dialog"
        aria-labelledby="delete-title"
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
        onClose={() => {
          if (dialog.current) dialog.current.returnValue = '';
        }}
      >
        <div className="danger-badge" aria-hidden="true">
          <IconTrash size={20} />
        </div>
        <h2 id="delete-title">{t('刪除這場會議？')}</h2>
        <p className="hint">
          {t('「{1}」及其錄音、逐字稿和會議紀錄將從這個瀏覽器永久移除，無法復原。', title)}
        </p>
        {error && (
          <p className="error" role="alert">
            {localize(error)}
          </p>
        )}
        <div className="dialog-actions">
          <button
            ref={keepButtonRef}
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void closeDialogAnimated(dialog.current)}
          >
            {t('保留會議')}
          </button>
          <button
            type="button"
            className="danger-solid"
            disabled={busy}
            onClick={() => void remove()}
          >
            {busy ? t('刪除中…') : t('確認刪除')}
          </button>
        </div>
      </dialog>
    </>
  );
}
