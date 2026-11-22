import { memo, useEffect, useRef, useState, type DragEvent, type HTMLAttributes } from 'react';
import { splitAudio } from '../audio/audioChunker';
import {
  saveSegments,
  saveUploadedRecording,
  updateSegmentText,
  type Recording,
} from '../db/meetingDb';
import { downloadTranscript, formatTimestamp } from '../services/exporter';
import { headers, type Settings } from '../services/settings';
import type { AudioTrackRole, TranscriptSegment } from '../../shared/types';
import { closeDialogAnimated, isPointerOutsideDialog, openDialogModal } from '../utils/dialog';
import {
  IconAlertCircle,
  IconDownload,
  IconFileText,
  IconMessageSquare,
  IconPlay,
  IconSearch,
  IconUpload,
  IconX,
} from './Icons';

interface Props {
  meetingId: string;
  meetingTitle: string;
  isBilingual: boolean;
  languageHints: string[];
  segments: TranscriptSegment[];
  interims: Record<string, { track: AudioTrackRole; text: string }>;
  onAppend: (segment: TranscriptSegment) => void;
  onTextChange: (id: string, text: string) => void;
  onRecordingSaved: () => void;
  onBusyChange: (busy: boolean) => void;
  onSeek: (recordingId: string, seconds: number) => void;
  settings: Settings;
  locked?: boolean;
}

const audioTypes: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
};

function normalizeAudio(file: File): File {
  const mime = file.type || audioTypes[file.name.split('.').pop()?.toLowerCase() || ''];
  if (!mime?.startsWith('audio/')) throw new Error('請選擇可支援的音訊檔案。');
  return file.type
    ? file
    : new File([file], file.name, { type: mime, lastModified: file.lastModified });
}

