import { useEffect, useRef, useState } from 'react';
import { SettingsDialog } from './components/SettingsDialog';
import { MinutesStudio } from './components/MinutesStudio';
import { TranscriptFeed } from './components/TranscriptFeed';
import { LiveCapture } from './audio/liveCapture';
import { SegmentTimeline } from './audio/segmentTimeline';
import { TranslationQueue } from './services/translationQueue';
import { ProjectionOverlay } from './components/ProjectionOverlay';
import { DeleteMeetingDialog } from './components/DeleteMeetingDialog';
import type { AudioTrackRole, TranscriptSegment } from '../shared/types';
import { languageCode, languages } from '../shared/languages';
import { loadSettings, saveSettings, type Settings } from './services/settings';
import {
  getRecordingBlob,
  listMeetings,
  listRecordings,
  listSegments,
  migrateMeetings,
  deleteMeeting,
  saveSegment,
  updateSegmentTranslation,
  saveAudioChunk,
  saveMeeting,
  saveRecording,
  type Meeting,
  type Recording,
} from './db/meetingDb';

function RecordingPlayer({ recording }: { recording: Recording }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    getRecordingBlob(recording)
      .then((blob) => {
        if (active && blob.size) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [recording]);
  const extension = recording.mimeType.includes('mp4')
    ? 'm4a'
    : recording.mimeType.includes('ogg')
      ? 'ogg'
      : recording.mimeType.includes('mpeg')
        ? 'mp3'
        : recording.mimeType.includes('wav')
          ? 'wav'
          : recording.mimeType.includes('flac')
            ? 'flac'
            : recording.mimeType.includes('aac')
              ? 'aac'
              : 'webm';
  return (
    <div className="audio">
      <span>
        {new Date(recording.createdAt).toLocaleString('zh-TW')}{' '}
        {recording.durationSeconds !== undefined
          ? ` · ${Math.floor(recording.durationSeconds / 60)}:${String(Math.floor(recording.durationSeconds % 60)).padStart(2, '0')}`
          : ''}{' '}
        {recording.completed ? '' : '（錄音中斷，已保存部分）'}
      </span>
      {url ? (
        <>
          <audio id={`audio-${recording.id}`} controls preload="metadata" src={url} />
          <a
            href={url}
            download={recording.filename || `polymeet-${recording.createdAt}.${extension}`}
          >
            下載錄音
          </a>
        </>
      ) : (
        <small>沒有可播放的錄音片段</small>
      )}
    </div>
  );
}
export function App() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [recording, setRecording] = useState(false);
  const [savingRecording, setSavingRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [source, setSource] = useState<'mic' | 'both'>('mic');
  const [liveEnabled, setLiveEnabled] = useState(true);
  const [liveStatus, setLiveStatus] = useState('');
  const [translationStatus, setTranslationStatus] = useState('');
  const [levels, setLevels] = useState({ mic: 0, system: 0 });
  const [interims, setInterims] = useState<Record<string, { track: AudioTrackRole; text: string }>>(
    {},
  );
  const [error, setError] = useState('');
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const recorder = useRef<MediaRecorder | null>(null);
  const streams = useRef<MediaStream[]>([]);
  const liveCapture = useRef<LiveCapture | null>(null);
  const mixContext = useRef<AudioContext | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const meeting = meetings.find((m) => m.id === selected);
  useEffect(() => {
    let active = true;
    (async () => {
      const raw = localStorage.getItem('polymeet-meetings');
      if (raw) {
        let old: unknown;
        try {
          old = JSON.parse(raw);
        } catch {
          throw new Error('舊版會議資料格式無法讀取，原始資料仍保留。');
        }
        if (!Array.isArray(old)) throw new Error('舊版會議資料格式無法讀取，原始資料仍保留。');
        await migrateMeetings(old as Meeting[]);
        localStorage.removeItem('polymeet-meetings');
      }
      const saved = await listMeetings();
      if (active) {
        setMeetings(saved);
        setSelected(saved[0]?.id ?? null);
      }
    })().catch(() => {
      if (active) setError('無法讀取本機資料。請確認瀏覽器允許儲存空間，然後重新整理。');
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setRecordings([]);
    setSegments([]);
    if (selected)
      listSegments(selected)
        .then((items) => {
          if (active) setSegments(items);
        })
        .catch(() => {
          if (active) setError('無法讀取逐字稿。');
        });
    if (selected)
      listRecordings(selected)
        .then((items) => {
          if (active) setRecordings(items);
        })
        .catch(() => setError('無法讀取錄音。'));
    return () => {
      active = false;
    };
  }, [selected]);
  useEffect(
    () => () => {
      streams.current.forEach((stream) => stream.getTracks().forEach((t) => t.stop()));
      if (mixContext.current?.state !== 'closed') void mixContext.current?.close().catch(() => {});
    },
    [],
  );
  useEffect(() => {
    if (!recording || paused) return;
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [recording, paused]);
  useEffect(() => {
    if (!recording && !savingRecording) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = ' ';
    };
    const saveOnHidden = () => {
      const current = recorder.current;
      if (document.visibilityState === 'hidden' && current && current.state !== 'inactive') {
        try {
          current.requestData();
        } catch {
          /* The recorder may have just stopped. */
        }
      }
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('visibilitychange', saveOnHidden);
    return () => {
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('visibilitychange', saveOnHidden);
    };
  }, [recording, savingRecording]);
  function persist(m: Meeting) {
    saveQueue.current = saveQueue.current
      .catch(() => {})
      .then(() => saveMeeting(m))
      .catch(() => {
        setError('無法儲存會議資料，請檢查瀏覽器儲存空間。');
      });
  }
  function create() {
    const m: Meeting = {
      id: crypto.randomUUID(),
      title: '未命名會議',
      createdAt: Date.now(),
      notes: '',
      mode: '一般會議',
    };
    setMeetings((old) => [m, ...old]);
    setSelected(m.id);
    persist(m);
  }
  function update(patch: Partial<Meeting>) {
    if (!meeting) return;
    const next = { ...meeting, ...patch };
    setMeetings((old) => old.map((m) => (m.id === selected ? next : m)));
    persist(next);
  }
  async function start() {
    if (!meeting || busy || uploading) return;
    if (
      meeting.mode === '雙語會議' &&
      (meeting.sourceLang || '繁體中文') === (meeting.targetLang || 'English')
    ) {
      setError('請選擇兩種不同的語言。');
      return;
    }
    setBusy(true);
    setError('');
    setElapsed(0);
    setInterims({});
    setLiveStatus('');
    setTranslationStatus('');
    let mic: MediaStream | undefined, display: MediaStream | undefined;
    let mixer: AudioContext | undefined, live: LiveCapture | undefined;
    try {
      if (source === 'both') {
        display = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { suppressLocalAudioPlayback: false },
        } as DisplayMediaStreamOptions);
        if (!display.getAudioTracks().length)
          throw new Error('未選擇可分享的音訊，請重新選擇分頁並啟用分享音訊。');
        display.getVideoTracks().forEach((track) => {
          track.enabled = false;
        });
      }
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      streams.current = [mic, ...(display ? [display] : [])];
      let recordingStream = mic;
      if (display) {
        mixer = new AudioContext();
        mixContext.current = mixer;
        const merger = mixer.createChannelMerger(2),
          destination = mixer.createMediaStreamDestination();
        mixer.createMediaStreamSource(mic).connect(merger, 0, 0);
        mixer.createMediaStreamSource(display).connect(merger, 0, 1);
        merger.connect(destination);
        recordingStream = destination.stream;
      }
      const r = new MediaRecorder(recordingStream);
      const saved: Recording = {
        id: crypto.randomUUID(),
        meetingId: meeting.id,
        createdAt: Date.now(),
        mimeType: r.mimeType || 'audio/webm',
        completed: false,
      };
      await saveRecording(saved);
      let startedAt = Date.now(),
        pausedAt = 0,
        pausedDuration = 0;
      const timeline = new SegmentTimeline();
      r.onstart = () => {
        startedAt = Date.now();
      };
      r.onpause = () => {
        pausedAt = Date.now();
      };
      r.onresume = () => {
        if (pausedAt) pausedDuration += Date.now() - pausedAt;
        pausedAt = 0;
      };
      if (liveEnabled) {
        const translations =
          meeting.mode === '雙語會議'
            ? new TranslationQueue(
                settings,
                meeting.sourceLang || '繁體中文',
                meeting.targetLang || 'English',
                (segment, text, final) => {
                  if (selectedRef.current === saved.meetingId)
                    setSegments((old) =>
                      old.map((item) =>
                        item.id === segment.id ? { ...item, translation: text } : item,
                      ),
                    );
                  if (final)
                    void updateSegmentTranslation(segment.id, text).catch(() =>
                      setError('無法保存譯文。'),
                    );
                },
                () => setTranslationStatus('翻譯失敗，請檢查翻譯模型和金鑰。'),
              )
            : null;
        live = new LiveCapture();
        liveCapture.current = live;
        const provider = settings.liveProvider;
        const key = provider === 'openai' ? settings.openaiKey : settings.geminiKey;
        await live.start(
          [
            { stream: mic, role: 'mic' },
            ...(display ? [{ stream: display, role: 'system' as const }] : []),
          ],
          {
            provider,
            model: provider === 'openai' ? settings.openaiLiveModel : settings.geminiLiveModel,
            apiKey: key || undefined,
            languageHints: [
              languageCode(meeting.sourceLang || '繁體中文'),
              ...(meeting.mode === '雙語會議'
                ? [languageCode(meeting.targetLang || 'English')]
                : []),
            ].filter((value): value is string => Boolean(value)),
          },
          (event) => {
            if (event.type === 'session.ready') setLiveStatus('即時轉錄已連線');
            if (event.type === 'session.reconnecting') {
              setLiveStatus('即時轉錄重新連線中，音訊暫存在本機');
              const discarded = event.discardedInterims ?? [];
              if (event.track) timeline.retry(discarded, event.track);
              setInterims((old) => {
                const next = { ...old };
                for (const id of discarded) delete next[id];
                return next;
              });
            }
            if (event.type === 'error') {
              setLiveStatus(event.message);
              if (['audio_unsent', 'audio_buffer_full'].includes(event.code) || !event.recoverable)
                setError(event.message);
            }
            if (event.type === 'transcript.interim') {
              timeline.position(
                event.segmentId,
                event.track,
                Math.max(0, Date.now() - startedAt - pausedDuration),
              );
              setInterims((old) => ({
                ...old,
                [event.segmentId]: { track: event.track, text: event.text },
              }));
            }
            if (event.type === 'transcript.final') {
              setInterims((old) => {
                const next = { ...old };
                delete next[event.segmentId];
                return next;
              });
              const position = timeline.finish(
                event.segmentId,
                event.track,
                Math.max(0, (pausedAt || Date.now()) - startedAt - pausedDuration - 700),
              );
              if (!event.text.trim()) return;
              const segment: TranscriptSegment = {
                id: event.segmentId,
                meetingId: saved.meetingId,
                recordingId: saved.id,
                track: event.track,
                speakerLabel: event.track === 'mic' ? '我方' : '對方',
                startedAtMs: position,
                text: event.text,
                isFinal: true,
              };
              void saveSegment(segment)
                .then(() => {
                  if (selectedRef.current === saved.meetingId)
                    setSegments((old) => [
                      ...old.filter((item) => item.recordingId !== saved.id),
                      ...[
                        ...old.filter(
                          (item) => item.recordingId === saved.id && item.id !== segment.id,
                        ),
                        segment,
                      ].sort((a, b) => a.startedAtMs - b.startedAtMs),
                    ]);
                  translations?.add(segment);
                })
                .catch(() => setError('無法保存即時逐字稿，請檢查儲存空間。'));
            }
          },
          (role, level) => setLevels((old) => ({ ...old, [role]: level })),
          (role) => {
            const position = Math.max(0, Date.now() - startedAt - pausedDuration - 100);
            timeline.noteSpeech(role, position);
          },
        );
        setLiveStatus('即時轉錄連線中…');
      }
      recorder.current = r;
      let sequence = 0;
      let writes = Promise.resolve();
      let failed = false;
      r.onerror = () => {
        failed = true;
        setError('錄音裝置發生錯誤，已保存的片段仍可恢復。');
      };
      r.ondataavailable = (e) => {
        if (!e.data.size) return;
        const index = sequence++;
        writes = writes
          .then(() => saveAudioChunk(saved.id, index, e.data))
          .catch(() => {
            failed = true;
            setError('錄音片段無法保存，請檢查儲存空間。已停止錄音。');
            if (r.state !== 'inactive') r.stop();
          });
      };
      r.onstop = () => {
        const stoppedAt = pausedAt || Date.now();
        setRecording(false);
        setSavingRecording(true);
        setPaused(false);
        setBusy(true);
        void (async () => {
          try {
            await live?.stop();
          } finally {
            liveCapture.current = null;
            streams.current.forEach((item) => item.getTracks().forEach((track) => track.stop()));
            streams.current = [];
            if (mixer?.state !== 'closed') await mixer?.close();
            mixContext.current = null;
          }
          await writes;
          if (!failed)
            await saveRecording({
              ...saved,
              completed: true,
              durationSeconds: Math.max(
                0,
                Math.floor((stoppedAt - startedAt - pausedDuration) / 1000),
              ),
            });
          setRecordings(await listRecordings(saved.meetingId));
          setLiveStatus('');
          setInterims({});
          setLevels({ mic: 0, system: 0 });
        })()
          .catch(() => setError('無法完成錄音保存，已保存的片段仍可恢復。'))
          .finally(() => {
            setSavingRecording(false);
            setBusy(false);
          });
      };
      [...mic.getAudioTracks(), ...(display?.getAudioTracks() || [])].forEach((track) => {
        track.onended = () => {
          if (r.state !== 'inactive') r.stop();
        };
      });
      r.start(5000);
      setRecording(true);
      setBusy(false);
    } catch (e) {
      mic?.getTracks().forEach((t) => t.stop());
      display?.getTracks().forEach((t) => t.stop());
      if (live) void live.stop().catch(() => {});
      if (mixer && mixer.state !== 'closed') void mixer.close().catch(() => {});
      streams.current = [];
      setError(
        e instanceof Error && e.message.startsWith('未選擇')
          ? e.message
          : '無法開始錄音或即時轉錄。請確認音訊權限及瀏覽器支援。',
      );
      setBusy(false);
    }
  }
  function stop() {
    if (recorder.current?.state !== 'inactive') recorder.current?.stop();
  }
  async function togglePause() {
    const r = recorder.current;
    if (!r || busy) return;
    setBusy(true);
    try {
      if (r.state === 'recording') {
        r.pause();
        await liveCapture.current?.pause();
        setPaused(true);
      } else if (r.state === 'paused') {
        await liveCapture.current?.resume();
        r.resume();
        setPaused(false);
      }
    } catch {
      setError('無法切換錄音狀態，請停止錄音後重試。');
    } finally {
      if (r.state !== 'inactive') setBusy(false);
    }
  }
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brandmark">✳</span>
          <span>
            PolyMeet<small>MEETING WORKSPACE</small>
          </span>
        </div>
        <button
          className="new"
          onClick={create}
          disabled={recording || busy || uploading || generating}
        >
          <span>＋</span> 新增會議
        </button>
        <div className="side-label">工作空間</div>
        <div className="nav-active">
          ▤ <span>所有會議</span>
          <span className="count">{meetings.length}</span>
        </div>
        <div className="side-label history">最近的會議</div>
        <label className="search">
          <span aria-hidden="true">⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜尋會議"
            aria-label="搜尋會議"
          />
        </label>
        <div className="meeting-list">
          {meetings
            .filter((m) => m.title.includes(query))
            .map((m) => (
              <button
                key={m.id}
                disabled={recording || busy || uploading || generating}
                className={m.id === selected ? 'meeting selected' : 'meeting'}
                onClick={() => {
                  setSelected(m.id);
                }}
              >
                <span className="meeting-icon">▧</span>
                <span>
                  <strong>{m.title}</strong>
                  <small>{new Date(m.createdAt).toLocaleDateString('zh-TW')}</small>
                </span>
              </button>
            ))}
        </div>
        <div className="sidebar-footer">
          <span className="avatar">P</span>
          <span>
            <strong>個人工作空間</strong>
            <small>資料儲存於此瀏覽器</small>
          </span>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            工作空間 <b>/</b> {meeting?.title || '所有會議'}
          </span>
          <div className="top-actions">
            <span className="local">
              <i /> 本機工作區
            </span>
            <SettingsDialog
              settings={settings}
              onSave={(value) => {
                saveSettings(value);
                setSettings(value);
              }}
            />
          </div>
        </header>
        {error && !meeting && (
          <p className="error global-error" role="alert">
            {error}
          </p>
        )}
        {meeting ? (
          <div className="workspace">
            <div className="heading">
              <div>
                <div className="eyebrow">YOUR MEETING SPACE</div>
                <input
                  className="title-input"
                  aria-label="會議名稱"
                  value={meeting.title}
                  onChange={(e) => update({ title: e.target.value })}
                />
                <p>
                  {new Date(meeting.createdAt).toLocaleDateString('zh-TW', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    weekday: 'long',
                  })}{' '}
                  <span>·</span> {meeting.mode}
                </p>
              </div>
              <div className="heading-actions">
                <DeleteMeetingDialog
                  title={meeting.title}
                  disabled={recording || busy || uploading || generating}
                  onDelete={async () => {
                    await saveQueue.current;
                    await deleteMeeting(meeting.id);
                    const remaining = meetings.filter((item) => item.id !== meeting.id);
                    setMeetings(remaining);
                    setSelected(remaining[0]?.id ?? null);
                  }}
                />
                <span className="status">
                  ●{' '}
                  {recording
                    ? `${paused ? '已暫停' : '錄音中'} ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
                    : busy
                      ? '處理中'
                      : '準備就緒'}
                </span>
              </div>
            </div>
            <div className="content-grid">
              <section className="main-column">
                <div className="card recording-card">
                  <div className="card-top">
                    <div>
                      <div className="eyebrow">CAPTURE THE CONVERSATION</div>
                      <h2>準備好開始了嗎？</h2>
                      <p>記錄每一個值得留下的想法。</p>
                    </div>
                    <div className="wave" aria-hidden="true">
                      ▂▅▃▇▅▂▆▃
                    </div>
                  </div>
                  <div className="record-controls">
                    <div>
                      <label htmlFor="mode">會議模式</label>
                      <select
                        id="mode"
                        value={meeting.mode}
                        disabled={recording || busy || uploading || generating}
                        onChange={(e) => update({ mode: e.target.value })}
                      >
                        <option>一般會議</option>
                        <option>雙語會議</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="source">音訊來源</label>
                      <select
                        id="source"
                        disabled={recording || busy || uploading || generating}
                        value={source}
                        onChange={(e) => setSource(e.target.value as 'mic' | 'both')}
                      >
                        <option value="mic">麥克風</option>
                        <option value="both">麥克風 + 分頁音訊</option>
                      </select>
                    </div>
                    {recording && (
                      <button className="pause" disabled={busy} onClick={() => void togglePause()}>
                        {paused ? '繼續' : '暫停'}
                      </button>
                    )}
                    <button
                      disabled={busy || uploading}
                      className={recording ? 'record stop' : 'record'}
                      onClick={recording ? stop : start}
                    >
                      {recording ? '■　停止錄音' : '●　開始錄音'}
                    </button>
                  </div>
                  <label className="live-toggle">
                    <input
                      type="checkbox"
                      checked={liveEnabled}
                      disabled={recording || busy || uploading || generating}
                      onChange={(e) => setLiveEnabled(e.target.checked)}
                    />{' '}
                    啟用即時轉錄
                  </label>
                  <div className="language-controls">
                    <label>
                      {meeting.mode === '雙語會議' ? '語言一' : '逐字稿語言'}
                      <select
                        value={meeting.sourceLang || '繁體中文'}
                        disabled={recording || busy || uploading || generating}
                        onChange={(e) => update({ sourceLang: e.target.value })}
                      >
                        {languages.map((language) => (
                          <option key={language.code}>{language.label}</option>
                        ))}
                      </select>
                    </label>
                    {meeting.mode === '雙語會議' && (
                      <label>
                        語言二
                        <select
                          value={meeting.targetLang || 'English'}
                          disabled={recording || busy || uploading || generating}
                          onChange={(e) => update({ targetLang: e.target.value })}
                        >
                          {languages.map((language) => (
                            <option key={language.code}>{language.label}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    {meeting.mode === '雙語會議' && (
                      <ProjectionOverlay
                        segments={segments}
                        interim={Object.values(interims)
                          .map((item) => item.text)
                          .filter(Boolean)
                          .join(' ')}
                      />
                    )}
                  </div>
                  {recording && liveEnabled && (
                    <div className="levels">
                      <label>
                        麥克風音量 <meter min="0" max="0.2" value={levels.mic} />
                      </label>
                      {source === 'both' && (
                        <label>
                          分頁音量 <meter min="0" max="0.2" value={levels.system} />
                        </label>
                      )}
                    </div>
                  )}
                  {liveStatus && (
                    <p className="hint" role="status">
                      {liveStatus}
                    </p>
                  )}
                  {translationStatus && (
                    <p className="error" role="alert">
                      {translationStatus}
                    </p>
                  )}
                  {error && (
                    <p className="error" role="alert">
                      {error}
                    </p>
                  )}
                  {recordings.map((item) => (
                    <RecordingPlayer key={item.id} recording={item} />
                  ))}
                </div>
                <div className="section-head">
                  <div>
                    <div className="eyebrow">MEETING NOTES</div>
                    <h2>會議筆記</h2>
                  </div>
                  <span>自動儲存於本機</span>
                </div>
                <div className="notes-card">
                  <div className="notes-toolbar">
                    <span>✎</span>　自由記錄{' '}
                    <span className="toolbar-hint">隨時補充想法與重點</span>
                  </div>
                  <textarea
                    value={meeting.notes}
                    onChange={(e) => update({ notes: e.target.value })}
                    placeholder="在這裡寫下會議重點、想法或待辦事項…"
                    aria-label="會議筆記"
                  />
                </div>
                <TranscriptFeed
                  key={`transcript-${meeting.id}`}
                  meetingId={meeting.id}
                  languageHints={[
                    languageCode(meeting.sourceLang || '繁體中文'),
                    ...(meeting.mode === '雙語會議'
                      ? [languageCode(meeting.targetLang || 'English')]
                      : []),
                  ].filter((value): value is string => Boolean(value))}
                  segments={segments}
                  onAppend={(segment) => {
                    if (selectedRef.current === meeting.id) setSegments((old) => [...old, segment]);
                  }}
                  onTextChange={(id, text) =>
                    setSegments((old) =>
                      old.map((item) => (item.id === id ? { ...item, text } : item)),
                    )
                  }
                  onRecordingSaved={() => {
                    void listRecordings(meeting.id)
                      .then((items) => {
                        if (selectedRef.current === meeting.id) setRecordings(items);
                      })
                      .catch(() => setError('無法讀取錄音。'));
                  }}
                  onBusyChange={setUploading}
                  onSeek={(id, seconds) => {
                    const audio = document.getElementById(`audio-${id}`) as HTMLAudioElement | null;
                    if (audio) {
                      audio.currentTime = seconds;
                      audio.scrollIntoView({ block: 'center' });
                      void audio.play().catch(() => setError('無法播放錄音，請使用錄音播放器。'));
                    }
                  }}
                  settings={settings}
                  locked={recording || busy}
                />
                {Object.entries(interims)
                  .filter(([, item]) => item.text)
                  .map(([id, item]) => (
                    <p className="interim" key={id}>
                      {item.track === 'mic' ? '我方' : '對方'}：{item.text}{' '}
                      <small>（辨識中）</small>
                    </p>
                  ))}
                <MinutesStudio
                  key={`minutes-${meeting.id}`}
                  meetingId={meeting.id}
                  meetingLanguages={
                    meeting.mode === '雙語會議'
                      ? [meeting.sourceLang || '繁體中文', meeting.targetLang || 'English']
                      : [meeting.sourceLang || '繁體中文']
                  }
                  text={[
                    meeting.notes,
                    ...segments.map((segment) =>
                      segment.translation
                        ? `${segment.speakerLabel}: ${segment.text}\n譯文: ${segment.translation}`
                        : `${segment.speakerLabel}: ${segment.text}`,
                    ),
                  ]
                    .filter(Boolean)
                    .join('\n\n')}
                  settings={settings}
                  onBusyChange={setGenerating}
                />
              </section>
              <aside className="right-column">
                <div className="card guide">
                  <div className="guide-icon">✦</div>
                  <h3>讓對話更有收穫</h3>
                  <p>從一場會議開始，將重要的想法留在這裡。</p>
                  <div className="steps">
                    <div>
                      <span>1</span>
                      <p>
                        <strong>設定會議</strong>
                        <small>選擇模式並確認麥克風</small>
                      </p>
                    </div>
                    <div>
                      <span>2</span>
                      <p>
                        <strong>開始記錄</strong>
                        <small>錄音並隨手記下重要想法</small>
                      </p>
                    </div>
                    <div>
                      <span>3</span>
                      <p>
                        <strong>整理與回顧</strong>
                        <small>下載錄音，稍後繼續編輯筆記</small>
                      </p>
                    </div>
                  </div>
                </div>
                <div className="coming">
                  <span>✧</span>
                  <div>
                    <strong>雙語對話</strong>
                    <p>選擇雙語會議，即可在逐字稿旁顯示翻譯並開啟投影字幕。</p>
                  </div>
                </div>
              </aside>
            </div>
            <footer>
              PolyMeet <span>·</span> 為更好的每一次對話而設計
            </footer>
          </div>
        ) : (
          <div className="empty">
            <div className="empty-icon select-none">✳</div>
            <div className="eyebrow">WELCOME TO POLYMEET</div>
            <h1>
              讓每場對話
              <br />
              都有跡可循。
            </h1>
            <p>一個安靜、有條理的空間，陪你記錄會議中的每個重要時刻。</p>
            <button className="record" onClick={create}>
              ＋　建立第一場會議
            </button>
            <div className="empty-note">你的筆記會保存在此瀏覽器中</div>
          </div>
        )}
      </main>
    </div>
  );
}
