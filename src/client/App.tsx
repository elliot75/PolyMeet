import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SettingsDialog, type ServerHealth } from './components/SettingsDialog';
import { MinutesStudio } from './components/MinutesStudio';
import { TranscriptFeed } from './components/TranscriptFeed';
import { LiveCapture } from './audio/liveCapture';
import { SegmentTimeline } from './audio/segmentTimeline';
import { TranslationQueue } from './services/translationQueue';
import { ProjectionOverlay } from './components/ProjectionOverlay';
import { DeleteMeetingDialog } from './components/DeleteMeetingDialog';
import { formatTimestamp } from './services/exporter';
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
import {
  IconAlertCircle,
  IconBrandMark,
  IconDownload,
  IconFileText,
  IconMenu,
  IconMic,
  IconPause,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSparkles,
  IconStop,
  IconSwap,
  IconX,
} from './components/Icons';

type AudioLevels = { mic: number; system: number };
type LevelSubscriber = (levels: AudioLevels) => void;

const WAVE_WEIGHTS = [0.38, 0.68, 0.52, 0.94, 0.8, 0.62, 0.88, 0.48, 0.35];

const LiveWaveBars = memo(function LiveWaveBars({
  active,
  subscribeLevels,
}: {
  active: boolean;
  subscribeLevels: (listener: LevelSubscriber) => () => void;
}) {
  const [levels, setLevels] = useState<AudioLevels>({ mic: 0, system: 0 });

  useEffect(() => {
    if (!active) {
      setLevels({ mic: 0, system: 0 });
      return;
    }
    return subscribeLevels(setLevels);
  }, [active, subscribeLevels]);

  const level = active ? Math.min(1, Math.max(levels.mic, levels.system) * 5.5) : 0;

  return (
    <div className={`wave-bars ${active ? 'active' : ''}`} aria-hidden="true">
      {WAVE_WEIGHTS.map((weight, index) => (
        <span
          key={index}
          style={{
            transform: `scaleY(${active ? 0.25 + level * weight : weight * 0.45})`,
          }}
        />
      ))}
    </div>
  );
});

const AudioMeters = memo(function AudioMeters({
  active,
  both,
  subscribeLevels,
}: {
  active: boolean;
  both: boolean;
  subscribeLevels: (listener: LevelSubscriber) => () => void;
}) {
  const [levels, setLevels] = useState<AudioLevels>({ mic: 0, system: 0 });

  useEffect(() => {
    if (!active) {
      setLevels({ mic: 0, system: 0 });
      return;
    }
    return subscribeLevels(setLevels);
  }, [active, subscribeLevels]);

  if (!active) return null;

  return (
    <div className="levels">
      <label>
        <span>麥克風音量</span>
        <meter min="0" max="0.2" value={levels.mic} />
      </label>
      {both && (
        <label>
          <span>分頁音量</span>
          <meter min="0" max="0.2" value={levels.system} />
        </label>
      )}
    </div>
  );
});

const RecordingPlayer = memo(function RecordingPlayer({ recording }: { recording: Recording }) {
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
  }, [recording.id, recording.completed, recording.mimeType]);

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
      {url ? (
        <div className="audio-controls">
          <audio id={`audio-${recording.id}`} controls preload="metadata" src={url} />
          <a
            className="secondary small-button audio-download"
            href={url}
            download={recording.filename || `polymeet-${recording.createdAt}.${extension}`}
          >
            <IconDownload size={14} />
            <span>下載音檔</span>
          </a>
        </div>
      ) : (
        <small>沒有可播放的錄音片段</small>
      )}
    </div>
  );
});

