import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SettingsDialog, type ServerHealth } from './components/SettingsDialog';
import { MinutesStudio } from './components/MinutesStudio';
import { RecordingPlayer } from './components/RecordingPlayer';
import { TranscriptFeed } from './components/TranscriptFeed';
import { ProjectionOverlay } from './components/ProjectionOverlay';
import { DeleteMeetingDialog } from './components/DeleteMeetingDialog';
import { LocalWorkspace } from './components/LocalWorkspace';
import type { AudioLevels } from './audio/localAudioMeter';
import { useRecordingSession, type LevelSubscriber } from './hooks/useRecordingSession';
import { needsTranslation, TranslationQueue } from './services/translationQueue';
import { formatTimestamp } from './services/exporter';
import type { MinutesRecord, TranscriptSegment } from '../shared/types';
import { EditSaveQueue } from './services/editSaveQueue';
import { languageCode, languages } from '../shared/languages';
import { defaults, loadSettings, saveSettings, type Settings } from './services/settings';
import {
  deleteMeeting,
  getPlayableRecordingIds,
  listMeetings,
  listRecordings,
  listSegments,
  migrateMeetings,
  normalizeMeetingQuery,
  saveMeeting,
  searchMeetingContent,
  subscribeToMeetingContent,
  updateSegmentTranslation,
  updateSegmentText,
  saveMinutes,
  type Meeting,
  type MeetingSearchSource,
  type Recording,
} from './db/meetingDb';
import {
  IconAlertCircle,
  IconBrandMark,
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

interface TranscriptEdit {
  id: string;
  meetingId: string;
  text: string;
}

interface TranslationEdit {
  segment: TranscriptSegment;
  text: string;
  final: boolean;
  signal: AbortSignal;
  onSaved: () => void;
}

const SELECTED_MEETING_KEY = 'polymeet-selected-meeting';
const SEARCH_SOURCE_LABELS: Record<MeetingSearchSource, string> = {
  transcript: '逐字稿',
  translation: '譯文',
  minutes: 'AI 紀錄',
};

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

export function App() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchResult, setSearchResult] = useState<{
    term: string;
    matches: Awaited<ReturnType<typeof searchMeetingContent>> | null;
  }>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [studioTab, setStudioTab] = useState<'notes' | 'minutes'>('notes');
  const [minutesCount, setMinutesCount] = useState(0);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [serverHealth, setServerHealth] = useState<ServerHealth | null>(null);
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [source, setSource] = useState<'mic' | 'both'>('mic');
  const [liveEnabled, setLiveEnabled] = useState(true);
  const [translationStatus, setTranslationStatus] = useState('');
  const [error, setError] = useState('');
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [playableRecordingIds, setPlayableRecordingIds] = useState<Set<string> | null | undefined>(
    null,
  );
  const [recordingToTranscribe, setRecordingToTranscribe] = useState<Recording | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [translating, setTranslating] = useState(new Map<string, Promise<void>>());

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const meetingsRef = useRef<Meeting[]>([]);
  meetingsRef.current = meetings;
  const translationQueueRef = useRef<TranslationQueue | null>(null);
  const [meetingSaves] = useState(() => new EditSaveQueue<Meeting>(saveMeeting));
  const [transcriptSaves] = useState(
    () => new EditSaveQueue<TranscriptEdit>(({ id, text }) => updateSegmentText(id, text)),
  );
  const [minutesSaves] = useState(() => new EditSaveQueue<MinutesRecord>(saveMinutes));
  const [translationSaves] = useState(
    () =>
      new EditSaveQueue<TranslationEdit>(async ({ segment, text, final, signal, onSaved }) => {
        if (
          !signal.aborted &&
          (await updateSegmentTranslation(segment.id, text, final, segment.text, signal))
        ) {
          onSaved();
        }
      }),
  );
  const seekHandlersRef = useRef(new WeakMap<HTMLAudioElement, () => void>());
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const wasDrawerOpenRef = useRef(false);

  const meeting = meetings.find((m) => m.id === selected);
  const isBilingual = meeting?.mode === '雙語會議';
  const sourceLanguage = meeting?.sourceLang || '繁體中文';
  const targetLanguage = meeting?.targetLang || 'English';
  const normalizedQuery = normalizeMeetingQuery(query);

  const translationKey =
    settings.translationProvider === 'openai' ? settings.openaiKey : settings.geminiKey;
  const translationModel =
    settings.translationProvider === 'openai'
      ? settings.openaiTranslationModel
      : settings.geminiTranslationModel;
  const translationSettings = useMemo<Settings>(
    () => ({
      ...defaults,
      translationProvider: settings.translationProvider,
      openaiTranslationModel:
        settings.translationProvider === 'openai'
          ? translationModel
          : defaults.openaiTranslationModel,
      geminiTranslationModel:
        settings.translationProvider === 'gemini'
          ? translationModel
          : defaults.geminiTranslationModel,
      openaiKey: settings.translationProvider === 'openai' ? translationKey : '',
      geminiKey: settings.translationProvider === 'gemini' ? translationKey : '',
    }),
    [settings.translationProvider, translationModel, translationKey],
  );

  useEffect(() => {
    if (!normalizedQuery) return;
    let active = true;
    let timer: number | undefined;
    let latestRequest = 0;
    const scheduleSearch = () => {
      if (timer !== undefined) return;
      timer = window.setTimeout(async () => {
        timer = undefined;
        const request = ++latestRequest;
        const matches = await searchMeetingContent(normalizedQuery).catch(() => null);
        if (active && request === latestRequest)
          setSearchResult({ term: normalizedQuery, matches });
      }, 180);
    };
    const unsubscribe = subscribeToMeetingContent(scheduleSearch);
    scheduleSearch();
    return () => {
      active = false;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [normalizedQuery]);

  const handleTranslate = useCallback(
    (items: TranscriptSegment[]) => {
      if (!isBilingual || !selected || selectedRef.current !== selected || !items.length) return;
      if (sourceLanguage === targetLanguage) {
        setTranslationStatus('請選擇兩種不同的語言。');
        return;
      }
      setTranslationStatus('');
      const queue: TranslationQueue = (translationQueueRef.current ??= new TranslationQueue(
        translationSettings,
        sourceLanguage,
        targetLanguage,
        (segment, text, final, signal) => {
          if (!text.trim()) return;
          const onSaved = () => {
            if (
              signal.aborted ||
              selectedRef.current !== segment.meetingId ||
              translationQueueRef.current !== queue
            )
              return;
            setSegments((old) =>
              old.map((item) =>
                item.id === segment.id && item.text === segment.text
                  ? { ...item, translation: text, translationIsFinal: final }
                  : item,
              ),
            );
          };
          return translationSaves.schedule(
            segment.id,
            { segment, text, final, signal, onSaved },
            0,
            (saved) => {
              if (translationQueueRef.current !== queue) return;
              const message = '無法保存譯文，請檢查瀏覽器儲存空間。';
              setTranslationStatus((status) =>
                saved ? (status === message ? '' : status) : message,
              );
            },
          );
        },
        () => {
          if (selectedRef.current === selected)
            setTranslationStatus('翻譯失敗，請檢查翻譯模型和金鑰。');
        },
      ));
      const jobs = new Map<string, Promise<void>>();
      for (const segment of items) {
        if (!segment.isFinal || !segment.text.trim() || segment.meetingId !== selected) continue;
        const job = queue.add(segment);
        if (!job) continue;
        jobs.set(segment.id, job);
        void job.then(() => {
          setTranslating((old) => {
            if (old.get(segment.id) !== job) return old;
            const next = new Map(old);
            next.delete(segment.id);
            return next;
          });
        });
      }
      if (jobs.size) setTranslating((old) => new Map([...old, ...jobs]));
    },
    [isBilingual, selected, translationSettings, sourceLanguage, targetLanguage, translationSaves],
  );
  const enqueueLiveTranslation = useRef(handleTranslate);
  enqueueLiveTranslation.current = handleTranslate;

  useEffect(() => {
    setTranslating(new Map());
    setTranslationStatus('');
    return () => {
      translationQueueRef.current?.cancel();
      translationQueueRef.current = null;
    };
  }, [handleTranslate]);

  const flushAllPendingWrites = useCallback(
    async (meetingId?: string): Promise<boolean> => {
      const includes = (id: string) => meetingId === undefined || id === meetingId;
      const results = await Promise.all([
        meetingSaves.flush((item) => includes(item.id)),
        transcriptSaves.flush((item) => includes(item.meetingId)),
        minutesSaves.flush((item) => includes(item.meetingId)),
        translationSaves.flush((item) => includes(item.segment.meetingId)),
      ]);
      return results.every(Boolean);
    },
    [meetingSaves, transcriptSaves, minutesSaves, translationSaves],
  );

  const onFinishTranslationsForReload = useCallback(async () => {
    const queue = translationQueueRef.current;
    // Retry any available write while its translation is still active.
    await Promise.all([queue?.finish(3000), translationSaves.flush()]);
    if (translationQueueRef.current === queue) translationQueueRef.current = null;
  }, [translationSaves]);

  const onAppendLiveSegment = useCallback((saved: Recording, segment: TranscriptSegment) => {
    if (selectedRef.current !== saved.meetingId) return;
    setSegments((old) => [
      ...old.filter((item) => item.recordingId !== saved.id),
      ...[
        ...old.filter((item) => item.recordingId === saved.id && item.id !== segment.id),
        segment,
      ].sort((a, b) => a.startedAtMs - b.startedAtMs),
    ]);
  }, []);

  const onDraftsRecovered = useCallback((saved: Recording, drafts: TranscriptSegment[]) => {
    if (selectedRef.current !== saved.meetingId || !drafts.length) return;
    setSegments((items) => [
      ...items.filter((item) => item.recordingId !== saved.id),
      ...[...items.filter((item) => item.recordingId === saved.id), ...drafts].sort(
        (a, b) => a.startedAtMs - b.startedAtMs,
      ),
    ]);
  }, []);

  const onRecordingsUpdated = useCallback((meetingId: string, updatedRecordings: Recording[]) => {
    if (selectedRef.current === meetingId) setRecordings(updatedRecordings);
  }, []);

  const {
    recording,
    savingRecording,
    busy,
    paused,
    elapsed,
    liveStatus,
    interims,
    subscribeLevels,
    start,
    stop,
    togglePause,
    saveRecordingAndReload,
    resetLiveStatus,
  } = useRecordingSession({
    meeting,
    source,
    liveEnabled,
    settings,
    uploading,
    generating,
    selectedRef,
    onError: setError,
    onTranslationStatus: setTranslationStatus,
    onAppendSegment: onAppendLiveSegment,
    onEnqueueTranslation: (items) => enqueueLiveTranslation.current(items),
    onDraftsRecovered,
    onRecordingsUpdated,
    onFinishTranslationsForReload,
    onFlushAll: flushAllPendingWrites,
  });

  const workspaceLocked = recording || busy || uploading || generating;

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
        let previous: string | null = null;
        try {
          previous = sessionStorage.getItem(SELECTED_MEETING_KEY);
        } catch {
          // Session storage is optional; the meetings themselves are in IndexedDB.
        }
        setSelected(saved.find((item) => item.id === previous)?.id ?? saved[0]?.id ?? null);
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
    setPlayableRecordingIds(null);
    setRecordingToTranscribe(null);
    setSegments([]);
    setMinutesCount(0);
    resetLiveStatus();
    setError('');
    if (selected) {
      try {
        sessionStorage.setItem(SELECTED_MEETING_KEY, selected);
      } catch {
        // Some browser configurations disable session storage.
      }
      transcriptSaves
        .flush((edit) => edit.meetingId === selected)
        .then(() => listSegments(selected))
        .then((items) => {
          if (!active) return;
          const pendingEdits = new Map(
            transcriptSaves.values().map((edit) => [edit.id, edit.text]),
          );
          setSegments(
            items.map((item) => {
              const text = pendingEdits.get(item.id);
              return text === undefined
                ? item
                : { ...item, text, translation: undefined, translationIsFinal: undefined };
            }),
          );
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
  }, [selected, resetLiveStatus, transcriptSaves]);

  useEffect(() => {
    if (!recordings.length) {
      setPlayableRecordingIds(null);
      return;
    }
    let active = true;
    void getPlayableRecordingIds(recordings.map((item) => item.id))
      .then((ids) => {
        if (active) setPlayableRecordingIds(ids);
      })
      .catch(() => {
        if (active) setPlayableRecordingIds(undefined);
      });
    return () => {
      active = false;
    };
  }, [recordings]);

  useEffect(() => {
    const flushOnHide = () => {
      if (document.visibilityState === 'hidden') void flushAllPendingWrites();
    };
    document.addEventListener('visibilitychange', flushOnHide);
    return () => {
      document.removeEventListener('visibilitychange', flushOnHide);
      void flushAllPendingWrites();
    };
  }, [flushAllPendingWrites]);

  useEffect(() => {
    if (drawerOpen) {
      wasDrawerOpenRef.current = true;
      drawerCloseRef.current?.focus({ preventScroll: true });
    } else if (wasDrawerOpenRef.current) {
      wasDrawerOpenRef.current = false;
      mobileMenuButtonRef.current?.focus();
    }
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) setDrawerOpen(false);
    };
    const narrowViewport = window.matchMedia('(max-width: 860px)');
    const onResize = () => {
      if (!narrowViewport.matches) setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    narrowViewport.addEventListener('change', onResize);
    onResize();
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      narrowViewport.removeEventListener('change', onResize);
    };
  }, [drawerOpen]);

  function persist(m: Meeting, immediate = false) {
    meetingSaves.schedule(m.id, m, immediate ? 0 : 180, (saved) => {
      const message = '無法儲存會議資料，請檢查瀏覽器儲存空間。';
      setError((error) => (saved ? (error === message ? '' : error) : message));
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
        ...segments
          .filter((segment) => segment.isFinal)
          .map((segment) => {
            const original = `${segment.speakerLabel}: ${segment.text}`;
            return segment.translation && segment.translationIsFinal !== false
              ? `${original}\n譯文: ${segment.translation}`
              : original;
          }),
      ]
        .filter(Boolean)
        .join('\n\n'),
    [meeting?.notes, segments],
  );

  const handleTranscriptionSaved = useCallback(
    (sourceRecording: Recording, added: TranscriptSegment[], previous?: TranscriptSegment[]) => {
      if (selectedRef.current !== sourceRecording.meetingId) return;
      const replaced = new Set(previous?.map((item) => item.id));
      for (const id of replaced) {
        translationQueueRef.current?.remove(id);
        translationSaves.discard(id);
      }
      const starts = new Map(recordings.map((item) => [item.id, item.createdAt]));
      starts.set(sourceRecording.id, sourceRecording.createdAt);
      setSegments((old) =>
        [...old.filter((item) => !replaced.has(item.id)), ...added].sort(
          (a, b) =>
            (starts.get(a.recordingId ?? '') ?? 0) - (starts.get(b.recordingId ?? '') ?? 0) ||
            a.startedAtMs - b.startedAtMs,
        ),
      );
      handleTranslate(added.filter(needsTranslation));
    },
    [handleTranslate, recordings, translationSaves],
  );

  const handleSegmentTextChange = useCallback(
    (id: string, text: string) => {
      translationQueueRef.current?.remove(id);
      translationSaves.discard(id);
      setTranslating((old) => {
        if (!old.has(id)) return old;
        const next = new Map(old);
        next.delete(id);
        return next;
      });
      setSegments((old) =>
        old.map((item) =>
          item.id === id
            ? { ...item, text, translation: undefined, translationIsFinal: undefined }
            : item,
        ),
      );
    },
    [translationSaves],
  );

  const handleFinalizeSegment = useCallback(
    (updated: TranscriptSegment) => {
      if (selectedRef.current !== updated.meetingId) return;
      setSegments((old) => old.map((item) => (item.id === updated.id ? updated : item)));
      if (needsTranslation(updated)) handleTranslate([updated]);
    },
    [handleTranslate],
  );

  const handleDeleteSegment = useCallback(
    (id: string) => {
      translationQueueRef.current?.remove(id);
      translationSaves.discard(id);
      setTranslating((old) => {
        if (!old.has(id)) return old;
        const next = new Map(old);
        next.delete(id);
        return next;
      });
      setSegments((old) => old.filter((item) => item.id !== id));
    },
    [translationSaves],
  );

  const closeRecordingTranscription = useCallback(() => setRecordingToTranscribe(null), []);

  const handleSpeakerChange = useCallback(
    (meetingId: string, ids: string[], speakerLabel: string) => {
      if (selectedRef.current !== meetingId) return;
      const changed = new Set(ids);
      setSegments((old) =>
        old.map((item) => (changed.has(item.id) ? { ...item, speakerLabel } : item)),
      );
    },
    [],
  );

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
    if (!audio) {
      setError('無法播放錄音，請確認錄音是否已載入。');
      return;
    }
    const pending = seekHandlersRef.current.get(audio);
    if (pending) {
      audio.removeEventListener('loadedmetadata', pending);
      seekHandlersRef.current.delete(audio);
    }
    const jumpAndPlay = () => {
      seekHandlersRef.current.delete(audio);
      if (!audio.isConnected) return;
      audio.currentTime = seconds;
      audio.scrollIntoView({
        block: 'center',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
      void audio.play().catch(() => setError('無法播放錄音，請使用錄音播放器。'));
    };
    if (audio.readyState < 1) {
      seekHandlersRef.current.set(audio, jumpAndPlay);
      audio.addEventListener('loadedmetadata', jumpAndPlay, { once: true });
    } else {
      jumpAndPlay();
    }
  }, []);

  const handleSaveSettings = useCallback((value: Settings) => {
    saveSettings(value);
    setSettings(value);
  }, []);

  const fullTextResult = searchResult?.term === normalizedQuery ? searchResult : undefined;
  const searchPending = Boolean(normalizedQuery && !fullTextResult);
  const fullTextMatches = fullTextResult?.matches;
  const filteredMeetings = useMemo(
    () =>
      normalizedQuery
        ? meetings.filter(
            (item) =>
              fullTextMatches?.has(item.id) ||
              normalizeMeetingQuery(item.title).includes(normalizedQuery) ||
              normalizeMeetingQuery(item.notes).includes(normalizedQuery),
          )
        : meetings,
    [fullTextMatches, meetings, normalizedQuery],
  );
  const formattedElapsed = formatTimestamp(elapsed * 1000);

  return (
    <div className="app">
      {drawerOpen && (
        <div className="sidebar-backdrop" aria-hidden="true" onClick={() => setDrawerOpen(false)} />
      )}
      <aside
        id="meeting-sidebar"
        className={`sidebar ${drawerOpen ? 'open' : ''}`}
        role={drawerOpen ? 'dialog' : undefined}
        aria-modal={drawerOpen || undefined}
        aria-label="會議側邊欄"
      >
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

        <div className="search">
          <IconSearch size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜尋會議內容…"
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
        </div>

        <div className="meeting-list" aria-busy={searchPending}>
          {fullTextResult?.matches === null && (
            <p className="sidebar-empty" role="status">
              無法搜尋逐字稿與 AI 紀錄
            </p>
          )}
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
                  {fullTextMatches?.has(m.id) && (
                    <small className="meeting-search-match">
                      命中{' '}
                      {[...fullTextMatches.get(m.id)!]
                        .map((source) => SEARCH_SOURCE_LABELS[source])
                        .join('、')}
                    </small>
                  )}
                </span>
              </button>
            ))
          ) : searchPending ? (
            <p className="sidebar-empty">搜尋中…</p>
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

        <LocalWorkspace
          selectedMeeting={meeting}
          meetingCount={meetings.length}
          locked={workspaceLocked || savingRecording}
          onBeforeExport={flushAllPendingWrites}
          onImported={(imported) => {
            setMeetings((current) =>
              [...current, ...imported].sort((a, b) => b.createdAt - a.createdAt),
            );
            setSelected((current) => current ?? imported[0]?.id ?? null);
          }}
        />
      </aside>

      <main inert={drawerOpen}>
        <header className="topbar">
          <div className="topbar-left">
            <button
              ref={mobileMenuButtonRef}
              type="button"
              className="icon-button mobile-menu-button"
              aria-label="開啟會議列表"
              aria-expanded={drawerOpen}
              aria-controls="meeting-sidebar"
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
                    translationQueueRef.current = null;
                    await flushAllPendingWrites(meeting.id);
                    await deleteMeeting(meeting.id);
                    meetingSaves.discard(meeting.id);
                    transcriptSaves.discardWhere((item) => item.meetingId === meeting.id);
                    minutesSaves.discardWhere((item) => item.meetingId === meeting.id);
                    translationSaves.discardWhere((item) => item.segment.meetingId === meeting.id);
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
                        : '音訊約每秒分段保存。需要重整時，請先儲存錄音。'
                      : '選擇會議模式、音訊來源與語言後即可開始錄音。'}
                  </p>
                </div>

                <div className="capture-actions">
                  <LiveWaveBars active={recording && !paused} subscribeLevels={subscribeLevels} />
                  {recording && (
                    <>
                      <button
                        type="button"
                        className="pause"
                        disabled={busy}
                        onClick={() => void togglePause()}
                      >
                        <IconPause size={14} />
                        <span>{paused ? '繼續' : '暫停'}</span>
                      </button>
                      <button
                        type="button"
                        className="secondary save-reload"
                        disabled={busy}
                        onClick={() => void saveRecordingAndReload()}
                      >
                        <IconRefresh size={14} />
                        <span>儲存錄音並重整</span>
                      </button>
                    </>
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
                active={recording && !paused}
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
                    <RecordingPlayer
                      key={item.id}
                      recording={item}
                      hasAudio={
                        playableRecordingIds
                          ? playableRecordingIds.has(item.id)
                          : playableRecordingIds
                      }
                      disabled={workspaceLocked}
                      onTranscribe={setRecordingToTranscribe}
                    />
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
                  isBilingual={isBilingual}
                  languageHints={languageHints}
                  segments={segments}
                  recordings={recordings}
                  playableRecordingIds={playableRecordingIds}
                  interims={interims}
                  recordingToTranscribe={
                    recordingToTranscribe?.meetingId === meeting.id ? recordingToTranscribe : null
                  }
                  translating={translating}
                  onAppend={handleTranscriptionSaved}
                  onCloseRecordingTranscription={closeRecordingTranscription}
                  onTranslate={handleTranslate}
                  onTextChange={handleSegmentTextChange}
                  onFinalizeSegment={handleFinalizeSegment}
                  onDeleteSegment={handleDeleteSegment}
                  onSpeakerChange={handleSpeakerChange}
                  onRecordingSaved={handleRecordingSaved}
                  onBusyChange={setUploading}
                  onSeek={handleSeekRecording}
                  editSaves={transcriptSaves}
                  settings={settings}
                  locked={recording || busy || generating}
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
                    editSaves={minutesSaves}
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
            <p>
              會議資料保存在此瀏覽器。使用轉錄、翻譯與 AI
              紀錄時，相關音訊或文字會傳送至你選擇的服務。
            </p>
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
