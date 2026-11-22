import { useEffect, useId, useRef, useState } from 'react';
import { exportMeetingArchive, importMeetingArchive, type Meeting } from '../db/meetingDb';
import { downloadMeetingArchive } from '../services/exporter';
import { closeDialogAnimated, openDialogModal } from '../utils/dialog';
import { IconX } from './Icons';

function formatBytes(bytes: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit++;
  }
  return `${bytes.toLocaleString('zh-TW', { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

export function LocalWorkspace({
  selectedMeeting,
  meetingCount,
  locked,
  onBeforeExport,
  onImported,
}: {
  selectedMeeting?: Meeting;
  meetingCount: number;
  locked: boolean;
  onBeforeExport: () => Promise<void>;
  onImported: (meetings: Meeting[]) => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [space, setSpace] = useState('正在估算…');
  const [scope, setScope] = useState<'workspace' | 'meeting'>('workspace');
  const [includeAudio, setIncludeAudio] = useState(false);
  const [importFile, setImportFile] = useState<File>();
  const [operation, setOperation] = useState<'export' | 'import'>();
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const estimate = await navigator.storage?.estimate?.();
        if (!active) return;
        setSpace(
          estimate?.usage != null && estimate.quota != null && estimate.quota > 0
            ? `約 ${formatBytes(estimate.usage)} / ${formatBytes(estimate.quota)}`
            : '無法取得用量',
        );
      } catch {
        if (active) setSpace('無法取得用量');
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
    if (fileInput.current) fileInput.current.value = '';
    if (!selectedMeeting) setScope('workspace');
    openDialogModal(dialog.current);
  }

  async function run(action: 'export' | 'import') {
    if (operation || locked) return;
    setError('');
    setStatus('');
    setOperation(action);
    try {
      if (action === 'export') {
        await onBeforeExport();
        const meeting = scope === 'meeting' ? selectedMeeting : undefined;
        const blob = await exportMeetingArchive({ meetingId: meeting?.id, includeAudio });
        downloadMeetingArchive(blob, meeting?.title);
        setStatus('已產生備份檔案。');
      } else if (importFile) {
        const meetings = await importMeetingArchive(importFile);
        onImported(meetings);
        setImportFile(undefined);
        if (fileInput.current) fileInput.current.value = '';
        setStatus(`已匯入 ${meetings.length} 場會議。`);
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
  return (
    <div className="sidebar-footer">
      <span className="avatar" aria-hidden="true">
        P
      </span>
      <div className="local-workspace-info">
        <strong>本機工作空間</strong>
        <small aria-label={`本機儲存空間用量：${space}`}>{space}</small>
        <button type="button" className="secondary small-button" disabled={locked} onClick={open}>
          資料備份
        </button>
      </div>
      <dialog
        ref={dialog}
        className="archive-dialog"
        aria-labelledby={titleId}
        onCancel={(event) => {
          event.preventDefault();
          if (!operation) void closeDialogAnimated(dialog.current);
        }}
      >
        <div className="dialog-header">
          <h2 id={titleId}>本機資料備份</h2>
          <button
            type="button"
            className="close"
            aria-label="關閉備份視窗"
            disabled={Boolean(operation)}
            onClick={() => void closeDialogAnimated(dialog.current)}
          >
            <IconX size={18} />
          </button>
        </div>
        <section className="archive-section">
          <h3>匯出備份</h3>
          <label className="archive-scope">
            匯出範圍
            <select
              value={scope}
              disabled={disabled}
              onChange={(event) =>
                setScope(event.target.value === 'meeting' ? 'meeting' : 'workspace')
              }
            >
              <option value="workspace">整個工作空間</option>
              {selectedMeeting && <option value="meeting">目前會議</option>}
            </select>
          </label>
          <label className="archive-audio">
            <input
              type="checkbox"
              checked={includeAudio}
              disabled={disabled}
              onChange={(event) => setIncludeAudio(event.target.checked)}
            />
            包含錄音音檔
          </label>
          <button
            type="button"
            className="secondary"
            disabled={disabled || meetingCount === 0}
            onClick={() => void run('export')}
          >
            {operation === 'export' ? '正在匯出…' : '下載備份'}
          </button>
        </section>
        <section className="archive-section">
          <h3>匯入備份</h3>
          <p className="hint">會議將以新副本加入工作空間。</p>
          <div className="archive-file-actions">
            <button
              type="button"
              className="secondary"
              disabled={disabled}
              onClick={() => fileInput.current?.click()}
            >
              選擇備份檔
            </button>
            <input
              ref={fileInput}
              type="file"
              aria-label="選擇 PolyMeet 備份檔"
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
              {operation === 'import' ? '正在匯入…' : '匯入會議'}
            </button>
          </div>
          {importFile && <p className="hint archive-filename">{importFile.name}</p>}
        </section>
        {status && (
          <p className="hint status-feedback" role="status">
            {status}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </dialog>
    </div>
  );
}
