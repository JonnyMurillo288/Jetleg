import type { GameData } from '../data/load';
import { LAYER_DEFS } from '../data/load';
import { useGame } from '../store/game';
import { UNIT_CHOICES, formatDistance } from './units';
import { zoneRadius } from '../engine/candidates';
import { HOME_MAP_NAME } from '../community/board';

/**
 * Layer list. Each point layer gets two switches: the points themselves, and
 * their Voronoi cells.
 *
 * The cells matter because a matching question — "is your nearest park the same
 * as mine?" — is literally a question about which Voronoi cell you are standing
 * in. Being able to see the cells turns a yes/no into a shape on the map.
 */
export function LayerPanel(props: {
  data: GameData;
  /** The community map being played on, or null for the one the app ships. */
  boardName: string | null;
  /** Return to the map the app ships; null when already on it, or mid-round. */
  onBuiltIn: (() => void) | null;
}) {
  const { data } = props;
  const visible = useGame((s) => s.visibleLayers);
  const toggle = useGame((s) => s.toggleLayer);
  const settings = useGame((s) => s.settings);
  const update = useGame((s) => s.updateSettings);

  return (
    <div className="pad">
      <h3>Game board</h3>
      <div className="row">
        <span className="grow">
          {props.boardName ?? HOME_MAP_NAME}
          <span className="muted small"> · {data.stations.length} stations</span>
        </span>
        <a className="buttonlink" href="#/maps">Map studio</a>
      </div>
      <p className="muted small">
        Browse community maps, or build your own for any city, in the map studio.
        {' '}<a href="#/start">Start on another city or map</a>, or go <a href="#/">home</a>.
        {props.onBuiltIn && <> <button className="link" onClick={props.onBuiltIn}>Go back to {HOME_MAP_NAME}</button></>}
      </p>

      <h3>Map layers</h3>
      <p className="muted small">
        Turning a layer on also labels it. Voronoi cells show which feature each
        part of the city is nearest to.
      </p>

      <ul className="list layers">
        {LAYER_DEFS.map((def) => {
          const n = data.layers[def.key]?.features.length ?? 0;
          const cells = data.voronoi[def.key]?.features.length ?? 0;
          const vKey = `${def.key}:voronoi`;
          return (
            <li key={def.key} className={n === 0 ? 'muted layerrow' : 'layerrow'}>
              <label>
                <input
                  type="checkbox"
                  disabled={n === 0}
                  checked={visible.includes(def.key)}
                  onChange={() => toggle(def.key)}
                />
                <span className="grow">{def.label}</span>
                <span className="muted small">{n === 0 ? 'not on map' : n}</span>
              </label>

              {cells > 0 && (
                <label className="sub">
                  <input
                    type="checkbox"
                    checked={visible.includes(vKey)}
                    onChange={() => toggle(vKey)}
                  />
                  <span className="grow">{def.label} — Voronoi</span>
                  <span className="muted small">{cells} cells</span>
                </label>
              )}
            </li>
          );
        })}
      </ul>

      <h3>Rules</h3>

      {/*
        One setting for every distance the app works out. Question text is not
        included and never will be: "within 2 km" is what both players say to
        each other, and converting it would put the seeker and the hider on
        different numbers.
      */}
      <label className="setting">
        <span>
          Distances
          <span className="muted small">
            Everything the app measures — your distance to the seekers, drift from your
            zone centre, GPS accuracy, the measuring tool. Question text stays metric, as
            the rulebook prints it.
          </span>
        </span>
        <div className="seg">
          {UNIT_CHOICES.map((u) => (
            <button
              key={u.value}
              className={settings.units === u.value ? 'on' : ''}
              onClick={() => update({ units: u.value })}
              title={u.hint}
            >{u.label}</button>
          ))}
        </div>
      </label>

      {/*
        Strict and loose describe how much of a zone an answer has to rule out
        before the zone goes: its centre, or every last portion of it.
      */}
      <label className="setting">
        <span>
          Rule zones out by
          <span className="muted small">
            {settings.strictness === 'strict'
              ? 'Strict — the zone centre: the station in the middle either fits the answer or it does not, and the zone goes with it. Narrows fastest; matches the numbers in the Ask list.'
              : `Loose — portions of the zone: each answer cuts away the part of every ${formatDistance(zoneRadius(), settings.units)} circle it rules out, and a zone goes only when nothing of it is left. Never rules out the true zone.`}
          </span>
        </span>
        <div className="seg">
          <button
            className={settings.strictness === 'strict' ? 'on' : ''}
            onClick={() => update({ strictness: 'strict' })}
          >Strict</button>
          <button
            className={settings.strictness === 'loose' ? 'on' : ''}
            onClick={() => update({ strictness: 'loose' })}
          >Loose</button>
        </div>
      </label>

      <label className="setting">
        <span>
          Game size
          <span className="muted small">
            Selects which questions are in play. Agree on it before the round starts: this board has{' '}
            {data.stations.length} stations.
          </span>
        </span>
        <div className="seg">
          {(['small', 'medium', 'large'] as const).map((s) => (
            <button key={s} className={settings.gameSize === s ? 'on' : ''} onClick={() => update({ gameSize: s })}>
              {s}
            </button>
          ))}
        </div>
      </label>
    </div>
  );
}