export const TranscriptFeed = memo(function TranscriptFeed({
  meetingId,
  meetingTitle,
  isBilingual,
  languageHints,
  segments,
  interims,
  onAppend,
  onTextChange,
  onRecordingSaved,
  onBusyChange,
  onSeek,
  settings,
  locked = false,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState('');
  const [completed, setCompleted] = useState<number | undefined>();
  const [total, setTotal] = useState<number | undefined>();
  const [uploadError, setUploadError] = useState('');
  const [editError, setEditError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const uploadProgress = useRef<{ recording: Recording; saved: boolean; completed: number } | null>(
    null,
  );
  const writes = useRef<Promise<void>>(Promise.resolve());
  const pressedOutside = useRef(false);

  useEffect(() => () => abort.current?.abort(), []);

  function choose(next: File | undefined) {
    if (!next || abort.current) return;
    uploadProgress.current = null;
    try {
      setFile(normalizeAudio(next));
      setUploadError('');
      setProgress('');
      setCompleted(undefined);
      setTotal(undefined);
    } catch (e) {
      setFile(null);
      setUploadError(e instanceof Error ? e.message : '無法讀取音檔。');
    }
  }

  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    choose(event.dataTransfer.files[0]);
  }

  async function upload() {
    if (!file || abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    onBusyChange(true);
    setUploadError('');
    setProgress('正在保存及準備音檔…');
    const upload = (uploadProgress.current ??= {
      recording: {
        id: crypto.randomUUID(),
        meetingId,
        createdAt: Date.now(),
        mimeType: file.type,
        filename: file.name,
        completed: true,
      },
      saved: false,
      completed: 0,
    });
    try {
      if (!upload.saved) {
        await saveUploadedRecording(upload.recording, file);
        upload.saved = true;
        onRecordingSaved();
      }
      controller.signal.throwIfAborted();
      for await (const part of splitAudio(file, upload.completed)) {
        controller.signal.throwIfAborted();
        setTotal(part.total);
        setCompleted(part.index - 1);
        setProgress(`正在轉錄第 ${part.index} / ${part.total} 段…`);
        const selected = { ...settings, provider: settings.sttProvider };
        const form = new FormData();
        form.set('provider', settings.sttProvider);
        form.set(
          'model',
          settings.sttProvider === 'openai' ? settings.openaiSttModel : settings.geminiSttModel,
        );
        form.set('file', part.file);
        for (const language of languageHints) form.append('language', language);
        const response = await fetch('/api/transcribe-file', {
          method: 'POST',
          headers: headers(selected),
          body: form,
          signal: controller.signal,
        });
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          throw new Error(
            result.cleanupWarning
              ? '轉錄失敗且無法刪除 Google 暫存檔，請至供應商管理介面檢查。'
              : result.error === 'missing_api_key'
                ? '請先在設定中加入轉錄服務金鑰。'
                : '音檔轉錄失敗，請檢查模型、金鑰及後端服務。',
          );
        }
        const result = await response.json();
        controller.signal.throwIfAborted();
        const items: { text: string; startSeconds: number; endSeconds?: number }[] = Array.isArray(
          result.segments,
        )
          ? result.segments
          : result.text?.trim()
            ? [{ text: result.text.trim(), startSeconds: 0 }]
            : [];
        const segments: TranscriptSegment[] = items.map((item) => ({
          id: crypto.randomUUID(),
          meetingId,
          recordingId: upload.recording.id,
          track: 'upload',
          speakerLabel: '音檔',
          startedAtMs: part.offsetMs + item.startSeconds * 1000,
          timeIsChunkStart: !Array.isArray(result.segments),
          endedAtMs:
            item.endSeconds === undefined ? undefined : part.offsetMs + item.endSeconds * 1000,
          text: item.text,
          isFinal: true,
        }));
        await saveSegments(meetingId, segments);
        upload.completed = part.index;
        segments.forEach(onAppend);
        if (result.cleanupWarning)
          setUploadError('轉錄完成，但無法刪除 Google 暫存檔，請至供應商管理介面檢查。');
        setCompleted(part.index);
      }
      uploadProgress.current = null;
      setProgress('轉錄完成，音檔與逐字稿已保存。');
      setFile(null);
    } catch (e) {
      if (controller.signal.aborted) setProgress('已停止轉錄，已保存的音檔與片段可繼續使用。');
      else {
        setUploadError(e instanceof Error ? e.message : '無法處理此音檔。');
        setProgress('已完成的片段會保留。');
      }
    } finally {
      abort.current = null;
      setBusy(false);
      onBusyChange(false);
      if (input.current) input.current.value = '';
    }
  }

  function edit(segment: TranscriptSegment, text: string) {
    setEditError('');
    onTextChange(segment.id, text);
    writes.current = writes.current
      .catch(() => {})
      .then(() => updateSegmentText(segment.id, text))
      .catch(() => {
        setEditError('無法保存逐字稿修改，請檢查瀏覽器儲存空間。');
      });
  }

  const normalizedFilter = filterQuery.trim().toLowerCase();
  const visibleSegments = normalizedFilter
    ? segments.filter(
        (segment) =>
          segment.text.toLowerCase().includes(normalizedFilter) ||
          (segment.translation?.toLowerCase().includes(normalizedFilter) ?? false) ||
          segment.speakerLabel.toLowerCase().includes(normalizedFilter),
      )
    : segments;
  const activeInterims = Object.entries(interims).filter(([, item]) => item.text.trim());
  const progressPercent =
    total && completed !== undefined ? Math.min(100, Math.round((completed / total) * 100)) : null;

  return (
    <section className="transcript-section">
      <div className="section-head">
        <div className="section-title-group">
          <div className="eyebrow">TRANSCRIPT FEED</div>
          <div className="section-title-row">
            <h2>逐字稿</h2>
            <span className="pill-count">{segments.length} 段</span>
            {isBilingual && <span className="pill-tag">雙語同步</span>}
          </div>
        </div>
        <div className="section-actions">
          {segments.length > 0 && (
            <>
              <button
                type="button"
                className="secondary small-button"
                onClick={() => downloadTranscript('md', segments, meetingTitle)}
              >
                <IconDownload size={14} />
                <span>.md</span>
              </button>
              <button
                type="button"
                className="secondary small-button"
                onClick={() => downloadTranscript('txt', segments, meetingTitle)}
              >
                <IconDownload size={14} />
                <span>.txt</span>
              </button>
            </>
          )}
          <button
            type="button"
            className="secondary small-button"
            disabled={busy || locked}
            onClick={() => {
              setUploadError('');
              openDialogModal(dialog.current);
            }}
          >
            <IconUpload size={14} />
            <span>上傳音檔</span>
          </button>
        </div>
      </div>

      <dialog
        ref={dialog}
        className="upload-dialog"
        aria-labelledby="upload-title"
        {...({ closedby: busy ? 'none' : 'any' } as HTMLAttributes<HTMLDialogElement>)}
        onCancel={(event) => {
          event.preventDefault();
          if (busy) {
            abort.current?.abort();
          } else {
            void closeDialogAnimated(dialog.current);
          }
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
        <div className="dialog-header">
          <div>
            <div className="eyebrow">AUDIO TRANSCRIPTION</div>
            <h2 id="upload-title">上傳音檔轉錄</h2>
          </div>
          <button
            type="button"
            className="close"
            aria-label="關閉上傳視窗"
            disabled={busy}
            onClick={() => void closeDialogAnimated(dialog.current)}
          >
            <IconX size={18} />
          </button>
        </div>
        <p className="hint">
          音檔會先保存於此瀏覽器，再傳送至選定的轉錄服務。超過 23 MiB 的音檔將自動切分處理。
        </p>
        <div
          className={`drop-zone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
        >
          <div className="drop-icon" aria-hidden="true">
            <IconFileText size={22} />
          </div>
          {file ? (
            <div className="selected-file-card">
              <div>
                <strong>{file.name}</strong>
                <small>{(file.size / 1024 / 1024).toFixed(1)} MB · 已準備轉錄</small>
              </div>
              {!busy && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="移除已選音檔"
                  onClick={() => {
                    uploadProgress.current = null;
                    setFile(null);
                    if (input.current) input.current.value = '';
                  }}
                >
                  <IconX size={15} />
                </button>
              )}
            </div>
          ) : (
            <>
              <strong>將音檔拖放至此處</strong>
              <small>支援 WAV、MP3、M4A、WebM、OGG、FLAC、AAC</small>
            </>
          )}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {file ? '更換音檔' : '選擇音檔'}
          </button>
          <input
            ref={input}
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.webm,.ogg,.flac,.aac"
            hidden
            onChange={(event) => choose(event.target.files?.[0])}
          />
        </div>
        {busy && (
          <div className="progress-block">
            <progress aria-label="音檔轉錄進度" max={total} value={completed} />
            {progressPercent !== null && (
              <span className="progress-percent">{progressPercent}%</span>
            )}
          </div>
        )}
        {progress && (
          <p className="hint status-feedback" role="status">
            {progress}
          </p>
        )}
        {uploadError && (
          <p className="error" role="alert">
            <IconAlertCircle size={15} />
            <span>{uploadError}</span>
          </p>
        )}
        <div className="dialog-actions">
          {busy ? (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                abort.current?.abort();
                setProgress('正在停止…');
              }}
            >
              停止轉錄
            </button>
          ) : (
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => void closeDialogAnimated(dialog.current)}
              >
                關閉
              </button>
              <button
                type="button"
                className="record"
                disabled={!file}
                onClick={() => void upload()}
              >
                開始轉錄
              </button>
            </>
          )}
        </div>
      </dialog>

      <div className="card transcript-card">
        {editError && (
          <p className="error transcript-inline-error" role="alert">
            <IconAlertCircle size={15} />
            <span>{editError}</span>
          </p>
        )}

        {segments.length > 5 && (
          <div className="transcript-filter-bar">
            <label className="search compact-search">
              <IconSearch size={14} />
              <input
                value={filterQuery}
                onChange={(event) => setFilterQuery(event.target.value)}
                placeholder="搜尋逐字稿或譯文…"
                aria-label="搜尋逐字稿"
              />
              {filterQuery && (
                <button
                  type="button"
                  className="search-clear"
                  aria-label="清除搜尋"
                  onClick={() => setFilterQuery('')}
                >
                  <IconX size={13} />
                </button>
              )}
            </label>
          </div>
        )}

        {visibleSegments.length > 0 || activeInterims.length > 0 ? (
          <div className="segment-list">
            {visibleSegments.map((segment) => (
              <article key={segment.id} className="segment">
                <div className="segment-meta">
                  <span
                    className={`segment-badge ${
                      segment.track === 'mic'
                        ? 'mic'
                        : segment.track === 'system'
                          ? 'system'
                          : 'upload'
                    }`}
                  >
                    {segment.speakerLabel}
                  </span>
                  {segment.recordingId ? (
                    <button
                      type="button"
                      className="seek"
                      aria-label={`從 ${formatTimestamp(segment.startedAtMs)} 播放錄音`}
                      onClick={() => onSeek(segment.recordingId!, segment.startedAtMs / 1000)}
                    >
                      <IconPlay size={11} />
                      <span>{formatTimestamp(segment.startedAtMs)}</span>
                    </button>
                  ) : (
                    <span className="segment-time">{formatTimestamp(segment.startedAtMs)}</span>
                  )}
                  {segment.timeIsChunkStart && <span className="chunk-note">片段起點</span>}
                  {!segment.isFinal && <span className="chunk-note">恢復的未定稿</span>}
                </div>
                <textarea
                  className="segment-editor"
                  aria-label={`${segment.speakerLabel}逐字稿`}
                  disabled={busy || locked}
                  value={segment.text}
                  onChange={(event) => edit(segment, event.target.value)}
                />
                {segment.translation && (
                  <p className="translation">
                    {segment.translationIsFinal === false && (
                      <span className="chunk-note">未完成譯文：</span>
                    )}
                    {segment.translation}
                  </p>
                )}
              </article>
            ))}

            {activeInterims.map(([id, item]) => (
              <article key={id} className="segment interim-segment" aria-live="polite">
                <div className="segment-meta">
                  <span className={`segment-badge ${item.track === 'mic' ? 'mic' : 'system'}`}>
                    {item.track === 'mic' ? '我方' : '對方'}
                  </span>
                  <span className="interim-pill">
                    <span className="pulse-dot" aria-hidden="true" />
                    辨識中
                  </span>
                </div>
                <p className="interim-text">{item.text}</p>
              </article>
            ))}
          </div>
        ) : normalizedFilter ? (
          <div className="panel-empty">
            <p>找不到符合「{filterQuery}」的逐字稿內容。</p>
            <button type="button" className="secondary" onClick={() => setFilterQuery('')}>
              顯示全部段落
            </button>
          </div>
        ) : (
          <div className="panel-empty">
            <div className="panel-empty-icon" aria-hidden="true">
              <IconMessageSquare size={22} />
            </div>
            <h3>尚無逐字稿內容</h3>
            <p>點擊上方「開始錄音」進行即時轉錄，或匯入既有音訊檔自動生成逐字稿。</p>
            <button
              type="button"
              className="secondary"
              disabled={busy || locked}
              onClick={() => {
                setUploadError('');
                openDialogModal(dialog.current);
              }}
            >
              <IconUpload size={15} />
              <span>上傳音檔轉錄</span>
            </button>
          </div>
        )}
      </div>
    </section>
  );
});
