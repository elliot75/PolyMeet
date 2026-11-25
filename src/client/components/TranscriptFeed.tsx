import { formatSpeakerLabel } from '../i18n/format';
import { useI18n, message, type LocalizedMessage } from '../i18n/preferences';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type HTMLAttributes,
} from 'react';
import type { AudioTrackRole, TranscriptSegment, UsageSessionKind } from '../../shared/types';
import { normalizeAudioMime } from '../audio/audioMime';
import {
  deleteInterimSegment,
  finalizeSegment,
  listSegments,
  MAX_SPEAKER_LABEL_LENGTH,
  normalizeMeetingQuery,
  renameSegmentSpeaker,
  saveRecordingSegments,
  saveUploadedRecording,
  type Recording,
} from '../db/meetingDb';
import { downloadTranscript, formatTimestamp } from '../services/exporter';
import {
  recordingFilename,
  transcribeAudio,
  transcribeSavedRecording,
} from '../services/fileTranscription';
import type { Settings } from '../services/settings';
import type { EditSaveQueue } from '../services/editSaveQueue';
import { needsTranslation } from '../services/translationQueue';
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
  recordings: Recording[];
  playableRecordingIds: ReadonlySet<string> | null | undefined;
  interims: Record<string, { track: AudioTrackRole; text: string }>;
  recordingToTranscribe: Recording | null;
  translating: ReadonlyMap<string, Promise<void>>;
  onAppend: (
    recording: Recording,
    segments: TranscriptSegment[],
    previous?: TranscriptSegment[],
  ) => void;
  onCloseRecordingTranscription: () => void;
  onTranslate: (segments: TranscriptSegment[]) => void;
  onTextChange: (id: string, text: string) => void;
  onFinalizeSegment: (segment: TranscriptSegment) => void;
  onDeleteSegment: (id: string) => void;
  onSpeakerChange: (meetingId: string, ids: string[], name: string) => void;
  onRecordingSaved: () => void;
  onBusyChange: (busy: boolean) => void;
  onSeek: (recordingId: string, seconds: number) => void;
  onUsageSessionCompleted?: (info: {
    usageSessionId: string;
    meetingId: string;
    meetingTitle: string;
    kind: UsageSessionKind;
    startedAt: number;
    endedAt: number;
    durationSeconds: number;
  }) => void | Promise<void>;
  onUsageActivity?: (meetingId: string) => void | Promise<void>;
  editSaves: EditSaveQueue<{ id: string; meetingId: string; text: string }>;
  settings: Settings;
  locked?: boolean;
}

function normalizeAudio(file: File): File {
  const mime = normalizeAudioMime(file.type, file.name);
  if (!mime) throw new Error('請選擇可支援的音訊檔案。');
  return mime === file.type
    ? file
    : new File([file], file.name, { type: mime, lastModified: file.lastModified });
}

