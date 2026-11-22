import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { listMinutes, saveMinutes } from '../db/meetingDb';
import type { MinutesAction, MinutesRecord, MinutesStyle } from '../../shared/types';
import { streamText } from '../services/apiClient';
import { downloadMinutes } from '../services/exporter';
import type { Settings } from '../services/settings';

export function MinutesStudio({
  meetingId,
  meetingLanguages,
  text,
  settings,
  onBusyChange,
}: {
  meetingId: string;
  meetingLanguages: string[];
  text: string;
  settings: Settings;
  onBusyChange: (busy: boolean) => void;
}) {
  const [records, setRecords] = useState<MinutesRecord[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [action, setAction] = useState<MinutesAction>('polish');
  const [style, setStyle] = useState<MinutesStyle>('standard');
  const [language, setLanguage] = useState('繁體中文');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const saveSequence = useRef(0);
  useEffect(() => {
    let active = true;
    setContent('');
    setActive(null);
    listMinutes(meetingId)
      .then((items) => {
        if (active) setRecords(items);
      })
      .catch(() => {
        if (active) setError('無法讀取會議紀錄。');
      });
    return () => {
      active = false;
    };
  }, [meetingId]);
  async function generate() {
    if (!text.trim()) {
      setError('請先輸入會議筆記或逐字稿。');
      return;
    }
    setBusy(true);
    onBusyChange(true);
    setError('');
    setContent('');
    setActive(null);
    let output = '';
    try {
      await streamText(
        settings,
        'minutes',
        {
          text,
          action,
          style,
          targetLanguage: language,
          meetingLanguages: meetingLanguages.join(','),
        },
        (part) => {
          output += part;
          setContent(output);
        },
        new AbortController().signal,
      );
      const record: MinutesRecord = {
        id: crypto.randomUUID(),
        meetingId,
        createdAt: Date.now(),
        action,
        style,
        targetLanguage: language,
        markdownContent: output,
      };
      await saveMinutes(record);
      setRecords((old) => [record, ...old]);
      setActive(record.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失敗，請重試。');
    } finally {
      setBusy(false);
      onBusyChange(false);
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
  const exportMetadata = records.find((record) => record.id === active) || {
    action,
    targetLanguage: language,
    style,
  };
  return (
    <section className="minutes">
      <div className="section-head">
        <div>
          <div className="eyebrow">MINUTES STUDIO</div>
          <h2>會議紀錄</h2>
        </div>
      </div>
      <div className="card minutes-card">
        <div className="minutes-controls">
          <label>
            處理方式
            <select
              value={action}
              disabled={busy}
              onChange={(e) => setAction(e.target.value as MinutesAction)}
            >
              <option value="polish">僅潤飾</option>
              <option value="translate_and_polish">翻譯並潤飾</option>
            </select>
          </label>
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
          <button className="record" disabled={busy || !language.trim()} onClick={generate}>
            {busy ? '生成中…' : '✦ 生成紀錄'}
          </button>
        </div>
        <p className="hint">使用目前的會議筆記與逐字稿產生新版本；請檢查 AI 輸出是否正確。</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {records.length > 0 && (
          <label className="version-label">
            歷史版本
            <select
              value={active ?? ''}
              disabled={busy}
              onChange={(e) => {
                const record = records.find((item) => item.id === e.target.value);
                if (record) {
                  setActive(record.id);
                  setContent(record.markdownContent);
                }
              }}
            >
              <option value="" disabled>
                選擇版本
              </option>
              {records.map((item) => (
                <option key={item.id} value={item.id}>
                  {new Date(item.createdAt).toLocaleString('zh-TW')} ·{' '}
                  {item.action === 'polish' ? '潤飾' : '翻譯'}
                </option>
              ))}
            </select>
          </label>
        )}
        {(content || busy) && (
          <>
            <div className="minutes-toolbar">
              <button className="secondary" onClick={() => setPreview(!preview)}>
                {preview ? '編輯' : '預覽'}
              </button>
              <span className="save-status" role="status">
                {saving ? '儲存中…' : active ? '修改自動保存' : ''}
              </span>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => downloadMinutes('md', content, exportMetadata)}
              >
                匯出 Markdown
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => downloadMinutes('txt', content, exportMetadata)}
              >
                匯出 TXT
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => downloadMinutes('json', content, exportMetadata)}
              >
                匯出 JSON
              </button>
            </div>
            {preview ? (
              <div
                className="markdown"
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(marked.parse(content, { async: false })),
                }}
              />
            ) : (
              <textarea
                aria-label="會議紀錄內容"
                disabled={busy}
                value={content}
                onChange={(e) => edit(e.target.value)}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}
