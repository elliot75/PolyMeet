import { useEffect, useRef, useState } from 'react';
import type { TranscriptSegment } from '../../shared/types';
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
  const latest = segments.at(-1);
  useEffect(() => {
    if (opened && textArea.current)
      textArea.current.scrollTo({
        top: textArea.current.scrollHeight,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
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
    wake();
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches('input, textarea')) return;
      if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        void fullscreen();
      }
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        setSize((n) => Math.min(n + 4, 120));
      }
      if (e.key === '-') {
        e.preventDefault();
        setSize((n) => Math.max(n - 4, 24));
      }
      if (e.key === 'Escape' && !document.fullscreenElement) dialog.current?.close();
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
        className="secondary"
        onClick={() => {
          dialog.current?.showModal();
          setOpened(true);
        }}
      >
        投影字幕
      </button>
      <dialog
        ref={dialog}
        className="projection"
        aria-label="投影字幕"
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
            <label>
              字幕布局
              <select value={layout} onChange={(e) => setLayout(e.target.value as Layout)}>
                <option value="stack">上下字幕</option>
                <option value="columns">左右對照</option>
                <option value="face">面對面翻轉</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => setSize((n) => Math.max(24, n - 4))}
              aria-label="縮小字體"
            >
              A−
            </button>
            <button
              type="button"
              onClick={() => setSize((n) => Math.min(120, n + 4))}
              aria-label="放大字體"
            >
              A＋
            </button>
            <button type="button" onClick={() => void fullscreen()}>
              {isFullscreen ? '離開全螢幕' : '全螢幕'}
            </button>
            <button type="button" onClick={() => dialog.current?.close()}>
              退出
            </button>
            {fullscreenError && <span role="status">{fullscreenError}</span>}
          </div>
          <div
            ref={textArea}
            tabIndex={-1}
            autoFocus
            className={`projection-text ${layout}`}
            style={{ fontSize: `${size}px` }}
          >
            <div className="projection-original">{interim || latest?.text || '等待語音…'}</div>
            <div className="projection-translation">
              {interim ? '正在辨識…' : latest?.translation || '翻譯將顯示在這裡'}
            </div>
          </div>
        </div>
      </dialog>
    </>
  );
}
