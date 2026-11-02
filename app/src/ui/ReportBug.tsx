import { useState } from 'react';
import { useActiveRound, useGame } from '../store/game';

/** Where reports go. Set in .env.local; with none, the form can still copy a report. */
const REPORT_TO = import.meta.env.VITE_REPORT_EMAIL ?? '';

/** Mail apps cut off long mailto links; past this the report says to paste the rest. */
const MAILTO_BODY_MAX = 1800;

/**
 * "Report a bug": opens the player's own mail app with a report already
 * written, addressed to the developer. No server sends it — the app has no
 * mail service, and a report the player can read before it goes is one they
 * can trust.
 *
 * What it says about the device is what helps reproduce a bug: the build,
 * the browser, the settings, the board, the shape of the round. Never a
 * position — not the GPS fix, not a pin, not an answer's origin. A hider's
 * report must not be a map to the hider.
 */
export function ReportBug(props: { checks: { label: string; state: string }[]; boardName: string | null }) {
  const [kind, setKind] = useState<'Bug' | 'Feedback'>('Bug');
  const [text, setText] = useState('');
  const [withDevice, setWithDevice] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const settings = useGame((s) => s.settings);
  const role = useGame((s) => s.role);
  const round = useActiveRound();

  const device = () => {
    const bundle = document.querySelector<HTMLScriptElement>('script[src*="/assets/index-"]')?.src.split('/').pop() ?? 'unknown';
    const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
    return [
      `Build: ${bundle}`,
      `Site: ${location.origin}`,
      `Browser: ${navigator.userAgent}`,
      `Screen: ${screen.width}×${screen.height} @${devicePixelRatio}x${standalone ? ', installed' : ''}`,
      `Board: ${props.boardName ?? 'built-in San Francisco'}`,
      `Role: ${role} · rules: ${settings.strictness}, ${settings.gameSize}, ${settings.units}`,
      round ? `Round: ${round.asks.length} answers logged${round.endedAt ? ', ended' : ''}` : 'Round: none open',
      `Checks: ${props.checks.map((c) => `${c.label} ${c.state}`).join('; ') || 'not run'}`,
    ].join('\n');
  };

  const report = () => `${text.trim()}\n${withDevice ? `\n— This device —\n${device()}\n` : ''}`;
  const subject = () => `JetLeg ${kind.toLowerCase()}: ${text.trim().split('\n')[0].slice(0, 60)}`;

  const send = () => {
    let body = report();
    if (body.length > MAILTO_BODY_MAX) body = `${body.slice(0, MAILTO_BODY_MAX)}\n…(cut short — tap "Copy report" in the app and paste the rest)`;
    location.href = `mailto:${REPORT_TO}?subject=${encodeURIComponent(subject())}&body=${encodeURIComponent(body)}`;
    setNote('Your mail app should open with the report filled in — check it and press send. If nothing opened, use “Copy report” and email it instead.');
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${subject()}\n\n${report()}`);
      setNote(REPORT_TO ? `Copied. Paste it into an email to ${REPORT_TO}.` : 'Copied.');
    } catch {
      setNote('This browser would not copy. Select the text above and copy it by hand.');
    }
  };

  return (
    <div className="report">
      <h3>Report a bug or send feedback</h3>
      <div className="seg">
        {(['Bug', 'Feedback'] as const).map((k) => (
          <button key={k} className={kind === k ? 'on' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>{k}</button>
        ))}
      </div>
      <textarea rows={4} maxLength={1500} value={text} onChange={(e) => setText(e.target.value)}
        placeholder={kind === 'Bug' ? 'What happened, and what did you expect? What were you doing just before?' : 'What would make the game better?'} />
      <label className="check small">
        <input type="checkbox" checked={withDevice} onChange={(e) => setWithDevice(e.target.checked)} />
        <span>Include this device’s details (build, browser, settings — never your location)</span>
      </label>
      {withDevice && <pre className="muted small mono reportdevice">{device()}</pre>}
      <div className="row">
        {REPORT_TO && <button className="primary" disabled={!text.trim()} onClick={send}>Send by email</button>}
        <button disabled={!text.trim()} onClick={copy}>Copy report</button>
      </div>
      {note && <p className="small notice">{note}</p>}
    </div>
  );
}
