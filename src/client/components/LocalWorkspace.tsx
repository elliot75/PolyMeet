import { useI18n, message, type LocalizedMessage } from '../i18n/preferences';
import { useEffect, useId, useRef, useState, type HTMLAttributes } from 'react';
import type { AuthUser } from '../../shared/types';
import {
  exportMeetingArchive,
  importLegacyWorkspace,
  importMeetingArchive,
  type Meeting,
} from '../db/meetingDb';
import { workspaceFetch } from '../services/workspaceSession';
import { downloadMeetingArchive } from '../services/exporter';
import { closeDialogAnimated, isPointerOutsideDialog, openDialogModal } from '../utils/dialog';
import { IconKey, IconLogOut, IconX } from './Icons';

function formatBytes(bytes: number, locale: string) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit++;
  }
  return `${bytes.toLocaleString(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

export function LocalWorkspace({
  user,
  selectedMeeting,
  meetingCount,
  locked,
  onBeforeExport,
  onImported,
  onChangePassword,
  onLogout,
}: {
  user: AuthUser;
  selectedMeeting?: Meeting;
  meetingCount: number;
  locked: boolean;
  onBeforeExport: (meetingId?: string) => Promise<boolean>;
  onImported: (meetings: Meeting[]) => void;
  onChangePassword: () => void;
  onLogout: () => void | Promise<void>;
}) {
  const { t, locale, localize } = useI18n();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pressedOutside = useRef(false);
  const [storageEstimate, setStorageEstimate] = useState<StorageEstimate | null>();
  const space =
    storageEstimate === undefined
      ? t('正在估算…')
      : storageEstimate?.usage != null && storageEstimate.quota != null && storageEstimate.quota > 0
        ? t(
            '約 {1} / {2}',
            formatBytes(storageEstimate.usage, locale),
            formatBytes(storageEstimate.quota, locale),
          )
        : t('無法取得用量');
  const [scope, setScope] = useState<'workspace' | 'meeting'>('workspace');
  const [includeAudio, setIncludeAudio] = useState(false);
  const [importFile, setImportFile] = useState<File>();
  const [operation, setOperation] = useState<'export' | 'import' | 'legacy'>();
  const [confirmLegacy, setConfirmLegacy] = useState(false);
  const [status, setStatus] = useState<LocalizedMessage>('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const estimate = await navigator.storage?.estimate?.();
        if (!active) return;
        setStorageEstimate(estimate ?? null);
      } catch {
        if (active) setStorageEstimate(null);
      }
    };
    void refresh();
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
    };
  }, [locked, meetingCount, operation]);

  function open() {
    setError('');
    setStatus('');
    setImportFile(undefined);
    setConfirmLegacy(false);
    if (fileInput.current) fileInput.current.value = '';
    if (!selectedMeeting) setScope('workspace');
    openDialogModal(dialog.current);
  }

  async function run(action: 'export' | 'import' | 'legacy') {
    if (operation || locked) return;
    setError('');
    setStatus('');
    setOperation(action);
    try {
      if (action === 'export') {
        const meeting = scope === 'meeting' ? selectedMeeting : undefined;
        const flushed = await onBeforeExport(meeting?.id);
        if (!flushed) throw new Error('部分編輯尚未成功儲存，已取消匯出備份。');
        const blob = await exportMeetingArchive({ meetingId: meeting?.id, includeAudio });
        downloadMeetingArchive(blob, meeting?.title);
        setStatus('已產生備份檔案。');
      } else if (action === 'legacy' && confirmLegacy) {
        const session = await workspaceFetch('/api/auth/me');
        if (!session.ok || (await session.json()).user?.id !== user.id) {
          throw new Error('登入帳號已變更，請重新開啟工作區。');
        }
        let olderMeetings: Meeting[] = [];
        let unreadableMeetingList = false;
        try {
          const parsed: unknown = JSON.parse(localStorage.getItem('polymeet-meetings') || '[]');
          if (
            !Array.isArray(parsed) ||
            parsed.some((item) => !item || typeof item.id !== 'string')
          ) {
            throw new Error('invalid_legacy_meeting_list');
          }
          olderMeetings = parsed;
        } catch {
          unreadableMeetingList = true;
        }
        const meetings = await importLegacyWorkspace(user.id, olderMeetings);
        if (meetings.length) onImported(meetings);
        setStatus(
          meetings.length
            ? message('已匯入 {1} 場舊版會議。', meetings.length)
            : '沒有尚未匯入的舊版會議。',
        );
        if (unreadableMeetingList) {
          setError('部分舊版會議清單無法讀取，原始清單仍保留。');
        }
        setConfirmLegacy(false);
      } else if (action === 'import' && importFile) {
        const meetings = await importMeetingArchive(importFile);
        onImported(meetings);
        setImportFile(undefined);
        if (fileInput.current) fileInput.current.value = '';
        setStatus(message('已匯入 {1} 場會議。', meetings.length));
      }
    } catch (failure) {
      if (failure instanceof DOMException) {
        setError(
          failure.name === 'QuotaExceededError'
            ? '本機空間不足，無法完成備份作業。'
            : '無法完成備份作業，請重試。',
        );
      } else {
        setError(failure instanceof Error ? failure.message : '無法完成備份作業，請重試。');
      }
    } finally {
      setOperation(undefined);
    }
  }

  const disabled = locked || Boolean(operation);
  const initial = (user.displayName || user.username || 'U').slice(0, 1).toUpperCase();
  return (
    <div className="sidebar-footer account-footer">
      <div className="account-header">
        <span className="avatar" aria-hidden="true">
          {initial}
        </span>
        <div className="local-workspace-info">
          <div className="account-name-row">
            <strong>{user.displayName}</strong>
            {user.role === 'admin' && <span className="role-pill">{t('管理員')}</span>}
          </div>
          <small className="account-handle">@{user.username}</small>
          <small aria-label={t('本機儲存空間用量：{1}', space)}>{space}</small>
        </div>
      </div>
      <div className="account-actions">
        <button type="button" className="secondary small-button" disabled={locked} onClick={open}>
          {t('資料備份')}
        </button>
        <button
          type="button"
          className="secondary small-button"
          disabled={locked}
          onClick={onChangePassword}
        >
          <IconKey size={13} />
          <span>{t('改密碼')}</span>
        </button>
        <button
          type="button"
          className="secondary small-button"
          disabled={locked}
          onClick={() => void onLogout()}
        >
          <IconLogOut size={13} />
          <span>{t('登出')}</span>
        </button>
      </div>
      <dialog
        ref={dialog}
        className="archive-dialog"
        aria-labelledby={titleId}
        {...({ closedby: operation ? 'none' : 'any' } as HTMLAttributes<HTMLDialogElement>)}
        onCancel={(event) => {
          event.preventDefault();
          if (!operation) void closeDialogAnimated(dialog.current);
        }}
        onPointerDown={(event) => {
          if (!operation && !('closedBy' in HTMLDialogElement.prototype) && dialog.current) {
            pressedOutside.current = isPointerOutsideDialog(event, dialog.current);
          }
        }}
        onPointerUp={(event) => {
          if (
            !operation &&
            !('closedBy' in HTMLDialogElement.prototype) &&
            pressedOutside.current &&
            dialog.current &&
            isPointerOutsideDialog(event, dialog.current)
          ) {
            void closeDialogAnimated(dialog.current);
          }
          pressedOutside.current = false;
        }}
      >
        <div className="dialog-header">
          <h2 id={titleId}>{t('本機資料備份')}</h2>
          <button
            type="button"
            className="close"
            aria-label={t('關閉備份視窗')}
            disabled={Boolean(operation)}
            onClick={() => void closeDialogAnimated(dialog.current)}
          >
            <IconX size={18} />
          </button>
        </div>
        <section className="archive-section">
          <h3>{t('匯出備份')}</h3>
          <label className="archive-scope">
            {t('匯出範圍')}
            <select
              value={scope}
              disabled={disabled}
              onChange={(event) =>
                setScope(event.target.value === 'meeting' ? 'meeting' : 'workspace')
              }
            >
              <option value="workspace">{t('整個工作空間')}</option>
              {selectedMeeting && <option value="meeting">{t('目前會議')}</option>}
            </select>
          </label>
          <label className="archive-audio">
            <input
              type="checkbox"
              checked={includeAudio}
              disabled={disabled}
              onChange={(event) => setIncludeAudio(event.target.checked)}
            />
            {t('包含錄音音檔')}
          </label>
          <button
            type="button"
            className="secondary"
            disabled={disabled || meetingCount === 0}
            onClick={() => void run('export')}
          >
            {operation === 'export' ? t('正在匯出…') : t('下載備份')}
          </button>
        </section>
        <section className="archive-section">
          <h3>{t('匯入備份')}</h3>
          <p className="hint">{t('會議將以新副本加入工作空間。')}</p>
          <div className="archive-file-actions">
            <button
              type="button"
              className="secondary"
              disabled={disabled}
              onClick={() => fileInput.current?.click()}
            >
              {t('選擇備份檔')}
            </button>
            <input
              ref={fileInput}
              type="file"
              aria-label={t('選擇 PolyMeet 備份檔')}
              accept=".polymeet"
              hidden
              disabled={disabled}
              onChange={(event) => {
                setImportFile(event.target.files?.[0]);
                setError('');
                setStatus('');
              }}
            />
            <button
              type="button"
              className="secondary"
              disabled={disabled || !importFile}
              onClick={() => void run('import')}
            >
              {operation === 'import' ? t('正在匯入…') : t('匯入會議')}
            </button>
          </div>
          {importFile && <p className="hint archive-filename">{importFile.name}</p>}
        </section>
        <section className="archive-section">
          <h3>{t('匯入舊版工作區')}</h3>
          <p className="hint">
            {t('首次匯入會將這個瀏覽器的舊版資料綁定到目前帳號。原始資料仍會保留。')}
          </p>
          <label className="archive-audio">
            <input
              type="checkbox"
              checked={confirmLegacy}
              disabled={disabled}
              onChange={(event) => setConfirmLegacy(event.target.checked)}
            />
            {t('我有權將舊版資料匯入 @{1}', user.username)}
          </label>
          <button
            type="button"
            className="secondary"
            disabled={disabled || !confirmLegacy}
            onClick={() => void run('legacy')}
          >
            {operation === 'legacy' ? t('正在匯入…') : t('匯入舊版資料')}
          </button>
        </section>
        {status && (
          <p className="hint status-feedback" role="status">
            {localize(status)}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {localize(error)}
          </p>
        )}
      </dialog>
    </div>
  );
}
