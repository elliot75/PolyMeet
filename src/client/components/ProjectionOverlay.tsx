import { useI18n } from '../i18n/preferences';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptSegment } from '../../shared/types';
import { closeDialogAnimated, openDialogModal } from '../utils/dialog';
import { IconPresentation, IconX } from './Icons';

type Layout = 'stack' | 'columns' | 'face';
const MIN_FONT_SIZE = 16;
const FOLLOW_DISTANCE = 24;

interface ProjectionCaptions {
  segments: TranscriptSegment[];
  interim: string;
  translating: ReadonlyMap<string, Promise<void>>;
}

export function ProjectionHistory({ segments, interim, translating }: ProjectionCaptions) {
  const { t } = useI18n();
  const finalized = useMemo(
    () => segments.filter((segment) => segment.isFinal && segment.text.trim()),
    [segments],
  );
  const latestId = interim ? undefined : finalized.at(-1)?.id;

  return (
    <ol className="projection-history" role="list">
      {finalized.map((segment) => {
        const pending = translating.has(segment.id);
        const current = segment.id === latestId;
        return (
          <li
            key={segment.id}
            className={`projection-entry${current ? ' is-current' : ''}${pending ? ' is-translating' : ''}`}
          >
            <div className="projection-original">
              {current && <span className="projection-pill">{t('最新字幕')}</span>}
              <span>{segment.text}</span>
            </div>
            {(segment.translation || pending) && (
              <div className="projection-translation">
                {pending && <span className="projection-pill translating">{t('翻譯中…')}</span>}
                {!pending && segment.translationIsFinal === false && (
                  <span className="projection-pill muted">{t('未完成譯文：')}</span>
                )}
                {segment.translation && <span>{segment.translation}</span>}
              </div>
            )}
          </li>
        );
      })}
      {interim ? (
        <li className="projection-entry is-current">
          <div className="projection-original">
            <span className="projection-pill">{t('辨識中')}</span>
            <span>{interim}</span>
          </div>
        </li>
      ) : (
        finalized.length === 0 && (
          <li className="projection-entry">
            <div className="projection-original">{t('等待語音…')}</div>
          </li>
        )
      )}
    </ol>
  );
}

export function ProjectionOverlay({ segments, interim, translating }: ProjectionCaptions) {
  const { t, localize } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const textArea = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [fullscreenError, setFullscreenError] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [layout, setLayout] = useState<Layout>('stack');
  const [size, setSize] = useState(32);
  const [visible, setVisible] = useState(true);
  const [opened, setOpened] = useState(false);
  const [followLatest, setFollowLatest] = useState(true);
  const timer = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (opened && followLatest && textArea.current)
      textArea.current.scrollTop = textArea.current.scrollHeight;
  }, [opened, followLatest, segments, translating, interim, layout, size]);

  useEffect(() => {
    const reader = textArea.current;
    if (!opened || !followLatest || !reader) return;
    const observer = new ResizeObserver(() => {
      reader.scrollTop = reader.scrollHeight;
    });
    observer.observe(reader);
    return () => observer.disconnect();
  }, [opened, followLatest]);

  const wake = () => {
    setVisible(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setVisible(false), 3000);
  };

  const fullscreen = async () => {
    try {
      setFullscreenError('');
      if (document.fullscreenElement === surface.current) await document.exitFullscreen();
      else if (!document.fullscreenElement && surface.current?.requestFullscreen)
        await surface.current.requestFullscreen();
      else setFullscreenError('目前無法開啟全螢幕，字幕仍可在視窗中使用。');
    } catch {
      setFullscreenError('目前無法開啟全螢幕，字幕仍可在視窗中使用。');
    }
  };

  useEffect(() => {
    if (!opened) return;
    textArea.current?.focus({ preventScroll: true });
    wake();
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLElement && e.target.matches('input, textarea, select')) return;
      if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        void fullscreen();
      }
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        setSize((n) => Math.min(n + 4, 120));
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        setSize((n) => Math.max(n - 4, MIN_FONT_SIZE));
      }
      if (e.key === 'Escape' && !document.fullscreenElement) {
        e.preventDefault();
        void closeDialogAnimated(dialog.current);
      }
      wake();
    };
    const onFullscreenChange = () =>
      setIsFullscreen(document.fullscreenElement === surface.current);
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(timer.current);
    };
  }, [opened]);

  return (
    <>
      <button
        type="button"
        className="secondary projection-trigger"
        onClick={() => {
          setFullscreenError('');
          setFollowLatest(true);
          openDialogModal(dialog.current);
          setOpened(true);
        }}
      >
        <IconPresentation size={15} />
        <span>{t('投影字幕')}</span>
      </button>
      <dialog
        ref={dialog}
        className="projection"
        aria-label={t('投影字幕')}
        onCancel={(event) => {
          event.preventDefault();
          if (!document.fullscreenElement) void closeDialogAnimated(dialog.current);
        }}
        onClose={() => {
          setOpened(false);
          if (dialog.current) dialog.current.returnValue = '';
          if (document.fullscreenElement === surface.current) void document.exitFullscreen();
        }}
        onPointerMove={wake}
        onFocus={wake}
      >
        <div ref={surface} className="projection-surface">
          <div
            className={`projection-controls ${visible || !followLatest ? '' : 'hidden-controls'}`}
          >
            <div className="projection-layouts" role="group" aria-label={t('字幕版型')}>
              {(
                [
                  ['stack', t('上下字幕')],
                  ['columns', t('左右對照')],
                  ['face', t('面對面翻轉')],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={layout === id ? 'active' : ''}
                  aria-pressed={layout === id}
                  onClick={() => setLayout(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="projection-size-group">
              <button
                type="button"
                onClick={() => setSize((n) => Math.max(MIN_FONT_SIZE, n - 4))}
                aria-label={t('縮小字體')}
              >
                A−
              </button>
              <span className="projection-size-readout">{size}px</span>
              <button
                type="button"
                onClick={() => setSize((n) => Math.min(120, n + 4))}
                aria-label={t('放大字體')}
              >
                A＋
              </button>
            </div>
            <button type="button" onClick={() => void fullscreen()}>
              {isFullscreen ? t('離開全螢幕') : t('全螢幕')}
            </button>
            {!followLatest && (
              <button
                type="button"
                onClick={() => {
                  setFollowLatest(true);
                  textArea.current?.focus({ preventScroll: true });
                }}
              >
                {t('回到最新字幕')}
              </button>
            )}
            <button
              type="button"
              className="projection-exit"
              onClick={() => void closeDialogAnimated(dialog.current)}
            >
              <IconX size={15} />
              <span>{t('退出')}</span>
            </button>
            <span className="projection-shortcuts">{t('F 全螢幕 · + / - 字級 · Esc 退出')}</span>
            {fullscreenError && (
              <span className="projection-alert" role="status">
                {localize(fullscreenError)}
              </span>
            )}
          </div>
          <div
            ref={textArea}
            role="region"
            aria-label={t('字幕紀錄')}
            tabIndex={0}
            className={`projection-text ${layout}`}
            style={{ fontSize: `${size}px` }}
            onPointerDown={wake}
            onScroll={(event) => {
              const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
              setFollowLatest(scrollHeight - scrollTop - clientHeight <= FOLLOW_DISTANCE);
            }}
          >
            {opened && (
              <ProjectionHistory segments={segments} interim={interim} translating={translating} />
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}
