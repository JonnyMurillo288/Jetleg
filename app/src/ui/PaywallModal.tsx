import { useState } from 'react';
import { startCheckout } from '../payments/entitlement';
import { PRODUCTS, ROOM_SEATS, type Product } from '../payments/products';
import { useAccount } from '../community/account';
import { AccountBox } from './AccountBox';

/**
 * Shown in place of RoundGate's Start button when the device has no pass.
 * What is sold is a game room (0015_room_passes.sql): one person buys it,
 * everyone else joins with its code on the Game tab.
 * There's no modal/overlay convention elsewhere in this app — this matches
 * RoundGate's own full-panel shape rather than inventing dialog CSS.
 */
export function PaywallModal(props: { onOpenGame: () => void }) {
  const account = useAccount();

  return (
    <div className="pad">
      <h2>Play in a game room</h2>
      <p className="muted">
        One person buys a room and sends its code. Up to {ROOM_SEATS} players join with it and play
        as many rounds as they like until the room's time is up. The clock starts at the room's first
        round, so it's fine to buy ahead of game day.
      </p>

      <h3>Have a room code?</h3>
      <button className="primary big" onClick={props.onOpenGame}>Join a room on the Game tab</button>

      <h3>Buy a room</h3>
      <BuyRoom />

      <h3>Developer or tester?</h3>
      <AccountBox account={account} reason="Sign in with the email you were given access on. Nothing to pay." />
      {account.state === 'signedIn' && (
        <p className="small muted">This account has no developer access, so it still needs a place in a room.</p>
      )}
    </div>
  );
}

/** The two rooms for sale. Also on the Game tab, where a room would otherwise be created. */
export function BuyRoom() {
  const [busy, setBusy] = useState<Product | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <>
      {(Object.keys(PRODUCTS) as Product[]).map((p) => (
        <button key={p} className="primary big" disabled={busy !== null} onClick={() => buy(p)}>
          {busy === p ? 'Redirecting…' : `${PRODUCTS[p].label} — ${PRODUCTS[p].price}`}
        </button>
      ))}
      {error && <p className="small" style={{ color: 'var(--no)' }}>{error}</p>}
      <p className="small muted">
        Up to {ROOM_SEATS} players, you included. Each phone that joins takes one of the places and keeps
        it, even after leaving — a place can't be handed on to another phone. No sign-in needed. You get
        the code at checkout.
      </p>
    </>
  );
}
