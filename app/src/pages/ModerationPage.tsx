import { useCallback, useEffect, useState } from 'react';
import { moderate, moderationQueue, type QueueItem } from '../community/api';
import { useAccount } from '../community/account';
import { mapHref } from '../route';
import { AccountBox } from '../ui/AccountBox';
import { Page } from './Page';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');

/**
 * Moderators' queue (0016): every map or comment with an open report, and
 * everything hidden, newest report first. The server decides who may read
 * it; to anyone else the page says so and shows nothing.
 */
export function ModerationPage() {
  const account = useAccount();
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const who = account.state === 'signedIn' ? account.userId : account.state;
  const load = useCallback(async () => {
    const res = await moderationQueue();
    if (res.ok) { setItems(res.value); setError(null); } else { setItems(null); setError(res.error); }
  }, []);
  useEffect(() => { if (account.state === 'signedIn') load(); }, [who, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (q: QueueItem, hide: boolean) => {
    const key = `${q.mapId}/${q.commentId ?? ''}`;
    setBusy(key);
    const res = await moderate(q.mapId, hide, q.commentId ?? undefined);
    setBusy(null);
    if (!res.ok) setError(res.error);
    await load();
  };

  return (
    <Page title="Moderation">
      {account.state !== 'signedIn' ? (
        <AccountBox account={account} reason="Moderators sign in to see reports." />
      ) : error ? (
        <p className="warntext">{error}</p>
      ) : !items ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted">Nothing reported and nothing hidden.</p>
      ) : (
        <>
          <p className="muted small">
            Open reports and everything hidden, newest report first. Restoring or keeping something hidden closes its
            reports. Three reports from different players hide a thing until someone here looks.
          </p>
          <ul className="list modqueue">
            {items.map((q) => {
              const key = `${q.mapId}/${q.commentId ?? ''}`;
              return (
                <li key={key}>
                  <div className="grow">
                    <div>
                      <b>{q.commentId ? `Comment by ${q.authorName}` : `Map: ${q.mapName}`}</b>
                      {q.hiddenAt && <span className="tag warn">hidden</span>}
                    </div>
                    <div className="muted small">
                      {q.commentId ? <>on <a href={mapHref(q.mapId)}>{q.mapName}</a></> : <>by {q.authorName} · <a href={mapHref(q.mapId)}>open</a></>}
                      {q.lastReportedAt && <> · last reported {when(q.lastReportedAt)}</>}
                    </div>
                    {q.body && <p className="small">“{q.body.slice(0, 400)}{q.body.length > 400 ? '…' : ''}”</p>}
                    {q.openReports > 0 ? (
                      <ul className="small reasons">
                        {q.reasons.map((r, i) => <li key={i}>{r}</li>)}
                      </ul>
                    ) : (
                      <p className="muted small">{q.hiddenReason ?? 'Hidden.'} No open reports.</p>
                    )}
                  </div>
                  <div className="row">
                    {q.hiddenAt ? (
                      <>
                        <button disabled={busy === key} onClick={() => act(q, false)}>Restore</button>
                        {q.openReports > 0 && <button className="danger" disabled={busy === key} onClick={() => act(q, true)}>Keep hidden</button>}
                      </>
                    ) : (
                      <>
                        <button className="danger" disabled={busy === key} onClick={() => act(q, true)}>Hide</button>
                        <button disabled={busy === key} onClick={() => act(q, false)}>Dismiss reports</button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Page>
  );
}
