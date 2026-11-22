import { memo, useEffect, useState } from 'react';
import { getRecordingBlob, type Recording } from '../db/meetingDb';
import { formatTimestamp } from '../services/exporter';
import { recordingFilename } from '../services/fileTranscription';
import { IconDownload, IconFileText } from './Icons';

export const RecordingPlayer = memo(function RecordingPlayer({
  recording,
  hasAudio,
  disabled,
  onTranscribe,
}: {
  recording: Recording;
  hasAudio: boolean | null | undefined;
  disabled: boolean;
  onTranscribe: (recording: Recording) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!hasAudio) return;
    let active = true;
    let objectUrl = '';
    getRecordingBlob(recording)
      .then((blob) => {
        if (active && blob.size) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        } else if (active) {
          setUrl('');
        }
      })
      .catch(() => {
        if (active) setUrl('');
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [recording.id, recording.completed, recording.mimeType, hasAudio]);

  return (
    <div className="audio">
      <div className="audio-meta">
        <span>
          {recording.filename ? `${recording.filename} · ` : ''}
          {new Date(recording.createdAt).toLocaleString('zh-TW')}
          {recording.durationSeconds !== undefined
            ? ` · ${formatTimestamp(recording.durationSeconds * 1000)}`
            : ''}
        </span>
        {!recording.completed && <span className="pill-warn">錄音中斷・已保存片段</span>}
      </div>
      {hasAudio === false ? (
        <small>僅保留時間軸資訊（未含錄音檔）</small>
      ) : hasAudio === undefined || url === '' ? (
        <small>無法讀取錄音</small>
      ) : (
        <>
          {!url && <small role="status">正在載入錄音…</small>}
          {hasAudio && (
            <div className="audio-controls" hidden={!url}>
              <audio
                id={`audio-${recording.id}`}
                controls
                preload="metadata"
                src={url ?? undefined}
              />
              {url && (
                <a
                  className="secondary small-button audio-download"
                  href={url}
                  download={recordingFilename(recording)}
                >
                  <IconDownload size={14} />
                  <span>下載音檔</span>
                </a>
              )}
              <button
                type="button"
                className="secondary small-button"
                disabled={disabled || !url}
                onClick={() => onTranscribe(recording)}
              >
                <IconFileText size={14} />
                <span>轉錄此錄音</span>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
});
