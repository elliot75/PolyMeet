import { LanguageSelect, useI18n } from './i18n/preferences';
import type { MessageKey } from './i18n/messages';
import { formatMeetingTitle } from './i18n/format';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SettingsDialog, type ServerHealth } from './components/SettingsDialog';
import { MinutesStudio } from './components/MinutesStudio';
import { RecordingPlayer } from './components/RecordingPlayer';
import { TranscriptFeed } from './components/TranscriptFeed';
import { ProjectionOverlay } from './components/ProjectionOverlay';
import { DeleteMeetingDialog } from './components/DeleteMeetingDialog';
import { LocalWorkspace } from './components/LocalWorkspace';
import { AuthScreen } from './components/AuthScreen';
import { CompanyCopyright, CompanyLogo } from './components/CompanyBrand';
import { UsageSummaryDialog } from './components/UsageSummaryDialog';
import { UsageDashboardDialog } from './components/UsageDashboardDialog';
import { AdminDialog } from './components/AdminDialog';
import { ChangePasswordDialog } from './components/ChangePasswordDialog';
import type { AudioLevels } from './audio/localAudioMeter';
import { useRecordingSession, type LevelSubscriber } from './hooks/useRecordingSession';
import { needsTranslation, TranslationQueue } from './services/translationQueue';
import { formatTimestamp } from './services/exporter';
import { formatConvertedCurrency, formatUsd } from '../shared/pricing';
import type {
  AuthUser,
  CurrencySettings,
  MinutesRecord,
  TranscriptSegment,
  UsageSessionKind,
  UsageSessionSummary,
  UsageTimeInterval,
} from '../shared/types';
import {
  announceSessionChange,
  bindWorkspaceAccount,
  workspaceAccountId,
  WORKSPACE_SESSION_CHANGED,
} from './services/workspaceSession';
import { EditSaveQueue } from './services/editSaveQueue';
import { languageCode, languages } from '../shared/languages';
import {
  clearSessionSettings,
  defaults,
  loadSettings,
  saveSettings,
  setSettingsNamespace,
  type Settings,
} from './services/settings';
import {
  completeUsageSession,
  fetchMeetingUsage,
  fetchPricing,
  logoutUser,
  renameMeetingUsage,
} from './services/authClient';
import {
  deleteMeeting,
  getPlayableRecordingIds,
  listMeetings,
  listRecordings,
  listSegments,
  normalizeMeetingQuery,
  saveMeeting,
  searchMeetingContent,
  setMeetingDbNamespace,
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
  IconBarChart,
  IconBrandMark,
  IconFileText,
  IconMenu,
  IconMic,
  IconPause,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconShield,
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
const SEARCH_SOURCE_LABELS: Record<MeetingSearchSource, MessageKey> = {
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
  const { t } = useI18n();
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
        <span>{t('麥克風音量')}</span>
        <meter min="0" max="0.2" value={levels.mic} />
      </label>
      {both && (
        <label>
          <span>{t('分頁音量')}</span>
          <meter min="0" max="0.2" value={levels.system} />
        </label>
      )}
    </div>
  );
});

