import { useRef, useState } from 'react';
export function DeleteMeetingDialog({
  title,
  disabled,
  onDelete,
}: {
  title: string;
  disabled: boolean;
  onDelete: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await onDelete();
      dialog.current?.close();
    } catch {
      setError('無法刪除會議，請重試。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="delete-trigger"
        disabled={disabled}
        onClick={() => {
          setError('');
          dialog.current?.showModal();
        }}
      >
        刪除會議
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="delete-title"
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
        onClose={() => {
          if (dialog.current) dialog.current.returnValue = '';
        }}
      >
        <h2 id="delete-title">刪除這場會議？</h2>
        <p className="hint">「{title}」及其錄音、逐字稿和會議紀錄將從這個瀏覽器刪除，無法復原。</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            className="secondary"
            autoFocus
            disabled={busy}
            onClick={() => dialog.current?.close()}
          >
            保留會議
          </button>
          <button className="record stop" disabled={busy} onClick={() => void remove()}>
            {busy ? '刪除中…' : '刪除會議'}
          </button>
        </div>
      </dialog>
    </>
  );
}
