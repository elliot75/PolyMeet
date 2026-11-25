import { useI18n } from '../i18n/preferences';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { listMinutes, saveMinutes } from '../db/meetingDb';
import type {
  MinutesAction,
  MinutesRecord,
  MinutesStyle,
  UsageSessionKind,
} from '../../shared/types';
import { streamText } from '../services/apiClient';
import { downloadMinutes } from '../services/exporter';
import type { Settings } from '../services/settings';
import type { EditSaveQueue } from '../services/editSaveQueue';
import { IconCheck, IconCopy, IconDownload, IconSparkles, IconStop } from './Icons';

export const MinutesStudio = memo(function MinutesStudio({
  meetingId,
  meetingTitle,
  meetingLanguages,
  text,
  settings,
  onBusyChange,
  onRecordsCountChange,
  onUsageSessionCompleted,
  onUsageActivity,
  editSaves,
}: {
  meetingId: string;
  meetingTitle: string;
  meetingLanguages: string[];
  text: string;
  settings: Settings;
  onBusyChange: (busy: boolean) => void;
  onRecordsCountChange?: (count: number) => void;
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
  editSaves: EditSaveQueue<MinutesRecord>;
}) {
  const { t, locale, localize } = useI18n();
  const bilingualLabel = t('雙語對照');
  const languagesKey = meetingLanguages.join(',');
  const defaultLanguage =
    meetingLanguages.length > 1 ? '雙語對照' : meetingLanguages[0] || '繁體中文';
  const [records, setRecords] = useState<MinutesRecord[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [action, setAction] = useState<MinutesAction>('polish');
  const [style, setStyle] = useState<MinutesStyle>('standard');
  const [language, setLanguage] = useState(defaultLanguage);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const saveSequence = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const copyTimerRef = useRef<number | undefined>(undefined);

  const flushEdits = useCallback(
    () => editSaves.flush((record) => record.meetingId === meetingId),
    [editSaves, meetingId],
  );
  useEffect(
    () => () => {
      void flushEdits();
    },
    [flushEdits],
  );

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setLanguage(meetingLanguages.length > 1 ? '雙語對照' : meetingLanguages[0] || '繁體中文');
  }, [meetingId, languagesKey]);

  useEffect(() => {
    onRecordsCountChange?.(records.length);
  }, [records.length, onRecordsCountChange]);

  useEffect(() => {
    let mounted = true;
    setContent('');
    setActive(null);
    setError('');
    setNotice('');
    setCopied(false);
    flushEdits()
      .then(() => listMinutes(meetingId))
      .then((savedItems) => {
        if (!mounted) return;
        const pendingEdits = new Map(editSaves.values().map((item) => [item.id, item]));
        const items = savedItems.map((item) => pendingEdits.get(item.id) ?? item);
        setRecords(items);
        if (items.length > 0) {
          setActive(items[0].id);
          setContent(items[0].markdownContent);
          setPreview(true);
        } else {
          setPreview(false);
        }
      })
      .catch(() => {
        if (mounted) setError('無法讀取會議紀錄。');
      });
    return () => {
      mounted = false;
    };
  }, [meetingId, editSaves, flushEdits]);

  const renderedHtml = useMemo(() => {
    if (!preview || !content) return '';
    return DOMPurify.sanitize(marked.parse(content, { async: false }));
  }, [preview, content]);

  async function generate() {
    if (busy) {
      abortRef.current?.abort();
      return;
    }
    if (!text.trim()) {
      setError('請先輸入會議筆記或逐字稿。');
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    onBusyChange(true);
    setError('');
    setNotice('');
    let output = '';
    let requestSent = false;
    const usageSessionId = crypto.randomUUID();
    const startedAt = Date.now();
    try {
      if (!(await flushEdits())) {
        setError('無法保存目前的會議紀錄修改，請檢查瀏覽器儲存空間後重試。');
        return;
      }
      controller.signal.throwIfAborted();
      setContent('');
      setActive(null);
      setPreview(false);
      requestSent = true;
      await streamText(
        settings,
        'minutes',
        {
          text,
          action,
          style,
          targetLanguage: language.trim(),
          meetingLanguages: languagesKey,
          meetingId,
          meetingTitle: meetingTitle || '未命名會議',
          usageSessionId,
        },
        (part) => {
          output += part;
          setContent(output);
        },
        controller.signal,
      );
      const endedAt = Date.now();
      const record: MinutesRecord = {
        id: crypto.randomUUID(),
        meetingId,
        createdAt: endedAt,
        action,
        style,
        targetLanguage: language.trim(),
        markdownContent: output,
      };
      await saveMinutes(record);
      setRecords((old) => [record, ...old]);
      setActive(record.id);
      setPreview(true);
      await onUsageSessionCompleted?.({
        usageSessionId,
        meetingId,
        meetingTitle: meetingTitle || '未命名會議',
        kind: 'minutes',
        startedAt,
        endedAt,
        durationSeconds: Math.max(0, (endedAt - startedAt) / 1000),
      });
    } catch (e) {
      if (controller.signal.aborted) {
        setNotice(
          output ? '已停止生成，可將目前草稿儲存為版本或繼續編輯。' : '已停止生成會議紀錄。',
        );
      } else {
        setError(e instanceof Error ? e.message : '生成失敗，請重試。');
      }
      if (requestSent) void onUsageActivity?.(meetingId);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
      onBusyChange(false);
    }
  }

  async function saveDraft() {
    if (busy || active || !content.trim()) return;
    setSaving(true);
    setError('');
    try {
      const record: MinutesRecord = {
        id: crypto.randomUUID(),
        meetingId,
        createdAt: Date.now(),
        action,
        style,
        targetLanguage: language.trim() || defaultLanguage,
        markdownContent: content,
      };
      await saveMinutes(record);
      setRecords((old) => [record, ...old]);
      setActive(record.id);
      setNotice('');
    } catch {
      setError('無法保存會議紀錄，請檢查瀏覽器儲存空間。');
    } finally {
      setSaving(false);
    }
  }

  function edit(value: string) {
    setContent(value);
    const record = records.find((item) => item.id === active);
    if (!record) return;
    const updated = { ...record, markdownContent: value };
    setRecords((old) => old.map((item) => (item.id === updated.id ? updated : item)));
    const sequence = ++saveSequence.current;
    setSaving(true);
    editSaves.schedule(updated.id, updated, 250, (saved) => {
      if (sequence === saveSequence.current) setSaving(false);
      const message = '無法保存會議紀錄，請檢查瀏覽器儲存空間。';
      setError((error) => (saved ? (error === message ? '' : error) : message));
    });
  }

  async function copyContent() {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('無法複製到剪貼簿，請手動選取內容複製。');
    }
  }

  const exportMetadata = records.find((record) => record.id === active) || {
    action,
    targetLanguage: language,
    style,
  };

  return (
    <section className="minutes">
      <div className="minutes-controls">
        <div className="control-block action-block">
          <span className="field-caption">{t('處理方式')}</span>
          <div className="segmented-control" role="group" aria-label={t('會議紀錄處理方式')}>
            <button
              type="button"
              className={action === 'polish' ? 'active' : ''}
              disabled={busy}
              aria-pressed={action === 'polish'}
              onClick={() => setAction('polish')}
            >
              {t('僅潤飾')}
            </button>
            <button
              type="button"
              className={action === 'translate_and_polish' ? 'active' : ''}
              disabled={busy}
              aria-pressed={action === 'translate_and_polish'}
              onClick={() => setAction('translate_and_polish')}
            >
              {t('翻譯並潤飾')}
            </button>
          </div>
        </div>

        <label>
          {t('輸出語言')}
          <input
            list="minutes-languages"
            value={language === '雙語對照' ? bilingualLabel : language}
            disabled={busy}
            onChange={(event) =>
              setLanguage(event.target.value === bilingualLabel ? '雙語對照' : event.target.value)
            }
          />
        </label>
        <datalist id="minutes-languages">
          {[
            '繁體中文',
            '简体中文',
            'English',
            '日本語',
            '한국어',
            'Tiếng Việt',
            'ไทย',
            'Français',
            'Deutsch',
            'Español',
            '雙語對照',
          ].map((item) => (
            <option key={item} value={item === '雙語對照' ? bilingualLabel : item} />
          ))}
        </datalist>

        <label>
          {t('紀錄風格')}
          <select
            value={style}
            disabled={busy}
            onChange={(e) => setStyle(e.target.value as MinutesStyle)}
          >
            <option value="standard">{t('標準紀要')}</option>
            <option value="action_items">{t('行動清單優先')}</option>
            <option value="detailed">{t('詳細脈絡')}</option>
          </select>
        </label>

        <div className="minutes-action-row">
          <button
            type="button"
            className={busy ? 'record stop' : 'record'}
            disabled={!busy && !language.trim()}
            onClick={() => void generate()}
          >
            {busy ? (
              <>
                <IconStop size={14} />
                <span>{t('停止生成')}</span>
              </>
            ) : (
              <>
                <IconSparkles size={15} />
                <span>{t('生成 AI 紀錄')}</span>
              </>
            )}
          </button>

          {records.length > 0 && (
            <label className="version-label">
              <span>{t('歷史版本（{1}）', records.length)}</span>
              <select
                value={active ?? ''}
                disabled={busy}
                onChange={(e) => {
                  const record = records.find((item) => item.id === e.target.value);
                  if (record) {
                    void flushEdits();
                    setActive(record.id);
                    setContent(record.markdownContent);
                    setNotice('');
                  }
                }}
              >
                <option value="" disabled>
                  {t('選擇版本')}
                </option>
                {records.map((item) => (
                  <option key={item.id} value={item.id}>
                    {new Date(item.createdAt).toLocaleString(locale)} ·{' '}
                    {item.action === 'polish' ? t('潤飾') : t('翻譯')} ·{' '}
                    {item.targetLanguage === '雙語對照'
                      ? t(item.targetLanguage)
                      : item.targetLanguage}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      <p className="hint">
        {t('彙整會議筆記與逐字稿產出結構化紀錄；建議發表前覆核 AI 生成內容。')}
      </p>

      {notice && (
        <p className="hint status-feedback" role="status">
          {localize(notice)}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {localize(error)}
        </p>
      )}

      {(content || busy) && (
        <div className="minutes-output">
          <div className="minutes-toolbar">
            <div className="segmented-control compact" role="group" aria-label={t('檢視模式')}>
              <button
                type="button"
                className={preview ? 'active' : ''}
                aria-pressed={preview}
                onClick={() => setPreview(true)}
              >
                {t('預覽')}
              </button>
              <button
                type="button"
                className={!preview ? 'active' : ''}
                aria-pressed={!preview}
                onClick={() => setPreview(false)}
              >
                {t('編輯')}
              </button>
            </div>

            <div className="minutes-status-group">
              <span className="save-status" role="status">
                {busy
                  ? t('生成中…')
                  : saving
                    ? t('儲存中…')
                    : active
                      ? t('修改自動保存')
                      : t('未保存草稿')}
              </span>
              {!busy && content && !active && (
                <button
                  type="button"
                  className="secondary small-button"
                  disabled={saving}
                  onClick={() => void saveDraft()}
                >
                  {t('儲存為版本')}
                </button>
              )}
            </div>

            <div className="minutes-export-group">
              <button
                type="button"
                className="secondary small-button"
                disabled={busy || !content}
                onClick={() => void copyContent()}
              >
                {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                <span>{copied ? t('已複製') : t('複製')}</span>
              </button>
              <button
                type="button"
                className="secondary small-button"
                disabled={busy}
                onClick={() => downloadMinutes('md', content, exportMetadata, meetingTitle)}
              >
                <IconDownload size={14} />
                <span>MD</span>
              </button>
              <button
                type="button"
                className="secondary small-button"
                disabled={busy}
                onClick={() => downloadMinutes('txt', content, exportMetadata, meetingTitle)}
              >
                <IconDownload size={14} />
                <span>TXT</span>
              </button>
              <button
                type="button"
                className="secondary small-button"
                disabled={busy}
                onClick={() => downloadMinutes('json', content, exportMetadata, meetingTitle)}
              >
                <IconDownload size={14} />
                <span>JSON</span>
              </button>
            </div>
          </div>
          {preview ? (
            <div
              className="markdown"
              dangerouslySetInnerHTML={{
                __html: renderedHtml,
              }}
            />
          ) : (
            <textarea
              className="minutes-editor"
              aria-label={t('會議紀錄內容')}
              disabled={busy}
              value={content}
              onChange={(e) => edit(e.target.value)}
            />
          )}
        </div>
      )}
    </section>
  );
});