function WorkspaceApp({
  user,
  initialHealth,
  onAuthLost,
  onLogout,
}: {
  user: AuthUser;
  initialHealth: ServerHealth | null;
  onAuthLost: () => void;
  onLogout: () => Promise<void>;
}) {
  const { t, locale, localize } = useI18n();
  const selectedMeetingKey = `${SELECTED_MEETING_KEY}:${user.id}`;
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
  const [serverHealth, setServerHealth] = useState<ServerHealth | null>(initialHealth);
  const [currency, setCurrency] = useState<CurrencySettings>({ currencyCode: '', exchangeRate: 0 });
  const [meetingUsage, setMeetingUsage] = useState<UsageSessionSummary | null>(null);
  const meetingUsageRequest = useRef(0);
  const [summaryModal, setSummaryModal] = useState<{
    summary: UsageSessionSummary;
    mode: 'session' | 'meeting';
  } | null>(null);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
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
  const recordingTranslationJobs = useRef(new Map<string, Set<Promise<void>>>());
  const activeRecordingUsageSessionRef = useRef<string | null>(null);
  const translationBatchRef = useRef<{
    id: string;
    meetingId: string;
    meetingTitle: string;
    startedAt: number;
    pending: number;
    recordedCount: number;
  } | null>(null);
  const renameUsageTimerRef = useRef<number | undefined>(undefined);
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
  const meetingTitleRef = useRef('未命名會議');
  meetingTitleRef.current = meeting?.title || '未命名會議';
  const isBilingual = meeting?.mode === '雙語會議';
  const sourceLanguage = meeting?.sourceLang || '繁體中文';
  const targetLanguage = meeting?.targetLang || 'English';
  const normalizedQuery = normalizeMeetingQuery(query);

  const refreshPricingCurrency = useCallback(async () => {
    try {
      const data = await fetchPricing();
      setCurrency(data.currency);
    } catch {
      // Optional pricing metadata refresh.
    }
  }, []);

  const refreshMeetingUsage = useCallback(async (meetingId: string) => {
    if (selectedRef.current !== meetingId) return;
    const request = ++meetingUsageRequest.current;
    try {
      const { summary } = await fetchMeetingUsage(meetingId);
      if (meetingUsageRequest.current === request && selectedRef.current === meetingId) {
        setMeetingUsage(summary);
      }
    } catch {
      // Ignore transient meeting usage fetch errors.
    }
  }, []);

  const handleUsageSessionCompleted = useCallback(
    async (info: {
      usageSessionId: string;
      meetingId: string;
      meetingTitle: string;
      kind: UsageSessionKind;
      startedAt: number;
      endedAt: number;
      durationSeconds: number;
      activeIntervals?: UsageTimeInterval[];
      showDialog?: boolean;
    }) => {
      try {
        const { summary } = await completeUsageSession({
          usageSessionId: info.usageSessionId,
          meetingId: info.meetingId,
          meetingTitle: info.meetingTitle,
          kind: info.kind,
          startedAt: info.startedAt,
          endedAt: info.endedAt,
          durationSeconds: info.durationSeconds,
          activeIntervals: info.activeIntervals,
        });
        await refreshMeetingUsage(info.meetingId);
        if (info.showDialog !== false) {
          setSummaryModal({ summary, mode: 'session' });
        }
      } catch {
        // Ignore non-fatal usage summary errors.
      }
    },
    [refreshMeetingUsage],
  );

  useEffect(() => {
    void refreshPricingCurrency();
  }, [refreshPricingCurrency]);

  useEffect(() => {
    if (!selected) {
      setMeetingUsage(null);
      return;
    }
    void refreshMeetingUsage(selected);
  }, [selected, refreshMeetingUsage]);

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
      openaiTranslationReasoningEffort: settings.openaiTranslationReasoningEffort,
      geminiTranslationModel:
        settings.translationProvider === 'gemini'
          ? translationModel
          : defaults.geminiTranslationModel,
      openaiKey: settings.translationProvider === 'openai' ? translationKey : '',
      geminiKey: settings.translationProvider === 'gemini' ? translationKey : '',
    }),
    [
      settings.translationProvider,
      settings.openaiTranslationReasoningEffort,
      translationModel,
      translationKey,
    ],
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
        (reason) => {
          if (selectedRef.current !== selected || translationQueueRef.current !== queue) return;
          setTranslationStatus(
            reason === 'first-text-timeout'
              ? '即時翻譯逾時。錄音結束後可補齊未譯段落。'
              : '翻譯失敗，請檢查翻譯模型和金鑰。',
          );
        },
      ));
      const recordingUsageSessionId = activeRecordingUsageSessionRef.current;
      const isBatchOutsideRecording = !recordingUsageSessionId;
      if (isBatchOutsideRecording) {
        if (!translationBatchRef.current || translationBatchRef.current.meetingId !== selected) {
          translationBatchRef.current = {
            id: crypto.randomUUID(),
            meetingId: selected,
            meetingTitle: meetingTitleRef.current,
            startedAt: Date.now(),
            pending: 0,
            recordedCount: 0,
          };
        }
      }
      const jobs = new Map<string, Promise<void>>();
      for (const segment of items) {
        if (!segment.isFinal || !segment.text.trim() || segment.meetingId !== selected) continue;
        const batch = isBatchOutsideRecording ? translationBatchRef.current : null;
        const job = queue.add(
          segment,
          {
            meetingId: segment.meetingId,
            meetingTitle: meetingTitleRef.current,
            usageSessionId: recordingUsageSessionId ?? batch?.id,
            live: Boolean(recordingUsageSessionId),
          },
          () => {
            if (batch) batch.recordedCount += 1;
            void refreshMeetingUsage(segment.meetingId);
          },
        );
        if (!job) continue;
        if (batch) batch.pending += 1;
        if (recordingUsageSessionId) {
          const pending =
            recordingTranslationJobs.current.get(recordingUsageSessionId) ?? new Set();
          pending.add(job);
          recordingTranslationJobs.current.set(recordingUsageSessionId, pending);
        }
        jobs.set(segment.id, job);
        void job.then(() => {
          if (recordingUsageSessionId) {
            const pending = recordingTranslationJobs.current.get(recordingUsageSessionId);
            pending?.delete(job);
            if (pending?.size === 0)
              recordingTranslationJobs.current.delete(recordingUsageSessionId);
          }
          setTranslating((old) => {
            if (old.get(segment.id) !== job) return old;
            const next = new Map(old);
            next.delete(segment.id);
            return next;
          });
          if (batch && translationBatchRef.current === batch) {
            batch.pending = Math.max(0, batch.pending - 1);
            if (batch.pending === 0) {
              translationBatchRef.current = null;
              if (batch.recordedCount > 0) {
                const endedAt = Date.now();
                void handleUsageSessionCompleted({
                  usageSessionId: batch.id,
                  meetingId: batch.meetingId,
                  meetingTitle: batch.meetingTitle,
                  kind: 'translation',
                  startedAt: batch.startedAt,
                  endedAt,
                  durationSeconds: Math.max(0, (endedAt - batch.startedAt) / 1000),
                });
              }
            }
          }
        });
      }
      if (jobs.size) setTranslating((old) => new Map([...old, ...jobs]));
    },
    [
      isBilingual,
      selected,
      translationSettings,
      sourceLanguage,
      targetLanguage,
      translationSaves,
      refreshMeetingUsage,
      handleUsageSessionCompleted,
    ],
  );
  const enqueueLiveTranslation = useRef(handleTranslate);
  enqueueLiveTranslation.current = handleTranslate;

  useEffect(() => {
    setTranslating(new Map());
    setTranslationStatus('');
    translationBatchRef.current = null;
    return () => {
      translationQueueRef.current?.cancel();
      translationQueueRef.current = null;
      translationBatchRef.current = null;
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
    onActiveUsageSessionChange: (usageSessionId) => {
      activeRecordingUsageSessionRef.current = usageSessionId;
    },
    onRecordingComplete: async (info) => {
      const pending = recordingTranslationJobs.current.get(info.usageSessionId);
      const completion = { ...info, kind: 'recording' as const };
      if (pending?.size && !info.isReload) {
        await handleUsageSessionCompleted({ ...completion, showDialog: false });
        await Promise.allSettled(pending);
      }
      const meetingTitle = meetingsRef.current.find((item) => item.id === info.meetingId)?.title;
      await handleUsageSessionCompleted({
        ...completion,
        meetingTitle: meetingTitle ?? info.meetingTitle,
        showDialog: !info.isReload,
      });
    },
  });

  const workspaceLocked = recording || busy || uploading || generating;

  const refreshHealth = useCallback(async () => {
    try {
      const response = await fetch('/api/health');
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!data?.authenticated || data.user?.id !== user.id) {
        onAuthLost();
        return;
      }
      setServerHealth({
        ok: true,
        openai: Boolean(data?.serverKeys?.openai),
        gemini: Boolean(data?.serverKeys?.gemini),
      });
    } catch {
      setServerHealth({ ok: false, openai: false, gemini: false });
    }
  }, [onAuthLost, user.id]);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  useEffect(() => {
    let active = true;
    (async () => {
      const saved = await listMeetings();
      if (active) {
        setMeetings(saved);
        let previous: string | null = null;
        try {
          previous = sessionStorage.getItem(selectedMeetingKey);
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
  }, [selectedMeetingKey]);

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
        sessionStorage.setItem(selectedMeetingKey, selected);
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
  }, [selected, selectedMeetingKey, resetLiveStatus, transcriptSaves]);

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
      window.clearTimeout(renameUsageTimerRef.current);
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
      title: '',
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
    if (patch.title !== undefined) {
      const targetMeetingId = meeting.id;
      const nextTitle = patch.title;
      window.clearTimeout(renameUsageTimerRef.current);
      renameUsageTimerRef.current = window.setTimeout(() => {
        void renameMeetingUsage(targetMeetingId, nextTitle)
          .then(() => refreshMeetingUsage(targetMeetingId))
          .catch(() => {});
      }, 600);
    }
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
              normalizeMeetingQuery(formatMeetingTitle(t, item.title)).includes(normalizedQuery) ||
              normalizeMeetingQuery(item.notes).includes(normalizedQuery),
          )
        : meetings,
    [fullTextMatches, meetings, normalizedQuery, t],
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
        aria-label={t('會議側邊欄')}
      >
        <div className="brand-row">
          <div className="brand">
            <span className="brandmark" aria-hidden="true">
              <IconBrandMark size={20} />
            </span>
            <span>
              PolyMeet<small>{t('會議工作區')}</small>
            </span>
          </div>
          <button
            ref={drawerCloseRef}
            type="button"
            className="icon-button mobile-drawer-close"
            aria-label={t('關閉會議列表')}
            onClick={() => setDrawerOpen(false)}
          >
            <IconX size={18} />
          </button>
        </div>

        <button type="button" className="new" onClick={create} disabled={workspaceLocked}>
          <IconPlus size={16} />
          <span>{t('新增會議')}</span>
        </button>

        <div className="side-label">
          <span>{t('會議列表')}</span>
          <span className="count">{meetings.length}</span>
        </div>

        <div className="search">
          <IconSearch size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('搜尋會議內容…')}
            aria-label={t('搜尋會議')}
          />
          {query && (
            <button
              type="button"
              className="search-clear"
              aria-label={t('清除搜尋')}
              onClick={() => setQuery('')}
            >
              <IconX size={13} />
            </button>
          )}
        </div>

        <div className="meeting-list" aria-busy={searchPending}>
          {fullTextResult?.matches === null && (
            <p className="sidebar-empty" role="status">
              {t('無法搜尋逐字稿與 AI 紀錄')}
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
                    <strong>{formatMeetingTitle(t, m.title)}</strong>
                    {m.mode === '雙語會議' && (
                      <span className="meeting-mode-pill">{t('雙語')}</span>
                    )}
                  </span>
                  <small>{new Date(m.createdAt).toLocaleDateString(locale)}</small>
                  {fullTextMatches?.has(m.id) && (
                    <small className="meeting-search-match">
                      {t('命中')}{' '}
                      {new Intl.ListFormat(locale, { type: 'unit' }).format(
                        [...fullTextMatches.get(m.id)!].map((source) =>
                          t(SEARCH_SOURCE_LABELS[source]),
                        ),
                      )}
                    </small>
                  )}
                </span>
              </button>
            ))
          ) : searchPending ? (
            <p className="sidebar-empty">{t('搜尋中…')}</p>
          ) : meetings.length > 0 ? (
            <div className="sidebar-empty">
              <p>{t('找不到符合的會議')}</p>
              <button type="button" className="secondary small-button" onClick={() => setQuery('')}>
                {t('清除搜尋')}
              </button>
            </div>
          ) : (
            <div className="sidebar-empty">
              <p>{t('尚無會議紀錄')}</p>
            </div>
          )}
        </div>

        <LocalWorkspace
          user={user}
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
          onChangePassword={() => setPasswordDialogOpen(true)}
          onLogout={() => {
            void (async () => {
              await flushAllPendingWrites().catch(() => {});
              await onLogout().catch((error: unknown) => {
                setError(error instanceof Error ? error.message : '無法登出，請稍後再試。');
              });
            })();
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
              aria-label={t('開啟會議列表')}
              aria-expanded={drawerOpen}
              aria-controls="meeting-sidebar"
              onClick={() => setDrawerOpen((value) => !value)}
            >
              <IconMenu size={18} />
            </button>
            <CompanyLogo />
            <div className="breadcrumbs">
              <span>{t('工作空間')}</span>
              <b>/</b>
              <strong className="crumb-current">
                {meeting ? formatMeetingTitle(t, meeting.title) : t('歡迎使用')}
              </strong>
            </div>
          </div>

          <div className="top-actions">
            <button
              type="button"
              className="secondary small-button topbar-nav-btn"
              onClick={() => setDashboardOpen(true)}
            >
              <IconBarChart size={15} />
              <span>{t('費用紀錄')}</span>
            </button>
            {user.role === 'admin' && (
              <button
                type="button"
                className="secondary small-button topbar-nav-btn"
                onClick={() => setAdminOpen(true)}
              >
                <IconShield size={15} />
                <span>{t('管理後台')}</span>
              </button>
            )}
            {serverHealth === null ? (
              <span className="health-pill checking">
                <i /> {t('連線檢查中…')}
              </span>
            ) : serverHealth.ok ? (
              <span className="health-pill online">
                <i /> {t('本機後端已連線')}
              </span>
            ) : (
              <button
                type="button"
                className="health-pill offline"
                onClick={() => void refreshHealth()}
              >
                <IconRefresh size={12} />
                <span>{t('離線模式・點此重試')}</span>
              </button>
            )}
            <SettingsDialog
              settings={settings}
              user={user}
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
              <span>{localize(error)}</span>
            </p>
          </div>
        )}

        {meeting ? (
          <div className="workspace">
            <div className="heading">
              <div className="heading-main">
                <div className="eyebrow">{t('會議工作區')}</div>
                <input
                  className="title-input"
                  aria-label={t('會議名稱')}
                  placeholder={t('未命名會議')}
                  value={meeting.title}
                  onChange={(e) => update({ title: e.target.value })}
                />
                <div className="heading-meta">
                  <span>
                    {new Date(meeting.createdAt).toLocaleDateString(locale, {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                      weekday: 'short',
                    })}
                  </span>
                  <span className="dot" aria-hidden="true">
                    ·
                  </span>
                  <span>{localize(meeting.mode)}</span>
                  <span className="dot" aria-hidden="true">
                    ·
                  </span>
                  <span>{t('{1} 段逐字稿', segments.length)}</span>
                  {recordings.length > 0 && (
                    <>
                      <span className="dot" aria-hidden="true">
                        ·
                      </span>
                      <span>{t('{1} 份錄音', recordings.length)}</span>
                    </>
                  )}
                  {meetingUsage &&
                    (meetingUsage.totalTokens > 0 ||
                      meetingUsage.costUsd > 0 ||
                      meetingUsage.durationSeconds > 0 ||
                      meetingUsage.pendingCalls > 0) && (
                      <>
                        <span className="dot" aria-hidden="true">
                          ·
                        </span>
                        <button
                          type="button"
                          className="meeting-cost-pill"
                          onClick={() =>
                            setSummaryModal({ summary: meetingUsage, mode: 'meeting' })
                          }
                        >
                          {t('累計')} {formatUsd(meetingUsage.costUsd)}
                          {formatConvertedCurrency(meetingUsage.costUsd, currency, locale)
                            ? ` (${formatConvertedCurrency(meetingUsage.costUsd, currency, locale)})`
                            : ''}
                          {' · '}
                          {t('{1} Token', meetingUsage.totalTokens)}
                          {meetingUsage.pendingCalls > 0
                            ? t(' · {1} 筆待核對', meetingUsage.pendingCalls)
                            : ''}
                        </button>
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
                    ? `${paused ? t('已暫停') : t('錄音中')} ${formattedElapsed}`
                    : busy
                      ? t('處理中')
                      : t('準備就緒')}
                </span>
                <DeleteMeetingDialog
                  title={formatMeetingTitle(t, meeting.title)}
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

            <section className="card capture-card" aria-label={t('錄音與即時轉錄控制')}>
              <div className="capture-header">
                <div className="capture-title-block">
                  <div className="eyebrow">{t('收音工作區')}</div>
                  <h2>{t('即時收音與同步轉錄')}</h2>
                  <p>
                    {recording
                      ? paused
                        ? t('錄音已暫停，可隨時繼續或結束保存。')
                        : t('音訊約每秒分段保存。需要重整時，請先儲存錄音。')
                      : t('選擇會議模式、音訊來源與語言後即可開始錄音。')}
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
                        <span>{paused ? t('繼續') : t('暫停')}</span>
                      </button>
                      <button
                        type="button"
                        className="secondary save-reload"
                        disabled={busy}
                        onClick={() => void saveRecordingAndReload()}
                      >
                        <IconRefresh size={14} />
                        <span>{t('儲存錄音並重整')}</span>
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
                    <span>{recording ? t('停止錄音') : t('開始錄音')}</span>
                  </button>
                </div>
              </div>

              <div className="capture-controls">
                <div className="control-block mode-block">
                  <span className="field-caption">{t('會議模式')}</span>
                  <div className="segmented-control" role="group" aria-label={t('會議模式')}>
                    {(['一般會議', '雙語會議'] as const).map((modeOption) => (
                      <button
                        key={modeOption}
                        type="button"
                        className={meeting.mode === modeOption ? 'active' : ''}
                        disabled={workspaceLocked}
                        aria-pressed={meeting.mode === modeOption}
                        onClick={() => changeMode(modeOption)}
                      >
                        {t(modeOption)}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="control-block source-block">
                  <span>{t('音訊來源')}</span>
                  <select
                    id="source"
                    disabled={workspaceLocked}
                    value={source}
                    onChange={(e) => setSource(e.target.value as 'mic' | 'both')}
                  >
                    <option value="mic">{t('僅麥克風')}</option>
                    <option value="both">{t('麥克風 + 分頁音訊')}</option>
                  </select>
                </label>

                <div className="language-pair">
                  <label className="control-block">
                    <span>{meeting.mode === '雙語會議' ? t('語言一') : t('逐字稿語言')}</span>
                    <select
                      value={meeting.sourceLang || '繁體中文'}
                      disabled={workspaceLocked}
                      onChange={(e) => update({ sourceLang: e.target.value }, true)}
                    >
                      {languages.map((language) => (
                        <option key={language.code} lang={language.code}>
                          {language.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  {meeting.mode === '雙語會議' && (
                    <>
                      <button
                        type="button"
                        className="icon-button swap-button"
                        aria-label={t('交換語言一與語言二')}
                        disabled={workspaceLocked}
                        onClick={swapLanguages}
                      >
                        <IconSwap size={15} />
                      </button>
                      <label className="control-block">
                        <span>{t('語言二')}</span>
                        <select
                          value={meeting.targetLang || 'English'}
                          disabled={workspaceLocked}
                          onChange={(e) => update({ targetLang: e.target.value }, true)}
                        >
                          {languages.map((language) => (
                            <option key={language.code} lang={language.code}>
                              {language.label}
                            </option>
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
                    <span>{t('啟用即時轉錄')}</span>
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
                  {localize(liveStatus)}
                </p>
              )}
              {translationStatus && (
                <p className="error" role="alert">
                  <IconAlertCircle size={15} />
                  <span>{localize(translationStatus)}</span>
                </p>
              )}
              {error && (
                <p className="error" role="alert">
                  <IconAlertCircle size={15} />
                  <span>{localize(error)}</span>
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
                  onUsageSessionCompleted={handleUsageSessionCompleted}
                  onUsageActivity={refreshMeetingUsage}
                  editSaves={transcriptSaves}
                  settings={settings}
                  locked={recording || busy || generating}
                />
              </div>

              <aside className="studio-column" aria-label={t('筆記與會議紀錄工作區')}>
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
                      <span>{t('會議筆記')}</span>
                      {meeting.notes.length > 0 && (
                        <span className="tab-badge">{t('{1} 字', meeting.notes.length)}</span>
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
                      <span>{t('AI 紀錄')}</span>
                      {generating ? (
                        <span className="pulse-dot" aria-label={t('生成中')} />
                      ) : minutesCount > 0 ? (
                        <span className="tab-badge">{minutesCount}</span>
                      ) : null}
                    </button>
                  </div>
                </div>

                <div className="card studio-panel" hidden={studioTab !== 'notes'}>
                  <div className="notes-toolbar">
                    <span>{t('自由記錄')}</span>
                    <span className="toolbar-hint">{t('自動儲存於本機')}</span>
                  </div>
                  <textarea
                    className="notes-textarea"
                    value={meeting.notes}
                    onChange={(e) => update({ notes: e.target.value })}
                    placeholder={t('在這裡寫下會議重點、想法、關鍵決策或待辦事項…')}
                    aria-label={t('會議筆記')}
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
                    onUsageSessionCompleted={handleUsageSessionCompleted}
                    onUsageActivity={refreshMeetingUsage}
                    editSaves={minutesSaves}
                  />
                </div>
              </aside>
            </div>
          </div>
        ) : (
          <div className="empty">
            <div className="empty-icon" aria-hidden="true">
              <IconBrandMark size={30} />
            </div>
            <div className="eyebrow">{t('歡迎使用 PolyMeet')}</div>
            <h1>
              {t('讓每場對話')}
              <br />
              {t('都有跡可循。')}
            </h1>
            <p>
              {t(
                '會議資料保存在此瀏覽器。使用轉錄、翻譯與 AI 紀錄時，相關音訊或文字會傳送至你選擇的服務。',
              )}
            </p>
            <div className="empty-capabilities">
              <span>{t('雙軌即時轉錄')}</span>
              <span>{t('雙語同步投影字幕')}</span>
              <span>{t('本機優先防遺失')}</span>
            </div>
            <button type="button" className="record empty-cta" onClick={create}>
              <IconPlus size={16} />
              <span>{t('建立第一場會議')}</span>
            </button>
          </div>
        )}
        <CompanyCopyright />
      </main>

      <UsageSummaryDialog
        summary={summaryModal?.summary ?? null}
        mode={summaryModal?.mode ?? 'session'}
        currency={currency}
        onClose={() => setSummaryModal(null)}
        onOpenDashboard={() => setDashboardOpen(true)}
      />

      <UsageDashboardDialog open={dashboardOpen} onClose={() => setDashboardOpen(false)} />

      <ChangePasswordDialog
        open={passwordDialogOpen}
        onClose={() => setPasswordDialogOpen(false)}
      />

      {user.role === 'admin' && (
        <AdminDialog
          open={adminOpen}
          currentUser={user}
          onClose={() => setAdminOpen(false)}
          onPricingChanged={() => void refreshPricingCurrency()}
        />
      )}
    </div>
  );
}

export function App() {
  const { t, localize } = useI18n();
  const [status, setStatus] = useState<'loading' | 'unauthenticated' | 'authenticated'>('loading');
  const [needsSetup, setNeedsSetup] = useState(false);
  const [setupAvailable, setSetupAvailable] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [initialHealth, setInitialHealth] = useState<ServerHealth | null>(null);
  const [loadError, setLoadError] = useState('');
  const [accountChanged, setAccountChanged] = useState(false);
  const authCheck = useRef(0);

  const handleAuthLost = useCallback(() => {
    authCheck.current += 1;
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  const bootstrapAuth = useCallback(
    async (initial = false) => {
      const check = ++authCheck.current;
      if (initial) setLoadError('');
      try {
        const response = await fetch('/api/health');
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (check !== authCheck.current) return;
        const nextUser = data?.authenticated ? (data.user as AuthUser) : null;
        setNeedsSetup(Boolean(data?.needsSetup));
        setSetupAvailable(Boolean(data?.setupAvailable));
        if (nextUser && !bindWorkspaceAccount(nextUser.id)) {
          handleAuthLost();
          setAccountChanged(true);
          return;
        }
        if (nextUser) {
          setMeetingDbNamespace(nextUser.id);
          setSettingsNamespace(nextUser.id);
        }
        setInitialHealth({
          ok: true,
          openai: Boolean(data?.serverKeys?.openai),
          gemini: Boolean(data?.serverKeys?.gemini),
        });
        setAccountChanged(false);
        setUser(nextUser);
        setStatus(nextUser ? 'authenticated' : 'unauthenticated');
        setLoadError('');
      } catch {
        if (initial && check === authCheck.current) {
          setLoadError('無法連線至 PolyMeet 後端服務，請確認伺服器已啟動。');
          setStatus('unauthenticated');
        }
      }
    },
    [handleAuthLost],
  );

  useEffect(() => {
    const check = () => void bootstrapAuth(!workspaceAccountId());
    const checkStorage = (event: StorageEvent) => {
      if (event.key === WORKSPACE_SESSION_CHANGED) check();
    };
    const sessionLost = () => {
      handleAuthLost();
      check();
    };
    void bootstrapAuth(true);
    window.addEventListener('focus', check);
    window.addEventListener('pageshow', check);
    window.addEventListener('storage', checkStorage);
    window.addEventListener(WORKSPACE_SESSION_CHANGED, sessionLost);
    return () => {
      authCheck.current += 1;
      window.removeEventListener('focus', check);
      window.removeEventListener('pageshow', check);
      window.removeEventListener('storage', checkStorage);
      window.removeEventListener(WORKSPACE_SESSION_CHANGED, sessionLost);
    };
  }, [bootstrapAuth, handleAuthLost]);

  const handleAuthenticated = useCallback(
    (nextUser: AuthUser) => {
      announceSessionChange();
      if (!bindWorkspaceAccount(nextUser.id)) {
        window.location.reload();
        return;
      }
      void bootstrapAuth(true);
    },
    [bootstrapAuth],
  );

  const handleLogout = useCallback(async () => {
    try {
      await logoutUser();
    } catch {
      // Always clear local session keys and workspace state even if the backend is unreachable.
    } finally {
      clearSessionSettings();
      announceSessionChange();
      handleAuthLost();
      setInitialHealth({ ok: true, openai: false, gemini: false });
    }
  }, [handleAuthLost]);

  if (status === 'loading') {
    return (
      <div className="auth-screen">
        <div className="auth-card auth-loading">
          <div className="auth-brand">
            <CompanyLogo />
            <div>
              <strong>PolyMeet</strong>
              <small>{t('正在檢查登入狀態…')}</small>
            </div>
          </div>
          <CompanyCopyright />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <LanguageSelect />
          <p className="error" role="alert">
            <IconAlertCircle size={16} />
            <span>{localize(loadError)}</span>
          </p>
          <button type="button" className="record" onClick={() => void bootstrapAuth(true)}>
            <IconRefresh size={15} />
            <span>{t('重新連線')}</span>
          </button>
        </div>
      </div>
    );
  }

  if (accountChanged) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <LanguageSelect />
          <p role="status">{t('其他分頁已切換登入帳號。請重新開啟工作區。')}</p>
          <button type="button" className="record" onClick={() => window.location.reload()}>
            {t('重新開啟工作區')}
          </button>
        </div>
      </div>
    );
  }

  if (status !== 'authenticated' || !user) {
    return (
      <AuthScreen
        key={String(needsSetup)}
        needsSetup={needsSetup}
        setupAvailable={setupAvailable}
        onAuthenticated={handleAuthenticated}
      />
    );
  }

  return (
    <WorkspaceApp
      key={user.id}
      user={user}
      initialHealth={initialHealth}
      onAuthLost={handleAuthLost}
      onLogout={handleLogout}
    />
  );
}
