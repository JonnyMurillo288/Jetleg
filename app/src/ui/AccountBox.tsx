import { useState } from 'react';
import { requestCode, setDisplayName, signOut, verifyCode, type Account, type CodeKind } from '../community/account';

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
            <p className="small">{needsName ? 'Choose the name your maps and comments appear under.' : 'Change your display name.'}</p>
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
          <p className="small">We sent a six-digit code to {sent.email}.</p>
          <div className="row">
            <input type="text" className="code grow" inputMode="numeric" autoComplete="one-time-code" value={code} maxLength={6} placeholder="Code" onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            <button className="primary" disabled={busy || code.length < 6} onClick={() => run(() => verifyCode(sent.email, code, sent.kind))}>
              {busy ? 'Checking…' : 'Sign in'}
            </button>
            <button className="link" onClick={() => { setSent(null); setCode(''); setError(null); }}>Use another email</button>
          </div>
        </>
      )}
      <p className="muted small">No password. Browsing and playing maps never needs this.</p>
      {error && <p className="warntext">{error}</p>}
    </div>
  );
}
