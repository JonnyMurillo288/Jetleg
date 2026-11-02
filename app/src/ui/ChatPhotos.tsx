import { useEffect, useState } from 'react';
import { formatClock } from '../chat/chat';

/**
 * A photo answer, pinned to its question. Tap to open it full size. `url`
 * is an object URL for the copy kept on this phone (chat/local.ts); none yet
 * means its pieces are still arriving from another phone.
 */
export function PhotoThumb(props: { url: string | undefined; label: string; onOpen: () => void }) {
  return (
    <button className="photothumb" onClick={props.onOpen} disabled={!props.url} aria-label={`Open the photo: ${props.label}`}>
      {props.url
        ? <img src={props.url} alt={props.label} loading="lazy" />
        : <span className="muted small">Photo on its way…</span>}
    </button>
  );
}

export function Lightbox(props: { url: string; caption: string; onClose: () => void }) {
  const { onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-label={props.caption} onClick={onClose}>
      <img src={props.url} alt={props.caption} />
      <div className="lightbox-bar">
        <span>{props.caption}</span>
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

/**
 * Counts down to a question's deadline. Its own one-second timer, so only
 * this span re-renders: a clock in shared state once re-rendered the whole
 * app, map redraw included, every second.
 */
export function Countdown(props: { deadline: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const left = props.deadline - now;
  return (
    <span className={`clock ${left < 0 ? 'late' : left < 60_000 ? 'soon' : ''}`} role="timer">
      {left < 0 ? `late ${formatClock(-left)}` : formatClock(left)}
    </span>
  );
}