export function App() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [studioTab, setStudioTab] = useState<'notes' | 'minutes'>('notes');
  const [minutesCount, setMinutesCount] = useState(0);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [serverHealth, setServerHealth] = useState<ServerHealth | null>(null);
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
  const [interims, setInterims] = useState<Record<string, { track: AudioTrackRole; text: string }>>(
    {},
  );
  const [error, setError] = useState('');
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const meetingsRef = useRef<Meeting[]>([]);
  meetingsRef.current = meetings;
  const recorder = useRef<MediaRecorder | null>(null);
  const streams = useRef<MediaStream[]>([]);
  const liveCapture = useRef<LiveCapture | null>(null);
  const mixContext = useRef<AudioContext | null>(null);
  const translationQueueRef = useRef<TranslationQueue | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingSavesRef = useRef(new Map<string, Meeting>());
  const saveTimerRef = useRef<number | undefined>(undefined);
  const recordingClockRef = useRef({ startedAtMs: 0, pausedAccumMs: 0, pausedAtMs: 0 });
  const levelSubscribersRef = useRef(new Set<LevelSubscriber>());
  const levelsRef = useRef<AudioLevels>({ mic: 0, system: 0 });
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const wasDrawerOpenRef = useRef(false);

  const meeting = meetings.find((m) => m.id === selected);
  const workspaceLocked = recording || busy || uploading || generating;

  const subscribeLevels = useCallback((listener: LevelSubscriber) => {
    levelSubscribersRef.current.add(listener);
    listener(levelsRef.current);
    return () => {
      levelSubscribersRef.current.delete(listener);
    };
  }, []);

  const publishLevels = useCallback((next: AudioLevels) => {
    levelsRef.current = next;
    for (const listener of levelSubscribersRef.current) listener(next);
  }, []);

  const flushPendingSaves = useCallback(() => {
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = undefined;
    if (!pendingSavesRef.current.size) return saveQueue.current;
    const batch = [...pendingSavesRef.current.values()];
    pendingSavesRef.current.clear();
    saveQueue.current = saveQueue.current
      .catch(() => {})
      .then(() => Promise.all(batch.map((item) => saveMeeting(item))).then(() => undefined))
      .catch(() => {
        setError('無法儲存會議資料，請檢查瀏覽器儲存空間。');
      });
    return saveQueue.current;
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const response = await fetch('/api/health');
      if (!response.ok) throw new Error();
      const data = await response.json();
      setServerHealth({
        ok: true,
        openai: Boolean(data?.serverKeys?.openai),
        gemini: Boolean(data?.serverKeys?.gemini),
      });
    } catch {
      setServerHealth({ ok: false, openai: false, gemini: false });
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

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
    setMinutesCount(0);
    setLiveStatus('');
    setTranslationStatus('');
    setError('');
    if (selected) {
      listSegments(selected)
        .then((items) => {
          if (active) setSegments(items);
        })
        .catch(() => {
          if (active) setError('無法讀取逐字稿。');
        });
      listRecordings(selected)
        .then((items) => {
          if (active) setRecordings(items);
        })
        .catch(() => {
          if (active) setError('無法讀取錄音。');
        });
    }
    return () => {
      active = false;
    };
  }, [selected]);

  useEffect(() => {
    const flushOnHide = () => {
      if (document.visibilityState === 'hidden') void flushPendingSaves();
    };
    document.addEventListener('visibilitychange', flushOnHide);
    return () => {
      document.removeEventListener('visibilitychange', flushOnHide);
      void flushPendingSaves();
      void liveCapture.current?.stop().catch(() => {});
      translationQueueRef.current?.cancel();
      streams.current.forEach((stream) => stream.getTracks().forEach((t) => t.stop()));
      if (mixContext.current?.state !== 'closed') void mixContext.current?.close().catch(() => {});
    };
  }, [flushPendingSaves]);

  useEffect(() => {
    if (!recording || paused) return;
    const updateClock = () => {
      const clock = recordingClockRef.current;
      if (!clock.startedAtMs) return;
      setElapsed(
        Math.max(0, Math.floor((Date.now() - clock.startedAtMs - clock.pausedAccumMs) / 1000)),
      );
    };
    updateClock();
    const timer = window.setInterval(updateClock, 500);
    return () => window.clearInterval(timer);
  }, [recording, paused]);

  useEffect(() => {
    if (drawerOpen) {
      wasDrawerOpenRef.current = true;
      drawerCloseRef.current?.focus();
    } else if (wasDrawerOpenRef.current) {
      wasDrawerOpenRef.current = false;
      mobileMenuButtonRef.current?.focus();
    }
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

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

  function persist(m: Meeting, immediate = false) {
    pendingSavesRef.current.set(m.id, m);
    if (immediate) {
      void flushPendingSaves();
      return;
    }
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void flushPendingSaves();
    }, 180);
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
    setDrawerOpen(false);
    persist(m, true);
  }

  function update(patch: Partial<Meeting>, immediate = false) {
    if (!meeting) return;
    const next = { ...meeting, ...patch };
    setMeetings((old) => old.map((m) => (m.id === selected ? next : m)));
    persist(next, immediate);
  }

  function changeMode(nextMode: string) {
    if (!meeting) return;
    const src = meeting.sourceLang || '繁體中文';
    let tgt = meeting.targetLang || 'English';
    if (nextMode === '雙語會議' && src === tgt) {
      tgt = src === 'English' ? '繁體中文' : 'English';
    }
    update({ mode: nextMode, sourceLang: src, targetLang: tgt }, true);
  }

  function swapLanguages() {
    if (!meeting) return;
    const src = meeting.sourceLang || '繁體中文';
    const tgt = meeting.targetLang || 'English';
    update({ sourceLang: tgt, targetLang: src }, true);
  }

  async function start() {
    if (!meeting || busy || uploading || generating) return;
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
    publishLevels({ mic: 0, system: 0 });
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
        if (mixer.state === 'suspended') await mixer.resume();
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
      let startedAt = Date.now(),
        pausedAt = 0,
        pausedDuration = 0;
      recordingClockRef.current = { startedAtMs: startedAt, pausedAccumMs: 0, pausedAtMs: 0 };
      const timeline = new SegmentTimeline();
      r.onstart = () => {
        startedAt = Date.now();
        recordingClockRef.current = { startedAtMs: startedAt, pausedAccumMs: 0, pausedAtMs: 0 };
      };
      r.onpause = () => {
        pausedAt = Date.now();
        recordingClockRef.current.pausedAtMs = pausedAt;
      };
      r.onresume = () => {
        const now = Date.now();
        if (pausedAt) pausedDuration += now - pausedAt;
        pausedAt = 0;
        if (recordingClockRef.current.pausedAtMs) {
          recordingClockRef.current.pausedAccumMs += now - recordingClockRef.current.pausedAtMs;
          recordingClockRef.current.pausedAtMs = 0;
        }
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
                () => {
                  if (selectedRef.current === saved.meetingId)
                    setTranslationStatus('翻譯失敗，請檢查翻譯模型和金鑰。');
                },
              )
            : null;
        translationQueueRef.current?.cancel();
        translationQueueRef.current = translations;
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
          (role, level) => publishLevels({ ...levelsRef.current, [role]: level }),
          (role) => {
            const position = Math.max(0, Date.now() - startedAt - pausedDuration - 100);
            timeline.noteSpeech(role, position);
          },
        );
        setLiveStatus('即時轉錄連線中…');
      }
      await saveRecording(saved);
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
          const updatedRecordings = await listRecordings(saved.meetingId);
          if (selectedRef.current === saved.meetingId) setRecordings(updatedRecordings);
          setLiveStatus('');
          setInterims({});
          publishLevels({ mic: 0, system: 0 });
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
      liveCapture.current = null;
      if (mixer && mixer.state !== 'closed') void mixer.close().catch(() => {});
      mixContext.current = null;
      translationQueueRef.current?.cancel();
      translationQueueRef.current = null;
      streams.current = [];
      publishLevels({ mic: 0, system: 0 });
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

  const languageHints = useMemo(
    () =>
      [
        languageCode(meeting?.sourceLang || '繁體中文'),
        ...(meeting?.mode === '雙語會議' ? [languageCode(meeting?.targetLang || 'English')] : []),
      ].filter((value): value is string => Boolean(value)),
    [meeting?.mode, meeting?.sourceLang, meeting?.targetLang],
  );

  const meetingLanguages = useMemo(
    () =>
      meeting?.mode === '雙語會議'
        ? [meeting.sourceLang || '繁體中文', meeting.targetLang || 'English']
        : [meeting?.sourceLang || '繁體中文'],
    [meeting?.mode, meeting?.sourceLang, meeting?.targetLang],
  );

  const minutesText = useMemo(
    () =>
      [
        meeting?.notes || '',
        ...segments.map((segment) =>
          segment.translation
            ? `${segment.speakerLabel}: ${segment.text}\n譯文: ${segment.translation}`
            : `${segment.speakerLabel}: ${segment.text}`,
        ),
      ]
        .filter(Boolean)
        .join('\n\n'),
    [meeting?.notes, segments],
  );

  const handleAppendSegment = useCallback((segment: TranscriptSegment) => {
    if (selectedRef.current === segment.meetingId) setSegments((old) => [...old, segment]);
  }, []);

  const handleSegmentTextChange = useCallback((id: string, text: string) => {
    setSegments((old) => old.map((item) => (item.id === id ? { ...item, text } : item)));
  }, []);

  const handleRecordingSaved = useCallback(() => {
    const id = selectedRef.current;
    if (!id) return;
    void listRecordings(id)
      .then((items) => {
        if (selectedRef.current === id) setRecordings(items);
      })
      .catch(() => {
        if (selectedRef.current === id) setError('無法讀取錄音。');
      });
  }, []);

  const handleSeekRecording = useCallback((id: string, seconds: number) => {
    const audio = document.getElementById(`audio-${id}`) as HTMLAudioElement | null;
    if (!audio) return;
    const jumpAndPlay = () => {
      audio.currentTime = seconds;
      audio.scrollIntoView({
        block: 'center',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
      void audio.play().catch(() => setError('無法播放錄音，請使用錄音播放器。'));
    };
    if (audio.readyState < 1) {
      audio.addEventListener('loadedmetadata', jumpAndPlay, { once: true });
      audio.load();
    } else {
      jumpAndPlay();
    }
  }, []);

  const handleSaveSettings = useCallback((value: Settings) => {
    saveSettings(value);
    setSettings(value);
  }, []);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredMeetings = meetings.filter(
    (m) =>
      !normalizedQuery ||
      m.title.toLowerCase().includes(normalizedQuery) ||
      m.notes.toLowerCase().includes(normalizedQuery),
  );
  const formattedElapsed = formatTimestamp(elapsed * 1000);

  return (
    <div className="app">
      {drawerOpen && (
        <div className="sidebar-backdrop" aria-hidden="true" onClick={() => setDrawerOpen(false)} />
      )}
      <aside className={`sidebar ${drawerOpen ? 'open' : ''}`} aria-label="會議側邊欄">
        <div className="brand-row">
          <div className="brand">
            <span className="brandmark" aria-hidden="true">
              <IconBrandMark size={20} />
            </span>
            <span>
              PolyMeet<small>MEETING WORKSPACE</small>
            </span>
          </div>
          <button
            ref={drawerCloseRef}
            type="button"
            className="icon-button mobile-drawer-close"
            aria-label="關閉會議列表"
            onClick={() => setDrawerOpen(false)}
          >
            <IconX size={18} />
          </button>
        </div>

        <button type="button" className="new" onClick={create} disabled={workspaceLocked}>
          <IconPlus size={16} />
          <span>新增會議</span>
        </button>

        <div className="side-label">
          <span>會議列表</span>
          <span className="count">{meetings.length}</span>
        </div>

        <label className="search">
          <IconSearch size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜尋標題或筆記…"
            aria-label="搜尋會議"
          />
          {query && (
            <button
              type="button"
              className="search-clear"
              aria-label="清除搜尋"
              onClick={() => setQuery('')}
            >
              <IconX size={13} />
            </button>
          )}
        </label>

        <div className="meeting-list">
          {filteredMeetings.length > 0 ? (
            filteredMeetings.map((m) => (
              <button
                key={m.id}
                type="button"
                disabled={workspaceLocked}
                className={m.id === selected ? 'meeting selected' : 'meeting'}
                onClick={() => {
                  setSelected(m.id);
                  setDrawerOpen(false);
                }}
              >
                <span className="meeting-icon" aria-hidden="true">
                  <IconFileText size={15} />
                </span>
                <span className="meeting-info">
                  <span className="meeting-title-line">
                    <strong>{m.title || '未命名會議'}</strong>
                    {m.mode === '雙語會議' && <span className="meeting-mode-pill">雙語</span>}
                  </span>
                  <small>{new Date(m.createdAt).toLocaleDateString('zh-TW')}</small>
                </span>
              </button>
            ))
          ) : meetings.length > 0 ? (
            <div className="sidebar-empty">
              <p>找不到符合的會議</p>
              <button type="button" className="secondary small-button" onClick={() => setQuery('')}>
                清除搜尋
              </button>
            </div>
          ) : (
            <div className="sidebar-empty">
              <p>尚無會議紀錄</p>
            </div>
          )}
        </div>

        <div className="sidebar-footer">
          <span className="avatar" aria-hidden="true">
            P
          </span>
          <span>
            <strong>本機工作空間</strong>
            <small>資料保存於此瀏覽器</small>
          </span>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div className="topbar-left">
            <button
              ref={mobileMenuButtonRef}
              type="button"
              className="icon-button mobile-menu-button"
              aria-label="開啟會議列表"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen((value) => !value)}
            >
              <IconMenu size={18} />
            </button>
            <div className="breadcrumbs">
              <span>工作空間</span>
              <b>/</b>
              <strong className="crumb-current">{meeting?.title || '歡迎使用'}</strong>
            </div>
          </div>

          <div className="top-actions">
            {serverHealth === null ? (
              <span className="health-pill checking">
                <i /> 連線檢查中…
              </span>
            ) : serverHealth.ok ? (
              <span className="health-pill online">
                <i /> 本機後端已連線
              </span>
            ) : (
              <button
                type="button"
                className="health-pill offline"
                onClick={() => void refreshHealth()}
              >
                <IconRefresh size={12} />
                <span>離線模式・點此重試</span>
              </button>
            )}
            <SettingsDialog
              settings={settings}
              serverHealth={serverHealth}
              onRefreshHealth={() => void refreshHealth()}
              onSave={handleSaveSettings}
            />
          </div>
        </header>

        {error && !meeting && (
          <div className="global-error">
            <p className="error" role="alert">
              <IconAlertCircle size={16} />
              <span>{error}</span>
            </p>
          </div>
        )}

        {meeting ? (
          <div className="workspace">
            <div className="heading">
              <div className="heading-main">
                <div className="eyebrow">MEETING WORKSPACE</div>
                <input
                  className="title-input"
                  aria-label="會議名稱"
                  placeholder="輸入會議名稱…"
                  value={meeting.title}
                  onChange={(e) => update({ title: e.target.value })}
                />
                <div className="heading-meta">
                  <span>
                    {new Date(meeting.createdAt).toLocaleDateString('zh-TW', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                      weekday: 'short',
                    })}
                  </span>
                  <span className="dot" aria-hidden="true">
                    ·
                  </span>
                  <span>{meeting.mode}</span>
                  <span className="dot" aria-hidden="true">
                    ·
                  </span>
                  <span>{segments.length} 段逐字稿</span>
                  {recordings.length > 0 && (
                    <>
                      <span className="dot" aria-hidden="true">
                        ·
                      </span>
                      <span>{recordings.length} 份錄音</span>
                    </>
                  )}
                </div>
              </div>

              <div className="heading-actions">
                <span
                  className={`status ${
                    recording ? (paused ? 'paused' : 'live') : busy ? 'busy' : 'ready'
                  }`}
                >
                  <i aria-hidden="true" />
                  {recording
                    ? `${paused ? '已暫停' : '錄音中'} ${formattedElapsed}`
                    : busy
                      ? '處理中'
                      : '準備就緒'}
                </span>
                <DeleteMeetingDialog
                  title={meeting.title}
                  disabled={workspaceLocked}
                  onDelete={async () => {
                    translationQueueRef.current?.cancel();
                    await flushPendingSaves();
                    await deleteMeeting(meeting.id);
                    const nextSelected =
                      meetingsRef.current.find((item) => item.id !== meeting.id)?.id ?? null;
                    setMeetings((old) => old.filter((item) => item.id !== meeting.id));
                    if (selectedRef.current === meeting.id) setSelected(nextSelected);
                  }}
                />
              </div>
            </div>

            <section className="card capture-card" aria-label="錄音與即時轉錄控制">
              <div className="capture-header">
                <div className="capture-title-block">
                  <div className="eyebrow">CAPTURE STUDIO</div>
                  <h2>即時收音與同步轉錄</h2>
                  <p>
                    {recording
                      ? paused
                        ? '錄音已暫停，可隨時繼續或結束保存。'
                        : '音訊每 5 秒分段保存於本機瀏覽器。'
                      : '選擇會議模式、音訊來源與語言後即可開始錄音。'}
                  </p>
                </div>

                <div className="capture-actions">
                  <LiveWaveBars active={recording && !paused} subscribeLevels={subscribeLevels} />
                  {recording && (
                    <button
                      type="button"
                      className="pause"
                      disabled={busy}
                      onClick={() => void togglePause()}
                    >
                      <IconPause size={14} />
                      <span>{paused ? '繼續' : '暫停'}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy || (!recording && (uploading || generating))}
                    className={recording ? 'record stop' : 'record'}
                    onClick={recording ? stop : start}
                  >
                    {recording ? <IconStop size={15} /> : <IconMic size={16} />}
                    <span>{recording ? '停止錄音' : '開始錄音'}</span>
                  </button>
                </div>
              </div>

              <div className="capture-controls">
                <div className="control-block mode-block">
                  <span className="field-caption">會議模式</span>
                  <div className="segmented-control" role="group" aria-label="會議模式">
                    {(['一般會議', '雙語會議'] as const).map((modeOption) => (
                      <button
                        key={modeOption}
                        type="button"
                        className={meeting.mode === modeOption ? 'active' : ''}
                        disabled={workspaceLocked}
                        aria-pressed={meeting.mode === modeOption}
                        onClick={() => changeMode(modeOption)}
                      >
                        {modeOption}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="control-block source-block">
                  <span>音訊來源</span>
                  <select
                    id="source"
                    disabled={workspaceLocked}
                    value={source}
                    onChange={(e) => setSource(e.target.value as 'mic' | 'both')}
                  >
                    <option value="mic">僅麥克風</option>
                    <option value="both">麥克風 + 分頁音訊</option>
                  </select>
                </label>

                <div className="language-pair">
                  <label className="control-block">
                    <span>{meeting.mode === '雙語會議' ? '語言一' : '逐字稿語言'}</span>
                    <select
                      value={meeting.sourceLang || '繁體中文'}
                      disabled={workspaceLocked}
                      onChange={(e) => update({ sourceLang: e.target.value }, true)}
                    >
                      {languages.map((language) => (
                        <option key={language.code}>{language.label}</option>
                      ))}
                    </select>
                  </label>

                  {meeting.mode === '雙語會議' && (
                    <>
                      <button
                        type="button"
                        className="icon-button swap-button"
                        aria-label="交換語言一與語言二"
                        disabled={workspaceLocked}
                        onClick={swapLanguages}
                      >
                        <IconSwap size={15} />
                      </button>
                      <label className="control-block">
                        <span>語言二</span>
                        <select
                          value={meeting.targetLang || 'English'}
                          disabled={workspaceLocked}
                          onChange={(e) => update({ targetLang: e.target.value }, true)}
                        >
                          {languages.map((language) => (
                            <option key={language.code}>{language.label}</option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                </div>

                <div className="capture-utilities">
                  <label className="live-toggle">
                    <input
                      type="checkbox"
                      checked={liveEnabled}
                      disabled={workspaceLocked}
                      onChange={(e) => setLiveEnabled(e.target.checked)}
                    />
                    <span>啟用即時轉錄</span>
                  </label>
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
              </div>

              <AudioMeters
                active={recording && liveEnabled}
                both={source === 'both'}
                subscribeLevels={subscribeLevels}
              />

              {liveStatus && (
                <p className="hint status-feedback" role="status">
                  {liveStatus}
                </p>
              )}
              {translationStatus && (
                <p className="error" role="alert">
                  <IconAlertCircle size={15} />
                  <span>{translationStatus}</span>
                </p>
              )}
              {error && (
                <p className="error" role="alert">
                  <IconAlertCircle size={15} />
                  <span>{error}</span>
                </p>
              )}

              {recordings.length > 0 && (
                <div className="recordings-list">
                  {recordings.map((item) => (
                    <RecordingPlayer key={item.id} recording={item} />
                  ))}
                </div>
              )}
            </section>

            <div className="workspace-columns">
              <div className="main-column">
                <TranscriptFeed
                  key={`transcript-${meeting.id}`}
                  meetingId={meeting.id}
                  meetingTitle={meeting.title}
                  isBilingual={meeting.mode === '雙語會議'}
                  languageHints={languageHints}
                  segments={segments}
                  interims={interims}
                  onAppend={handleAppendSegment}
                  onTextChange={handleSegmentTextChange}
                  onRecordingSaved={handleRecordingSaved}
                  onBusyChange={setUploading}
                  onSeek={handleSeekRecording}
                  settings={settings}
                  locked={recording || busy}
                />
              </div>

              <aside className="studio-column" aria-label="筆記與會議紀錄工作區">
                <div className="studio-tabs-header">
                  <div className="segmented-control studio-tabs" role="tablist">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={studioTab === 'notes'}
                      className={studioTab === 'notes' ? 'active' : ''}
                      onClick={() => setStudioTab('notes')}
                    >
                      <IconFileText size={15} />
                      <span>會議筆記</span>
                      {meeting.notes.length > 0 && (
                        <span className="tab-badge">{meeting.notes.length} 字</span>
                      )}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={studioTab === 'minutes'}
                      className={studioTab === 'minutes' ? 'active' : ''}
                      onClick={() => setStudioTab('minutes')}
                    >
                      <IconSparkles size={15} />
                      <span>AI 紀錄</span>
                      {generating ? (
                        <span className="pulse-dot" aria-label="生成中" />
                      ) : minutesCount > 0 ? (
                        <span className="tab-badge">{minutesCount}</span>
                      ) : null}
                    </button>
                  </div>
                </div>

                <div className="card studio-panel" hidden={studioTab !== 'notes'}>
                  <div className="notes-toolbar">
                    <span>自由記錄</span>
                    <span className="toolbar-hint">自動儲存於本機</span>
                  </div>
                  <textarea
                    className="notes-textarea"
                    value={meeting.notes}
                    onChange={(e) => update({ notes: e.target.value })}
                    placeholder="在這裡寫下會議重點、想法、關鍵決策或待辦事項…"
                    aria-label="會議筆記"
                  />
                </div>

                <div className="card studio-panel" hidden={studioTab !== 'minutes'}>
                  <MinutesStudio
                    key={`minutes-${meeting.id}`}
                    meetingId={meeting.id}
                    meetingTitle={meeting.title}
                    meetingLanguages={meetingLanguages}
                    text={minutesText}
                    settings={settings}
                    onBusyChange={setGenerating}
                    onRecordsCountChange={setMinutesCount}
                  />
                </div>
              </aside>
            </div>

            <footer>
              <span>PolyMeet</span>
              <span aria-hidden="true">·</span>
              <span>本機優先會議工作區</span>
            </footer>
          </div>
        ) : (
          <div className="empty">
            <div className="empty-icon" aria-hidden="true">
              <IconBrandMark size={30} />
            </div>
            <div className="eyebrow">WELCOME TO POLYMEET</div>
            <h1>
              讓每場對話
              <br />
              都有跡可循。
            </h1>
            <p>整合即時逐字稿、雙語口譯字幕與 AI 會議紀要，資料全程保存在你的瀏覽器中。</p>
            <div className="empty-capabilities">
              <span>雙軌即時轉錄</span>
              <span>雙語同步投影字幕</span>
              <span>本機優先防遺失</span>
            </div>
            <button type="button" className="record empty-cta" onClick={create}>
              <IconPlus size={16} />
              <span>建立第一場會議</span>
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
