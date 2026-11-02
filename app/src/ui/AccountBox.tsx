import { useEffect, useState } from 'react';
import {
  googleEnabled, requestCode, setDisplayName, signInWithGoogle, signOut, takeGoogleError, verifyCode,
  type Account, type CodeKind,
} from '../community/account';

/**
 * Sign in with an emailed code, then pick the name to publish under.
 * `reason` says why this particular action wants it — nothing else in the
 * app asks for a login, so it should never appear unexplained.
 */
export function AccountBox(props: { account: Account; reason?: string }) {
  const { account } = props;
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<{ email: string; kind: CodeKind } | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [google, setGoogle] = useState(false);

  useEffect(() => {
    let cancelled = false;
    googleEnabled().then((on) => { if (!cancelled) setGoogle(on); });
    const failed = takeGoogleError();
    if (failed) setError(failed);
    return () => { cancelled = true; };
  }, []);

  // Offer the name the account came with, but only as a suggestion: a display
  // name is public, and a full name is not something to publish unasked.
  const suggested = account.state === 'signedIn' && !account.displayName ? account.suggestedName : null;
  useEffect(() => { if (suggested) setName((n) => n || suggested); }, [suggested]);

  const run = async (work: () => Promise<{ ok: true } | { ok: false; error: string }>, then?: () => void) => {
    setBusy(true);
    setError(null);
    const res = await work();
    setBusy(false);
    if (res.ok) then?.();
    else setError(res.error);
  };

  if (account.state === 'unavailable' || account.state === 'loading') return null;

  if (account.state === 'signedIn') {
    const needsName = !account.displayName;
    return (
      <div className="accountbox">
        {needsName || editingName ? (
          <>
            <p className="small">
              {needsName ? 'Choose the name your maps and comments appear under. Everyone can see it.' : 'Change your display name.'}
            </p>
            <div className="row">
              <input type="text" className="grow" value={name} maxLength={40} placeholder="Display name" onChange={(e) => setName(e.target.value)} />
              <button className="primary" disabled={busy || !name.trim()} onClick={() => run(() => setDisplayName(name), () => setEditingName(false))}>Save</button>
            </div>
          </>
        ) : (
          <p className="small muted">
            Signed in as <b>{account.displayName}</b> · {account.email}{' '}
            <button className="link" onClick={() => { setName(account.displayName ?? ''); setEditingName(true); }}>Rename</button>
            <button className="link" onClick={() => confirm('Sign out on this device? Any pass or developer access stays with the account — sign back in to use it.') && signOut()}>Sign out</button>
          </p>
        )}
        {error && <p className="warntext">{error}</p>}
      </div>
    );
  }

  return (
    <div className="accountbox">
      {props.reason && <p className="small">{props.reason}</p>}
      {google && !sent && (
        <>
          <button className="google big" disabled={busy} onClick={() => run(signInWithGoogle)}>
            <GoogleMark /> Continue with Google
          </button>
          <p className="muted small">Google tells JetLeg your email and your name, and nothing else is kept.</p>
          <p className="orline small muted"><span>or with a code by email</span></p>
        </>
      )}
      {!sent ? (
        <div className="row">
          <input type="email" value={email} placeholder="Your email" autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
          <button
            className="primary"
            disabled={busy || !email.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              const res = await requestCode(email);
              setBusy(false);
              if (res.ok) setSent({ email, kind: res.kind });
              else setError(res.error);
            }}
          >
            {busy ? 'Sending…' : 'Email me a code'}
          </button>
        </div>
      ) : (
        <>
          <p className="small">Enter the six-digit code for {sent.email}.</p>
          <div className="row">
            <input type="text" className="code grow" inputMode="numeric" autoComplete="one-time-code" value={code} maxLength={6} placeholder="Code" onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            <button className="primary" disabled={busy || code.length < 6} onClick={() => run(() => verifyCode(sent.email, code, sent.kind))}>
              {busy ? 'Checking…' : 'Sign in'}
            </button>
            <button className="link" onClick={() => { setSent(null); setCode(''); setError(null); }}>Use another email</button>
          </div>
        </>
      )}
      <p className="muted small">
        No password. Browsing and playing maps never needs this.
        {!sent && (
          // Skips the email: where no mail can be sent yet, the testing code
          // is the only code there is.
          <> <button className="link" disabled={!email.trim()} onClick={() => { setError(null); setSent({ email, kind: 'email' }); }}>I have a testing code</button></>
        )}
      </p>
      {error && <p className="warntext">{error}</p>}
    </div>
  );
}

/** Google's "G", in its own colours, as its sign-in guidelines ask. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.7 17.8 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17z" />
      <path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.2-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
    </svg>
  );
}
