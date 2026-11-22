import { useEffect, useRef, useState } from 'react';
import type { TranscriptSegment } from '../../shared/types';
import { closeDialogAnimated, openDialogModal } from '../utils/dialog';
import { IconPresentation, IconX } from './Icons';

type Layout = 'stack' | 'columns' | 'face';

export function ProjectionOverlay({
  segments,
  interim,
}: {
  segments: TranscriptSegment[];
  interim: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const textArea = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [fullscreenError, setFullscreenError] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [layout, setLayout] = useState<Layout>('stack');
  const [size, setSize] = useState(48);
  const [visible, setVisible] = useState(true);
  const [opened, setOpened] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const finalized = segments.filter((segment) => segment.isFinal);
  const latest = finalized.at(-1);
  const previous = finalized.at(-2);

  useEffect(() => {
    if (opened && textArea.current) {
      textArea.current.scrollTo({
        top: textArea.current.scrollHeight,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
    }
  }, [opened, interim, latest?.text, latest?.translation]);

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
    textArea.current?.focus();
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
        setSize((n) => Math.max(n - 4, 24));
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

  const contextText = interim ? latest?.text : previous?.text;
  const activeOriginal = interim || latest?.text || '等待語音…';
  const activeTranslation = latest?.translation || (latest ? '翻譯中…' : '翻譯將顯示在這裡');

  return (
    <>
      <button
        type="button"
        className="secondary projection-trigger"
        onClick={() => {
          setFullscreenError('');
          openDialogModal(dialog.current);
          setOpened(true);
        }}
      >
        <IconPresentation size={15} />
        <span>投影字幕</span>
      </button>
      <dialog
        ref={dialog}
        className="projection"
        aria-label="投影字幕"
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
          <div className={`projection-controls ${visible ? '' : 'hidden-controls'}`}>
            <div className="projection-layouts" role="group" aria-label="字幕版型">
              {(
                [
                  ['stack', '上下字幕'],
                  ['columns', '左右對照'],
                  ['face', '面對面翻轉'],
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
                onClick={() => setSize((n) => Math.max(24, n - 4))}
                aria-label="縮小字體"
              >
                A−
              </button>
              <span className="projection-size-readout">{size}px</span>
              <button
                type="button"
                onClick={() => setSize((n) => Math.min(120, n + 4))}
                aria-label="放大字體"
              >
                A＋
              </button>
            </div>
            <button type="button" onClick={() => void fullscreen()}>
              {isFullscreen ? '離開全螢幕' : '全螢幕'}
            </button>
            <button
              type="button"
              className="projection-exit"
              onClick={() => void closeDialogAnimated(dialog.current)}
            >
              <IconX size={15} />
              <span>退出</span>
            </button>
            <span className="projection-shortcuts">F 全螢幕 · + / - 字級 · Esc 退出</span>
            {fullscreenError && (
              <span className="projection-alert" role="status">
                {fullscreenError}
              </span>
            )}
          </div>
          <div
            ref={textArea}
            tabIndex={-1}
            className={`projection-text ${layout}`}
            style={{ fontSize: `${size}px` }}
            onPointerDown={wake}
          >
            {layout === 'stack' && contextText && (
              <div className="projection-context">{contextText}</div>
            )}
            <div className={`projection-original ${interim ? 'is-interim' : ''}`}>
              {interim && <span className="projection-pill">辨識中</span>}
              <span>{activeOriginal}</span>
            </div>
            {layout === 'face' && <div className="projection-divider" aria-hidden="true" />}
            <div className={`projection-translation ${interim ? 'is-stale' : ''}`}>
              {interim && latest?.translation && (
                <span className="projection-pill muted">上一句譯文</span>
              )}
              <span>{activeTranslation}</span>
            </div>
          </div>
        </div>
      </dialog>
    </>
  );
}
