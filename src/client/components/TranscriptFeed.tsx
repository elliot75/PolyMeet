import { useRef, useState, type DragEvent, type PointerEvent } from 'react';
import { splitAudio } from '../audio/audioChunker';
import { saveAudioChunk, saveRecording, saveSegment, updateSegmentText } from '../db/meetingDb';
import { headers, type Settings } from '../services/settings';
import type { TranscriptSegment } from '../../shared/types';

interface Props {
  meetingId: string;
  languageHints: string[];
  segments: TranscriptSegment[];
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
export function TranscriptFeed({
  meetingId,
  languageHints,
  segments,
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
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const pressedOutside = useRef(false);
  function choose(next: File | undefined) {
    if (!next || busy) return;
    try {
      setFile(normalizeAudio(next));
      setError('');
      setProgress('');
      setCompleted(undefined);
      setTotal(undefined);
    } catch (e) {
      setFile(null);
      setError(e instanceof Error ? e.message : '無法讀取音檔。');
    }
  }
  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    choose(event.dataTransfer.files[0]);
  }
  function outside(event: PointerEvent<HTMLDialogElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    );
  }
  async function upload() {
    if (!file || busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    onBusyChange(true);
    setError('');
    setProgress('正在保存及準備音檔…');
    setCompleted(undefined);
    setTotal(undefined);
    const recording = {
      id: crypto.randomUUID(),
      meetingId,
      createdAt: Date.now(),
      mimeType: file.type,
      filename: file.name,
      completed: false,
    };
    try {
      await saveRecording(recording);
      await saveAudioChunk(recording.id, 0, file);
      await saveRecording({ ...recording, completed: true });
      onRecordingSaved();
      if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      for await (const part of splitAudio(file)) {
        if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
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
        const items: { text: string; startSeconds: number; endSeconds?: number }[] = Array.isArray(
          result.segments,
        )
          ? result.segments
          : result.text?.trim()
            ? [{ text: result.text.trim(), startSeconds: 0 }]
            : [];
        for (const item of items) {
          const segment: TranscriptSegment = {
            id: crypto.randomUUID(),
            meetingId,
            recordingId: recording.id,
            track: 'upload',
            speakerLabel: '音檔',
            startedAtMs: part.offsetMs + item.startSeconds * 1000,
            timeIsChunkStart: !Array.isArray(result.segments),
            endedAtMs:
              item.endSeconds === undefined ? undefined : part.offsetMs + item.endSeconds * 1000,
            text: item.text,
            isFinal: true,
          };
          await saveSegment(segment);
          onAppend(segment);
        }
        if (result.cleanupWarning)
          setError('轉錄完成，但無法刪除 Google 暫存檔，請至供應商管理介面檢查。');
        setCompleted(part.index);
      }
      setProgress('轉錄完成，音檔與逐字稿已保存。');
      setFile(null);
    } catch (e) {
      if (controller.signal.aborted) setProgress('已停止轉錄，已保存的音檔與片段可繼續使用。');
      else {
        setError(e instanceof Error ? e.message : '無法處理此音檔。');
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
    onTextChange(segment.id, text);
    writes.current = writes.current
      .catch(() => {})
      .then(() => updateSegmentText(segment.id, text))
      .catch(() => {
        setError('無法保存逐字稿修改。');
      });
  }
  return (
    <section>
      <div className="section-head">
        <div>
          <div className="eyebrow">TRANSCRIPT</div>
          <h2>逐字稿</h2>
        </div>
        <button
          className="secondary"
          disabled={busy || locked}
          onClick={() => {
            setError('');
            dialog.current?.showModal();
          }}
        >
          上傳音檔轉錄
        </button>
      </div>
      <dialog
        ref={dialog}
        aria-labelledby="upload-title"
        {...({ closedby: busy ? 'none' : 'any' } as React.HTMLAttributes<HTMLDialogElement>)}
        onCancel={(event) => {
          if (busy) {
            event.preventDefault();
            abort.current?.abort();
          }
        }}
        onPointerDown={(event) => {
          if (!busy && !('closedBy' in HTMLDialogElement.prototype))
            pressedOutside.current = outside(event);
        }}
        onPointerUp={(event) => {
          if (
            !busy &&
            !('closedBy' in HTMLDialogElement.prototype) &&
            pressedOutside.current &&
            outside(event)
          )
            dialog.current?.close();
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
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </div>
        <p className="hint">音檔會先保存在此瀏覽器，再傳送至選定的轉錄服務。大型音檔會自動分段。</p>
        <div
          className={`drop-zone ${dragging ? 'dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
        >
          <span aria-hidden="true">♫</span>
          <strong>{file ? file.name : '將音檔拖放至此'}</strong>
          <small>
            {file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : '或選擇瀏覽器支援的音訊檔案'}
          </small>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            選擇音檔
          </button>
          <input
            ref={input}
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.webm,.ogg,.flac,.aac"
            hidden
            onChange={(event) => choose(event.target.files?.[0])}
          />
        </div>
        {busy && <progress aria-label="音檔轉錄進度" max={total} value={completed} />}
        {progress && (
          <p className="hint" role="status">
            {progress}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          {busy ? (
            <button
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
              <button className="secondary" onClick={() => dialog.current?.close()}>
                關閉
              </button>
              <button className="record" disabled={!file} onClick={() => void upload()}>
                開始轉錄
              </button>
            </>
          )}
        </div>
      </dialog>
      <div className="card transcript-card">
        <p className="hint">逐字稿保存在此瀏覽器，並可用於生成會議紀錄。</p>
        {segments.length ? (
          segments.map((segment) => (
            <div key={segment.id} className="segment">
              <span className="segment-label">
                {segment.speakerLabel} · {Math.floor(segment.startedAtMs / 60000)}:
                {String(Math.floor(segment.startedAtMs / 1000) % 60).padStart(2, '0')}
                {segment.timeIsChunkStart && '（片段起點）'}
              </span>
              {segment.recordingId && (
                <button
                  className="seek"
                  onClick={() => onSeek(segment.recordingId!, segment.startedAtMs / 1000)}
                >
                  {segment.timeIsChunkStart ? '播放片段' : '播放此處'}
                </button>
              )}
              <textarea
                aria-label={`${segment.speakerLabel}逐字稿`}
                disabled={busy || locked}
                value={segment.text}
                onChange={(event) => edit(segment, event.target.value)}
              />
              {segment.translation && <p className="translation">{segment.translation}</p>}
            </div>
          ))
        ) : (
          <p className="hint">目前沒有逐字稿。</p>
        )}
      </div>
    </section>
  );
}