export const TranscriptFeed = memo(function TranscriptFeed({
  meetingId,
  meetingTitle,
  isBilingual,
  languageHints,
  segments,
  recordings,
  playableRecordingIds,
  interims,
  recordingToTranscribe,
  translating,
  onAppend,
  onCloseRecordingTranscription,
  onTranslate,
  onTextChange,
  onFinalizeSegment,
  onDeleteSegment,
  onSpeakerChange,
  onRecordingSaved,
  onBusyChange,
  onSeek,
  onUsageSessionCompleted,
  onUsageActivity,
  editSaves,
  settings,
  locked = false,
}: Props) {
  const { t, localize } = useI18n();
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [existingSegments, setExistingSegments] = useState<TranscriptSegment[] | null>(null);
  const [recordingMode, setRecordingMode] = useState<'' | 'append' | 'replace'>('');
  const [recordingDone, setRecordingDone] = useState(false);
  const [progress, setProgress] = useState<LocalizedMessage>('');
  const [completed, setCompleted] = useState<number | undefined>();
  const [total, setTotal] = useState<number | undefined>();
  const [uploadError, setUploadError] = useState('');
  const [editError, setEditError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [renameTarget, setRenameTarget] = useState<TranscriptSegment | null>(null);
  const [speakerName, setSpeakerName] = useState('');
  const [renameAll, setRenameAll] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [renameStatus, setRenameStatus] = useState<LocalizedMessage>('');
  const renameId = useId();
  const renameDialog = useRef<HTMLDialogElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const speakerNameInput = useRef<HTMLInputElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const uploadProgress = useRef<{ recording: Recording; saved: boolean; completed: number } | null>(
    null,
  );
  const pressedOutside = useRef(false);
  const renamePressedOutside = useRef(false);
  const [draftAction, setDraftAction] = useState<string | null>(null);

  const flushEdits = useCallback(
    () => editSaves.flush((edit) => edit.meetingId === meetingId),
    [editSaves, meetingId],
  );

  useEffect(
    () => () => {
      void flushEdits();
    },
    [flushEdits],
  );

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (dialog.current?.open) (busy ? stopButton : closeButton).current?.focus();
  }, [busy]);

  useEffect(() => {
    if (!recordingToTranscribe) return;
    let active = true;
    setExistingSegments(null);
    setRecordingMode('');
    setRecordingDone(false);
    setUploadError('');
    setProgress('');
    openDialogModal(dialog.current);
    void flushEdits()
      .then((saved) => {
        if (!saved) throw new Error('transcript edits are pending');
        return listSegments(meetingId);
      })
      .then((items) => {
        if (active)
          setExistingSegments(
            items.filter((item) => item.recordingId === recordingToTranscribe.id),
          );
      })
      .catch(() => {
        if (active) setUploadError('無法讀取現有逐字稿，請關閉視窗後重試。');
      });
    return () => {
      active = false;
    };
  }, [meetingId, recordingToTranscribe, flushEdits]);

  useEffect(() => {
    if (renameTarget) {
      openDialogModal(renameDialog.current);
      speakerNameInput.current?.focus();
      speakerNameInput.current?.select();
    }
  }, [renameTarget]);

  async function saveSpeakerName() {
    const name = speakerName.trim();
    if (!renameTarget || !name || name === renameTarget.speakerLabel || renaming || busy || locked)
      return;
    setRenaming(true);
    setRenameError('');
    try {
      const ids = await renameSegmentSpeaker(renameTarget, name, renameAll ? 'speaker' : 'segment');
      onSpeakerChange(meetingId, ids, name);
      setRenameStatus(message('已更新 {1} 段逐字稿的語者名稱。', ids.length));
      await closeDialogAnimated(renameDialog.current);
    } catch {
      setRenameError('無法儲存語者名稱。若逐字稿已在其他分頁修改，請重新載入後再試。');
    } finally {
      setRenaming(false);
    }
  }

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

  const needsRecordingMode = Boolean(existingSegments?.length);
  const canTranscribeRecording =
    existingSegments !== null && !recordingDone && (!needsRecordingMode || recordingMode !== '');

  async function transcribe() {
    const savedRecording = recordingToTranscribe;
    if (abort.current || locked || (savedRecording ? !canTranscribeRecording : !file)) return;
    const controller = new AbortController();
    const { signal } = controller;
    abort.current = controller;
    setBusy(true);
    onBusyChange(true);
    setUploadError('');
    setCompleted(undefined);
    setTotal(undefined);
    setProgress(savedRecording ? '正在讀取錄音…' : '正在保存及準備音檔…');
    const usageSessionId = crypto.randomUUID();
    const startedAt = Date.now();
    let partsStarted = 0;
    let partsCompleted = 0;
    const options = {
      settings,
      languageHints,
      signal,
      meetingTitle: meetingTitle || '未命名會議',
      usageSessionId,
      onPartStart(index: number, total: number) {
        partsStarted += 1;
        setTotal(total);
        setCompleted(index - 1);
        setProgress(message('正在轉錄第 {1} / {2} 段…', index, total));
      },
      onPartComplete(index: number, cleanupWarning: boolean) {
        partsCompleted += 1;
        if (cleanupWarning) setUploadError('無法刪除 Google 暫存檔，請至供應商管理介面檢查。');
        setCompleted(index);
      },
    };
    try {
      if (savedRecording) {
        const previous = recordingMode === 'append' ? undefined : (existingSegments ?? []);
        const added = await transcribeSavedRecording(
          { ...options, recording: savedRecording },
          previous,
        );
        if (added.length) onAppend(savedRecording, added, previous);
        setRecordingDone(true);
        setProgress(added.length ? '轉錄完成，逐字稿已保存。' : '未辨識出語音，現有逐字稿已保留。');
        const endedAt = Date.now();
        await onUsageSessionCompleted?.({
          usageSessionId,
          meetingId,
          meetingTitle: meetingTitle || '未命名會議',
          kind: 'file_transcription',
          startedAt,
          endedAt,
          durationSeconds: Math.max(0, (endedAt - startedAt) / 1000),
        });
      } else if (file) {
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
        if (!upload.saved) {
          await saveUploadedRecording(upload.recording, file);
          upload.saved = true;
          onRecordingSaved();
        }
        for await (const part of transcribeAudio(
          file,
          { ...options, recording: upload.recording },
          upload.completed,
        )) {
          await saveRecordingSegments(upload.recording, part.segments, undefined, signal);
          upload.completed = part.index;
          if (part.segments.length) onAppend(upload.recording, part.segments);
          options.onPartComplete(part.index, part.cleanupWarning);
        }
        uploadProgress.current = null;
        setProgress('轉錄完成，音檔與辨識出的逐字稿已保存。');
        setFile(null);
        const endedAt = Date.now();
        await onUsageSessionCompleted?.({
          usageSessionId,
          meetingId,
          meetingTitle: meetingTitle || '未命名會議',
          kind: 'file_transcription',
          startedAt,
          endedAt,
          durationSeconds: Math.max(0, (endedAt - startedAt) / 1000),
        });
      }
    } catch (e) {
      if (!signal.aborted) setUploadError(e instanceof Error ? e.message : '無法處理此音檔。');
      const retained = savedRecording ? '現有錄音與逐字稿已保留。' : '已保存的音檔與片段會保留。';
      setProgress(signal.aborted ? message('已停止轉錄，{1}', message(retained)) : retained);
      if (partsCompleted > 0) {
        const endedAt = Date.now();
        await onUsageSessionCompleted?.({
          usageSessionId,
          meetingId,
          meetingTitle: meetingTitle || '未命名會議',
          kind: 'file_transcription',
          startedAt,
          endedAt,
          durationSeconds: Math.max(0, (endedAt - startedAt) / 1000),
        });
      } else if (partsStarted > 0) {
        void onUsageActivity?.(meetingId);
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
    editSaves.schedule(segment.id, { id: segment.id, meetingId, text }, 250, (saved) => {
      const message = '無法保存逐字稿修改，請檢查瀏覽器儲存空間。';
      setEditError((error) => (saved ? (error === message ? '' : error) : message));
    });
  }

  async function handleFinalize(segment: TranscriptSegment) {
    if (busy || locked || draftAction) return;
    setDraftAction(segment.id);
    setEditError('');
    try {
      if (!(await editSaves.flush((edit) => edit.id === segment.id))) {
        setEditError('無法保存此段修改，請檢查瀏覽器儲存空間後再確認定稿。');
        return;
      }
      const updated = await finalizeSegment(segment.id);
      if (updated) onFinalizeSegment(updated);
    } catch {
      setEditError('無法將逐字稿確認為定稿，請重試。');
    } finally {
      setDraftAction(null);
    }
  }

  async function handleDelete(id: string) {
    if (busy || locked || draftAction) return;
    setDraftAction(id);
    setEditError('');
    try {
      if (await deleteInterimSegment(id)) {
        editSaves.discard(id);
        onDeleteSegment(id);
      } else {
        setEditError('此段落已變更，請重新載入後再試。');
      }
    } catch {
      setEditError('無法刪除逐字稿段落，請重試。');
    } finally {
      setDraftAction(null);
    }
  }

  async function translate(items: TranscriptSegment[]) {
    const ids = new Set(items.map(({ id }) => id));
    if (await editSaves.flush((edit) => ids.has(edit.id))) onTranslate(items);
    else setEditError('無法保存待翻譯的段落，請檢查瀏覽器儲存空間後重試。');
  }

  const untranslated = isBilingual
    ? segments.filter((segment) => needsTranslation(segment) && !translating.has(segment.id))
    : [];

  const normalizedFilter = normalizeMeetingQuery(filterQuery);
  const visibleSegments = normalizedFilter
    ? segments.filter(
        (segment) =>
          normalizeMeetingQuery(segment.text).includes(normalizedFilter) ||
          (segment.translation
            ? normalizeMeetingQuery(segment.translation).includes(normalizedFilter)
            : false) ||
          normalizeMeetingQuery(segment.speakerLabel).includes(normalizedFilter) ||
          normalizeMeetingQuery(formatSpeakerLabel(t, segment.speakerLabel)).includes(
            normalizedFilter,
          ),
      )
    : segments;
  const activeInterims = Object.entries(interims).filter(([, item]) => item.text.trim());
  const progressPercent =
    total && completed !== undefined ? Math.min(100, Math.round((completed / total) * 100)) : null;

  return (
    <section className="transcript-section">
      <div className="section-head">
        <div className="section-title-group">
          <div className="section-title-row">
            <h2>{t('逐字稿')}</h2>
            <span className="pill-count">{t('{1} 段', segments.length)}</span>
            {isBilingual && <span className="pill-tag">{t('雙語同步')}</span>}
          </div>
        </div>
        <div className="section-actions">
          {isBilingual && (
            <button
              type="button"
              className="secondary small-button"
              disabled={busy || locked || untranslated.length === 0}
              onClick={() => translate(untranslated)}
            >
              {t('補齊未譯段落')}
            </button>
          )}
          {segments.length > 0 &&
            (['md', 'txt', 'srt', 'vtt'] as const).map((format) => (
              <button
                key={format}
                type="button"
                className="secondary small-button"
                aria-label={t(
                  '匯出 {1} {2}',
                  format.toUpperCase(),
                  format === 'srt' || format === 'vtt' ? t('字幕') : t('逐字稿'),
                )}
                onClick={() => downloadTranscript(format, segments, meetingTitle, recordings)}
              >
                <IconDownload size={14} />
                <span>.{format}</span>
              </button>
            ))}
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
            <span>{t('上傳音檔')}</span>
          </button>
        </div>
      </div>

      <dialog
        ref={dialog}
        className="upload-dialog"
        aria-labelledby="upload-title"
        {...({ closedby: busy ? 'closerequest' : 'any' } as HTMLAttributes<HTMLDialogElement>)}
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
          if (recordingToTranscribe) {
            setProgress('');
            onCloseRecordingTranscription();
          }
        }}
      >
        <div className="dialog-header">
          <div>
            <div className="eyebrow">{t('音檔轉錄')}</div>
            <h2 id="upload-title">
              {recordingToTranscribe ? t('轉錄已存錄音') : t('上傳音檔轉錄')}
            </h2>
          </div>
          <button
            type="button"
            className="close"
            aria-label={t('關閉轉錄視窗')}
            disabled={busy}
            onClick={() => void closeDialogAnimated(dialog.current)}
          >
            <IconX size={18} />
          </button>
        </div>
        <p className="hint">
          {recordingToTranscribe
            ? t('此錄音的音訊會傳送至選定的轉錄服務，逐字稿會儲存到原錄音。')
            : t(
                '音檔會先保存於此瀏覽器，再傳送至選定的轉錄服務。超過 23 MiB 的音檔將自動切分處理。',
              )}
        </p>
        {recordingToTranscribe ? (
          <>
            <p className="recording-filename">{recordingFilename(recordingToTranscribe)}</p>
            {existingSegments === null && !uploadError && (
              <p className="hint" role="status">
                {t('正在檢查現有逐字稿…')}
              </p>
            )}
            {needsRecordingMode && !recordingDone && (
              <fieldset className="recording-transcript-options" disabled={busy}>
                <legend>{t('已有 {1} 段逐字稿', existingSegments?.length)}</legend>
                <label>
                  <input
                    type="radio"
                    name="recording-transcript-mode"
                    checked={recordingMode === 'append'}
                    onChange={() => setRecordingMode('append')}
                  />
                  {t('保留現有逐字稿並附加新段落（可能出現重複內容）')}
                </label>
                <label>
                  <input
                    type="radio"
                    name="recording-transcript-mode"
                    checked={recordingMode === 'replace'}
                    onChange={() => setRecordingMode('replace')}
                  />
                  {t('轉錄成功後覆蓋此錄音的逐字稿與譯文')}
                </label>
              </fieldset>
            )}
          </>
        ) : (
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
                  <small>{t('{1} MB · 已準備轉錄', (file.size / 1024 / 1024).toFixed(1))}</small>
                </div>
                {!busy && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t('移除已選音檔')}
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
                <strong>{t('將音檔拖放至此處')}</strong>
                <small>{t('支援 WAV、MP3、M4A、WebM、OGG、FLAC、AAC')}</small>
              </>
            )}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              {file ? t('更換音檔') : t('選擇音檔')}
            </button>
            <input
              ref={input}
              type="file"
              accept="audio/*,.wav,.mp3,.m4a,.webm,.ogg,.flac,.aac"
              hidden
              onChange={(event) => choose(event.target.files?.[0])}
            />
          </div>
        )}
        {busy && (
          <div className="progress-block">
            <progress aria-label={t('音檔轉錄進度')} max={total} value={completed} />
            {progressPercent !== null && (
              <span className="progress-percent">{progressPercent}%</span>
            )}
          </div>
        )}
        {progress && (
          <p className="hint status-feedback" role="status">
            {localize(progress)}
          </p>
        )}
        {uploadError && (
          <p className="error" role="alert">
            <IconAlertCircle size={15} />
            <span>{localize(uploadError)}</span>
          </p>
        )}
        <div className="dialog-actions">
          {busy ? (
            <button
              ref={stopButton}
              type="button"
              className="secondary"
              onClick={() => {
                abort.current?.abort();
                setProgress('正在停止…');
              }}
            >
              {t('停止轉錄')}
            </button>
          ) : (
            <>
              <button
                ref={closeButton}
                type="button"
                className="secondary"
                onClick={() => void closeDialogAnimated(dialog.current)}
              >
                {t('關閉')}
              </button>
              {!recordingDone || !recordingToTranscribe ? (
                <button
                  type="button"
                  className="record"
                  disabled={locked || (recordingToTranscribe ? !canTranscribeRecording : !file)}
                  onClick={() => void transcribe()}
                >
                  {t('開始轉錄')}
                </button>
              ) : null}
            </>
          )}
        </div>
      </dialog>

      <dialog
        ref={renameDialog}
        className="speaker-dialog"
        aria-labelledby={`${renameId}-title`}
        {...({ closedby: renaming ? 'none' : 'any' } as HTMLAttributes<HTMLDialogElement>)}
        onCancel={(event) => {
          event.preventDefault();
          if (!renaming) void closeDialogAnimated(renameDialog.current);
        }}
        onPointerDown={(event) => {
          if (!renaming && !('closedBy' in HTMLDialogElement.prototype) && renameDialog.current) {
            renamePressedOutside.current = isPointerOutsideDialog(event, renameDialog.current);
          }
        }}
        onPointerUp={(event) => {
          if (
            !renaming &&
            !('closedBy' in HTMLDialogElement.prototype) &&
            renamePressedOutside.current &&
            renameDialog.current &&
            isPointerOutsideDialog(event, renameDialog.current)
          ) {
            void closeDialogAnimated(renameDialog.current);
          }
          renamePressedOutside.current = false;
        }}
        onClose={() => {
          setRenameTarget(null);
          (renameButton.current?.isConnected ? renameButton.current : filterInput.current)?.focus();
          renameButton.current = null;
        }}
      >
        <div className="dialog-header">
          <h2 id={`${renameId}-title`}>{t('更名語者')}</h2>
          <button
            type="button"
            className="close"
            aria-label={t('關閉更名視窗')}
            disabled={renaming}
            onClick={() => void closeDialogAnimated(renameDialog.current)}
          >
            <IconX size={18} />
          </button>
        </div>
        <form
          className="speaker-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveSpeakerName();
          }}
        >
          <label htmlFor={`${renameId}-name`}>{t('語者名稱')}</label>
          <input
            id={`${renameId}-name`}
            ref={speakerNameInput}
            required
            maxLength={MAX_SPEAKER_LABEL_LENGTH}
            readOnly={renaming}
            value={speakerName}
            onChange={(event) => setSpeakerName(event.target.value)}
          />
          <label className="speaker-scope">
            <input
              type="checkbox"
              checked={renameAll}
              disabled={renaming}
              onChange={(event) => setRenameAll(event.target.checked)}
            />
            <span>
              {renameTarget?.speakerGroup
                ? t('一併更名同一批轉錄中語者標籤相同的段落')
                : renameTarget?.recordingId
                  ? t('一併更名此錄音中具有相同語者標籤的段落')
                  : t('一併更名此會議中未連結錄音、且語者標籤相同的段落')}
            </span>
          </label>
          {renameError && (
            <p className="error" role="alert">
              {localize(renameError)}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary"
              disabled={renaming}
              onClick={() => void closeDialogAnimated(renameDialog.current)}
            >
              {t('取消')}
            </button>
            <button
              type="submit"
              className="record"
              disabled={
                renaming ||
                busy ||
                locked ||
                !speakerName.trim() ||
                speakerName.trim() === renameTarget?.speakerLabel
              }
            >
              {renaming ? t('正在儲存…') : t('儲存名稱')}
            </button>
          </div>
        </form>
      </dialog>

      <div className="card transcript-card">
        {translating.size > 0 && (
          <p className="hint transcript-inline-error" role="status">
            {t('正在翻譯 {1} 段逐字稿…', translating.size)}
          </p>
        )}
        <div role="status">
          {renameStatus && <p className="hint transcript-inline-error">{localize(renameStatus)}</p>}
        </div>
        {editError && (
          <p className="error transcript-inline-error" role="alert">
            <IconAlertCircle size={15} />
            <span>{localize(editError)}</span>
          </p>
        )}

        {segments.length > 5 && (
          <div className="transcript-filter-bar">
            <label className="search compact-search">
              <IconSearch size={14} />
              <input
                ref={filterInput}
                value={filterQuery}
                onChange={(event) => setFilterQuery(event.target.value)}
                placeholder={t('搜尋逐字稿或譯文…')}
                aria-label={t('搜尋逐字稿')}
              />
              {filterQuery && (
                <button
                  type="button"
                  className="search-clear"
                  aria-label={t('清除搜尋')}
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
                    {formatSpeakerLabel(t, segment.speakerLabel)}
                  </span>
                  <button
                    type="button"
                    className="speaker-rename"
                    aria-label={t(
                      '更名 {1}（{2}）',
                      formatSpeakerLabel(t, segment.speakerLabel),
                      formatTimestamp(segment.startedAtMs),
                    )}
                    aria-haspopup="dialog"
                    disabled={busy || locked}
                    onClick={(event) => {
                      renameButton.current = event.currentTarget;
                      setSpeakerName(segment.speakerLabel);
                      setRenameAll(false);
                      setRenameError('');
                      setRenameStatus('');
                      setRenameTarget(segment);
                    }}
                  >
                    {t('更名')}
                  </button>
                  {segment.recordingId && playableRecordingIds?.has(segment.recordingId) ? (
                    <button
                      type="button"
                      className="seek"
                      aria-label={t('從 {1} 播放錄音', formatTimestamp(segment.startedAtMs))}
                      onClick={() => onSeek(segment.recordingId!, segment.startedAtMs / 1000)}
                    >
                      <IconPlay size={11} />
                      <span>{formatTimestamp(segment.startedAtMs)}</span>
                    </button>
                  ) : (
                    <span className="segment-time">{formatTimestamp(segment.startedAtMs)}</span>
                  )}
                  {segment.timeIsChunkStart && <span className="chunk-note">{t('片段起點')}</span>}
                  {!segment.isFinal && (
                    <>
                      <span className="chunk-note">{t('恢復的未定稿')}</span>
                      <button
                        type="button"
                        className="secondary small-button"
                        disabled={busy || locked || !!draftAction || !segment.text.trim()}
                        onClick={() => void handleFinalize(segment)}
                      >
                        {t('確認定稿')}
                      </button>
                      <button
                        type="button"
                        className="secondary small-button"
                        disabled={busy || locked || !!draftAction}
                        onClick={() => void handleDelete(segment.id)}
                      >
                        {t('刪除')}
                      </button>
                    </>
                  )}
                  {isBilingual && segment.isFinal && (
                    <button
                      className="secondary small-button"
                      type="button"
                      disabled={
                        busy || locked || translating.has(segment.id) || !segment.text.trim()
                      }
                      onClick={() => translate([segment])}
                    >
                      {t('重新翻譯')}
                    </button>
                  )}
                </div>
                <textarea
                  className="segment-editor"
                  aria-label={t('{1}逐字稿', formatSpeakerLabel(t, segment.speakerLabel))}
                  disabled={busy || locked || draftAction === segment.id}
                  value={segment.text}
                  onChange={(event) => edit(segment, event.target.value)}
                />
                {segment.translation && (
                  <p className="translation">
                    {segment.translationIsFinal === false && (
                      <span className="chunk-note">{t('未完成譯文：')}</span>
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
                    {item.track === 'mic' ? t('我方') : t('對方')}
                  </span>
                  <span className="interim-pill">
                    <span className="pulse-dot" aria-hidden="true" />
                    {t('辨識中')}
                  </span>
                </div>
                <p className="interim-text">{item.text}</p>
              </article>
            ))}
          </div>
        ) : normalizedFilter ? (
          <div className="panel-empty">
            <p>{t('找不到符合「{1}」的逐字稿內容。', filterQuery)}</p>
            <button type="button" className="secondary" onClick={() => setFilterQuery('')}>
              {t('顯示全部段落')}
            </button>
          </div>
        ) : (
          <div className="panel-empty">
            <div className="panel-empty-icon" aria-hidden="true">
              <IconMessageSquare size={22} />
            </div>
            <h3>{t('尚無逐字稿內容')}</h3>
            <p>{t('點擊上方「開始錄音」進行即時轉錄，或匯入既有音訊檔自動生成逐字稿。')}</p>
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
              <span>{t('上傳音檔轉錄')}</span>
            </button>
          </div>
        )}
      </div>
    </section>
  );
});
