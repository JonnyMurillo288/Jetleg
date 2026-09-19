import { useState } from 'react';
import { startCheckout, restorePurchase } from '../payments/entitlement';
import { PRODUCTS, type Product } from '../payments/products';

/**
 * Shown in place of RoundGate when the device has no valid entitlement.
 * There's no modal/overlay convention elsewhere in this app — this matches
 * RoundGate's own full-panel shape rather than inventing dialog CSS.
 */
export function PaywallModal(props: { onRestored: () => void }) {
  const [busy, setBusy] = useState<Product | 'restore' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRestore, setShowRestore] = useState(false);
  const [email, setEmail] = useState('');
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);

  const buy = async (product: Product) => {
    setBusy(product);
    setError(null);
    const res = await startCheckout(product);
    // On success the page navigates away to Stripe; only a failure reaches here.
    if (res.error) {
      setError(res.error);
      setBusy(null);
    }
  };

  const restore = async () => {
    if (!email.trim()) return;
    setBusy('restore');
    setRestoreMsg(null);
    const res = await restorePurchase(email.trim());
    setBusy(null);
    if (res.error) setRestoreMsg(res.error);
    else if (res.restored) {
      setRestoreMsg('Restored — you can start a round now.');
      props.onRestored();
    } else {
      setRestoreMsg('No usable purchase found for that email.');
    }
  };

  return (
    <div className="pad">
      <h2>Unlock JetLeg SF</h2>
      <p className="muted">
        Each device needs its own pass. The clock starts the moment you play, not
        when you buy — so it's fine to buy ahead of game day.
      </p>

      <button className="primary big" disabled={busy !== null} onClick={() => buy('single_game')}>
        {busy === 'single_game' ? 'Redirecting…' : `${PRODUCTS.single_game.label} — ${PRODUCTS.single_game.price}`}
      </button>
      <button className="primary big" disabled={busy !== null} onClick={() => buy('week_pass')}>
        {busy === 'week_pass' ? 'Redirecting…' : `${PRODUCTS.week_pass.label} — ${PRODUCTS.week_pass.price}`}
      </button>

      {error && <p className="small" style={{ color: 'var(--no)' }}>{error}</p>}

      <h3>Already paid on another device?</h3>
      {!showRestore ? (
        <button className="link" onClick={() => setShowRestore(true)}>Restore a purchase</button>
      ) : (
        <div className="row">
          <input
            type="email"
            placeholder="Email used at checkout"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button disabled={busy !== null} onClick={restore}>
            {busy === 'restore' ? 'Checking…' : 'Restore'}
          </button>
        </div>
      )}
      {restoreMsg && <p className="small muted">{restoreMsg}</p>}
    </div>
  );
}
