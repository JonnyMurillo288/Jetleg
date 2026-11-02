import { useEffect, useMemo, useRef, useState } from 'react';
import { loadGameData, type GameData } from '../data/load';
import { enterBoard } from '../engine/reset';
import { readStrictness, type Strictness } from '../engine/candidates';
import { requestPersistence, useGame, type Round } from '../store/game';
import { loadActiveMap, sameBoard, stampOf, type ActiveMap } from '../community/active';
import { applyMap } from '../community/board';
import { supabase } from '../sync/client';
import { gameFileText, readGameFile, roundFileName, saveTextFile, type GameFile } from '../stats/gamefile';
import { RoundWrapped } from '../ui/RoundWrapped';
import { formatSpan } from '../ui/time';
import { Page } from './Page';
import { restoreChats, withChats } from '../chat/local';

type Opened = { name: string; text: string; file: GameFile };
type Source = 'device' | 'file';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const newestFirst = (rounds: Round[]) => rounds.slice().sort((a, b) => b.startedAt - a.startedAt);

/**
 * Game stats: every round on this device, and any game file, looked back on
 * question by question.
 *
 * Everything on this page is worked out here, in the browser, from the
 * rounds themselves. Opening a file reads it — it is not uploaded, and it is
 * not added to this device's rounds unless the player asks for that.
 */
