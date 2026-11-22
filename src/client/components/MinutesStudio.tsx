import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { listMinutes, saveMinutes } from '../db/meetingDb';
import type { MinutesAction, MinutesRecord, MinutesStyle } from '../../shared/types';
import { streamText } from '../services/apiClient';
import { downloadMinutes } from '../services/exporter';
import type { Settings } from '../services/settings';
import { IconCheck, IconCopy, IconDownload, IconSparkles, IconStop } from './Icons';

export const MinutesStudio = memo(function MinutesStudio({
  meetingId,
  meetingTitle,
  meetingLanguages,
  text,
  settings,
  onBusyChange,
  onRecordsCountChange,
}: {
  meetingId: string;
  meetingTitle: string;
  meetingLanguages: string[];
  text: string;
  settings: Settings;
  onBusyChange: (busy: boolean) => void;
  onRecordsCountChange?: (count: number) => void;
}) {
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
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const saveSequence = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const copyTimerRef = useRef<number | undefined>(undefined);

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
    listMinutes(meetingId)
      .then((items) => {
        if (!mounted) return;
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
  }, [meetingId]);

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
    setContent('');
    setActive(null);
    setPreview(false);
    let output = '';
    try {
      await streamText(
        settings,
        'minutes',
        {
          text,
          action,
          style,
          targetLanguage: language.trim(),
          meetingLanguages: languagesKey,
        },
        (part) => {
          output += part;
          setContent(output);
        },
        controller.signal,
      );
      const record: MinutesRecord = {
        id: crypto.randomUUID(),
        meetingId,
        createdAt: Date.now(),
        action,
        style,
        targetLanguage: language.trim(),
        markdownContent: output,
      };
      await saveMinutes(record);
      setRecords((old) => [record, ...old]);
      setActive(record.id);
      setPreview(true);
    } catch (e) {
      if (controller.signal.aborted) {
        setNotice(
          output ? '已停止生成，可將目前草稿儲存為版本或繼續編輯。' : '已停止生成會議紀錄。',
        );
      } else {
        setError(e instanceof Error ? e.message : '生成失敗，請重試。');
      }
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
    saveQueue.current = saveQueue.current
      .catch(() => {})
      .then(() => saveMinutes(updated))
      .then(() => {
        if (sequence === saveSequence.current) setSaving(false);
      })
      .catch(() => {
        setSaving(false);
        setError('無法保存會議紀錄，請檢查瀏覽器儲存空間。');
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
          <span className="field-caption">處理方式</span>
          <div className="segmented-control" role="group" aria-label="會議紀錄處理方式">
            <button
              type="button"
              className={action === 'polish' ? 'active' : ''}
              disabled={busy}
              aria-pressed={action === 'polish'}
              onClick={() => setAction('polish')}
            >
              僅潤飾
            </button>
            <button
              type="button"
              className={action === 'translate_and_polish' ? 'active' : ''}
              disabled={busy}
              aria-pressed={action === 'translate_and_polish'}
              onClick={() => setAction('translate_and_polish')}
            >
              翻譯並潤飾
            </button>
          </div>
        </div>

        <label>
          輸出語言
          <input
            list="minutes-languages"
            value={language}
            disabled={busy}
            onChange={(e) => setLanguage(e.target.value)}
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
            <option key={item} value={item} />
          ))}
        </datalist>

        <label>
          紀錄風格
          <select
            value={style}
            disabled={busy}
            onChange={(e) => setStyle(e.target.value as MinutesStyle)}
          >
            <option value="standard">標準紀要</option>
            <option value="action_items">行動清單優先</option>
            <option value="detailed">詳細脈絡</option>
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
                <span>停止生成</span>
              </>
            ) : (
              <>
                <IconSparkles size={15} />
                <span>生成 AI 紀錄</span>
              </>
            )}
          </button>

          {records.length > 0 && (
            <label className="version-label">
              <span>歷史版本（{records.length}）</span>
              <select
                value={active ?? ''}
                disabled={busy}
                onChange={(e) => {
                  const record = records.find((item) => item.id === e.target.value);
                  if (record) {
                    setActive(record.id);
                    setContent(record.markdownContent);
                    setNotice('');
                  }
                }}
              >
                <option value="" disabled>
                  選擇版本
                </option>
                {records.map((item) => (
                  <option key={item.id} value={item.id}>
                    {new Date(item.createdAt).toLocaleString('zh-TW')} ·{' '}
                    {item.action === 'polish' ? '潤飾' : '翻譯'} · {item.targetLanguage}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      <p className="hint">彙整會議筆記與逐字稿產出結構化紀錄；建議發表前覆核 AI 生成內容。</p>

      {notice && (
        <p className="hint status-feedback" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {(content || busy) && (
        <div className="minutes-output">
          <div className="minutes-toolbar">
            <div className="segmented-control compact" role="group" aria-label="檢視模式">
              <button
                type="button"
                className={preview ? 'active' : ''}
                aria-pressed={preview}
                onClick={() => setPreview(true)}
              >
                預覽
              </button>
              <button
                type="button"
                className={!preview ? 'active' : ''}
                aria-pressed={!preview}
                onClick={() => setPreview(false)}
              >
                編輯
              </button>
            </div>

            <div className="minutes-status-group">
              <span className="save-status" role="status">
                {busy ? '生成中…' : saving ? '儲存中…' : active ? '修改自動保存' : '未保存草稿'}
              </span>
              {!busy && content && !active && (
                <button
                  type="button"
                  className="secondary small-button"
                  disabled={saving}
                  onClick={() => void saveDraft()}
                >
                  儲存為版本
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
                <span>{copied ? '已複製' : '複製'}</span>
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
              aria-label="會議紀錄內容"
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
