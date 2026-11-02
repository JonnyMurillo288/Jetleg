import { useEffect, useId, useMemo, useState } from 'react';
import { loadGameData } from '../data/load';
import { supabase } from '../sync/client';
import { useActiveRound } from '../store/game';
import { loadActiveMap, type ActiveMap } from '../community/active';
import { getVersionContent, listCities, listMaps, type CityRow, type MapSummary } from '../community/api';
import { playOn } from '../community/choose';
import { cityDirectory, countLabel, countryName, flagOf, matchCities, type CityEntry } from '../community/cities';
import { mapHref } from '../route';
import { Page } from './Page';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Start a game: say which city, pick one of its maps, play.
 *
 * The city box is a search over the cities that have maps — the shipped
 * board's city always among them — and each suggestion says which country it
 * is and how many maps it has. Choosing a map does what "Play on this map"
 * does in the studio, and lands in the game.
 */
export function StartGame() {
  const round = useActiveRound();
  const inProgress = !!round && !round.endedAt;

  const [rows, setRows] = useState<CityRow[]>([]);
  const [directoryNote, setDirectoryNote] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [city, setCity] = useState<CityEntry | null>(null);
  const [active, setActive] = useState<ActiveMap | null>(null);
  const listId = useId();

  useEffect(() => {
    let cancelled = false;
    loadActiveMap().then((a) => { if (!cancelled) setActive(a); }).catch(() => {});
    if (!supabase) return;
    listCities().then((res) => {
      if (cancelled) return;
      if (res.ok) setRows(res.value);
      else setDirectoryNote(`${res.error} Showing the built-in board only.`);
    });
    return () => { cancelled = true; };
  }, []);

  const directory = useMemo(() => cityDirectory(rows), [rows]);
  const matches = useMemo(() => matchCities(directory, query), [directory, query]);

  const choose = (entry: CityEntry) => {
    setCity(entry);
    setQuery(entry.name);
    setListOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setListOpen(true);
      if (matches.length) setCursor((c) => (c + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
    } else if (e.key === 'Enter' && listOpen && matches[cursor]) {
      e.preventDefault();
      choose(matches[cursor]);
    } else if (e.key === 'Escape') {
      setListOpen(false);
    }
  };

  return (
    <Page title="Start a game">
      <h2>Where are you playing?</h2>
      <p className="muted">Type a city. Each one shows how many maps it has to choose from.</p>

      {inProgress && (
        <p className="hint warn">
          You have a round in progress, and a round keeps the board it started on.{' '}
          <a href="#/play">Continue it</a>, or end it there before starting on another map.
        </p>
      )}

      <div className="citypicker">
        <input
          type="text"
          role="combobox"
          aria-label="City"
          aria-expanded={listOpen}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={listOpen && matches[cursor] ? `${listId}-${cursor}` : undefined}
          autoComplete="off"
          placeholder="City"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setCity(null); setCursor(0); setListOpen(true); }}
          onFocus={() => setListOpen(true)}
          // Late enough for a tap on a suggestion to land first.
          onBlur={() => window.setTimeout(() => setListOpen(false), 150)}
          onKeyDown={onKey}
        />
        {listOpen && (
          <ul className="citylist" id={listId} role="listbox" aria-label="Cities with maps">
            {matches.map((c, i) => (
              <li
                key={c.city}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === cursor}
                className={i === cursor ? 'on' : ''}
                onMouseEnter={() => setCursor(i)}
                // mousedown, so the input keeps focus and its blur does not close the list first.
                onMouseDown={(e) => { e.preventDefault(); choose(c); }}
              >
                <span className="flag" title={countryName(c.country) ?? 'Country not given'} aria-hidden="true">{flagOf(c.country)}</span>
                <span className="grow">
                  {c.name}
                  {countryName(c.country) && <span className="muted small"> · {countryName(c.country)}</span>}
                </span>
                <span className="mapcount" title="Maps for this city, not counting branches">
                  <b>{countLabel(c.mapCount)}</b> {c.mapCount === 1 ? 'map' : 'maps'}
                </span>
              </li>
            ))}
            {matches.length === 0 && (
              <li className="empty" role="option" aria-selected={false} aria-disabled="true">
                <span className="grow">No maps for “{query.trim()}” yet.</span>
                <a href="#/maps/new" onMouseDown={(e) => e.preventDefault()}>Create one →</a>
              </li>
            )}
          </ul>
        )}
      </div>
      {directoryNote && <p className="muted small">{directoryNote}</p>}

      {city && <CityMaps key={city.city} city={city} active={active} disabled={inProgress} />}
    </Page>
  );
}

/** One city's maps, each a tap away from being played on. */
function CityMaps(props: { city: CityEntry; active: ActiveMap | null; disabled: boolean }) {
  const { city, active, disabled } = props;
  const [maps, setMaps] = useState<MapSummary[] | null>(supabase ? null : []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    listMaps('top', city.city).then((res) => {
      if (cancelled) return;
      if (res.ok) setMaps(res.value);
      else { setMaps([]); setError(res.error); }
    });
    return () => { cancelled = true; };
  }, [city.city]);

  /** `null` is the board the app ships. */
  const play = async (map: MapSummary | null) => {
    setBusy(map?.id ?? 'built-in');
    setNote(null);
    try {
      let next: ActiveMap | null = null;
      if (map) {
        if (!map.headVersionId) { setNote('This map has no version to load.'); return; }
        const content = await getVersionContent(map.headVersionId);
        if (!content.ok) { setNote(content.error); return; }
        next = { mapId: map.id, versionId: map.headVersionId, map: content.value };
      }
      const stopped = await playOn(next, (await loadGameData()).boundary);
      if (stopped) setNote(stopped);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="citymaps">
      <h3>
        <span aria-hidden="true">{flagOf(city.country)}</span> Maps for {city.name}
      </h3>
      {error && <p className="warntext">{error}</p>}
      {note && <p className="small notice">{note}</p>}
      <ul className="list maps">
        {city.builtIn && (
          <li>
            <div className="grow">
              <b>{city.name}</b>
              <span className="tag">built in</span>
              {!active && <span className="tag good">current board</span>}
              <span className="muted small maprow">The board this app ships with. Works with no connection.</span>
            </div>
            <button className="primary" disabled={disabled || !!busy} onClick={() => play(null)}>
              {busy === 'built-in' ? 'Loading…' : 'Play'}
            </button>
          </li>
        )}
        {maps?.map((m) => (
          <li key={m.id}>
            <div className="grow">
              <b>{m.name}</b>
              {m.parentMapName && <span className="tag">a branch</span>}
              {active?.mapId === m.id && <span className="tag good">current board</span>}
              <span className="muted small maprow">
                by {m.authorName} · {m.kind === 'pack' ? 'full city' : 'stations'} · {plural(m.stationCount, 'station')} · ▲ {m.likeCount}
              </span>
              <a className="small" href={mapHref(m.id)}>Look at it first</a>
            </div>
            <button className="primary" disabled={disabled || !!busy} onClick={() => play(m)}>
              {busy === m.id ? 'Loading…' : 'Play'}
            </button>
          </li>
        ))}
      </ul>
      {!maps && <p className="muted small">Loading maps…</p>}
      {maps && maps.length === 0 && !city.builtIn && <p className="muted">Nothing here any more.</p>}
      <p className="muted small">
        Playing takes you to the game with this board loaded. Want something different?{' '}
        <a href="#/maps/new">Create a map</a>.
      </p>
    </section>
  );
}