export function StatsPage() {
  const rounds = useGame((s) => s.rounds);
  const settings = useGame((s) => s.settings);
  const updateSettings = useGame((s) => s.updateSettings);
  const importJSON = useGame((s) => s.importJSON);
  const exportJSON = useGame((s) => s.exportJSON);
  const setRoundHiderStation = useGame((s) => s.setRoundHiderStation);

  const [base, setBase] = useState<GameData | null>(null);
  const [active, setActive] = useState<ActiveMap | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  const [open, setOpen] = useState<{ source: Source; id: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([loadGameData(), loadActiveMap().catch(() => null)])
      .then(([loaded, stored]) => { setBase(loaded); setActive(stored); })
      .catch((e) => setLoadError(String(e)));
    requestPersistence();
  }, []);

  const openFile = async (f: File) => {
    const text = await f.text();
    const read = readGameFile(text);
    setKept(null);
    if (!read.ok) { setFileError(`${f.name}: ${read.error}`); setOpened(null); return; }
    setFileError(null);
    setOpened({ name: f.name, text, file: read.file });
  };

  const onDevice = useMemo(() => new Set(rounds.map((r) => r.id)), [rounds]);
  const round = open
    ? (open.source === 'device' ? rounds : opened?.file.rounds ?? []).find((r) => r.id === open.id) ?? null
    : null;

  /**
   * The board the open round was played on, if this device has it: the
   * shipped board for a round with no stamp, the map in play if it is the
   * same one. Entered here, so the stats below are evaluated on it.
   */
  const board = useMemo(() => {
    if (!base || !round) return null;
    const found = !round.board
      ? base
      : active && sameBoard(round.board, stampOf(active)) ? applyMap(base, active.map) : null;
    if (found) enterBoard(found.bbox, found.zoneRadiusM);
    return found;
    // The round's board, not the round: logging nothing new must not rebuild every zone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, active, round?.id, round?.board?.versionId, round?.board?.name]);

  if (round && open) {
    const fromFile = open.source === 'file';
    // A file scores its rounds the way they were scored when it was written.
    const fileStrictness = opened?.file.settings.strictness;
    const strictness: Strictness | undefined = fromFile ? readStrictness(fileStrictness) : undefined;
    return (
      <Page title="Game stats">
        <button className="link" onClick={() => setOpen(null)}>← All rounds</button>
        <h2>{round.label}</h2>
        <p className="muted">
          {round.role === 'seeker' ? 'Seeking' : 'Hiding'}
          {' · '}{new Date(round.startedAt).toLocaleString()}
          {round.board ? ` · on “${round.board.name}”` : ' · built-in board'}
          {!round.endedAt && ' · still in progress'}
          {fromFile && ` · from ${opened!.name}`}
        </p>

        {!base && !loadError && <p className="muted small">Loading the board…</p>}
        {loadError && <p className="warntext">{loadError}</p>}
        {(base || loadError) && (
          <RoundWrapped
            round={round}
            board={board}
            strictness={strictness}
            boardNote={
              round.board
                ? <>This round was played on the map “{round.board.name}”, which is not the board loaded on this device, so its zone counts cannot be worked out here. Choose that map from <a href="#/start">Start a game</a> and come back to see them.</>
                : 'The board could not be loaded, so zone counts are left out.'
            }
            onHiderStation={
              fromFile
                // A file is not written back to: the answer is kept for this visit only.
                ? (id) => setOpened((o) => o && {
                    ...o,
                    file: { ...o.file, rounds: o.file.rounds.map((r) => (r.id === round.id ? { ...r, hiderStationId: id } : r)) },
                  })
                : (id) => setRoundHiderStation(round.id, id)
            }
          />
        )}

        <div className="row pagebuttons">
          <button onClick={async () => saveTextFile(roundFileName(round), await withChats(gameFileText([round], fromFile ? opened!.file.settings : settings, round.role), fromFile ? opened!.text : undefined))}>
            Save this round as a file
          </button>
        </div>
      </Page>
    );
  }

  const list = (items: Round[], source: Source) => (
    <ul className="list results">
      {newestFirst(items).map((r) => (
        <li key={r.id}>
          <button className="link grow" onClick={() => setOpen({ source, id: r.id })}>
            {r.label}
            {!r.endedAt && <span className="tag">in progress</span>}
            {source === 'file' && onDevice.has(r.id) && <span className="tag">also on this device</span>}
            <span className="muted maprow small">
              {r.role === 'seeker' ? 'Seeking' : 'Hiding'}
              {' · '}{new Date(r.startedAt).toLocaleDateString()}
              {r.endedAt && ` · ${formatSpan(r.endedAt - r.startedAt)}`}
              {' · '}{plural(r.asks.length, 'question')}
              {r.board && ` · ${r.board.name}`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <Page title="Game stats">
      <h2>Your rounds, question by question</h2>
      <p className="muted">
        Which question did the most, which did nothing, how long you waited between them and how close
        you were each time. Worked out on this device from the round itself — nothing here is sent anywhere.
      </p>

      <h3>On this device</h3>
      {rounds.length === 0 ? (
        <p className="muted">No rounds yet. <a href="#/start">Start a game</a>, or open a game file below.</p>
      ) : (
        <>
          {list(rounds, 'device')}
          <div className="row pagebuttons">
            <button onClick={async () => saveTextFile(`jetleg-sf-${new Date().toISOString().slice(0, 10)}.json`, await withChats(exportJSON()))}>
              Save all {plural(rounds.length, 'round')} to a file
            </button>
          </div>
        </>
      )}
      <p className="muted small">
        Rounds live in this browser's storage, which a phone can clear after a few weeks unused. A file is yours to keep.
      </p>

      <h3>From a game file</h3>
      <div className="row">
        <button onClick={() => fileRef.current?.click()}>Open a game file</button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) openFile(f); }}
        />
      </div>
      {fileError && <p className="warntext">{fileError}</p>}
      {opened && (
        <div className="openedfile">
          <p>
            <b>{opened.name}</b>
            <span className="muted small">
              {' · '}{plural(opened.file.rounds.length, 'round')}
              {opened.file.exportedAt && ` · saved ${new Date(opened.file.exportedAt).toLocaleDateString()}`}
            </span>
          </p>
          {opened.file.skipped > 0 && (
            <p className="warntext">
              {plural(opened.file.skipped, 'entry', 'entries')} in the file could not be read and {opened.file.skipped === 1 ? 'was' : 'were'} left out.
            </p>
          )}
          {opened.file.rounds.length === 0 ? <p className="muted">There are no rounds in this file.</p> : list(opened.file.rounds, 'file')}
          <div className="row pagebuttons">
            {opened.file.rounds.some((r) => !onDevice.has(r.id)) && (
              <button
                onClick={async () => {
                  const res = importJSON(opened.text);
                  if (res.ok) await restoreChats(opened.text);
                  setKept(res.ok ? 'Added to this device.' : res.error);
                }}
              >
                Keep these rounds on this device
              </button>
            )}
            <button className="link" onClick={() => { setOpened(null); setKept(null); }}>Close the file</button>
          </div>
          {kept && <p className="small notice">{kept}</p>}
        </div>
      )}
      <p className="muted small">
        A game file is what “Save … to a file” here and “Export to file” in the game write. It is read in this
        browser only.
      </p>

      {supabase && (
        <>
          <h3>Sharing</h3>
          <label className="check sharecheck">
            <input
              type="checkbox"
              checked={!!settings.shareHistory}
              onChange={(e) => updateSettings({ shareHistory: e.target.checked })}
            />
            <span>
              Also save my finished rounds to my team's history
              <span className="muted small">
                Off unless you turn it on. When on, and once this device has joined a game, each round that ends
                is also stored on the server, where the members of that team can read it: its name, the questions,
                answers and any notes, the hider's station, and the date. Never your exact positions — radar and
                thermometer points are blurred by up to 1 km, and no others are sent.
              </span>
            </span>
          </label>
        </>
      )}
    </Page>
  );
}
