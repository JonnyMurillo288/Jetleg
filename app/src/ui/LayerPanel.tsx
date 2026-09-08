import type { GameData } from '../data/load';
import { LAYER_DEFS } from '../data/load';
import { useGame } from '../store/game';
import { UNIT_CHOICES, formatDistance } from './units';
import { ZONE_RADIUS_M } from '../engine/candidates';

/**
 * Layer list. Each point layer gets two switches: the points themselves, and
 * their Voronoi cells.
 *
 * The cells matter because a matching question — "is your nearest park the same
 * as mine?" — is literally a question about which Voronoi cell you are standing
 * in. Being able to see the cells turns a yes/no into a shape on the map.
 */
export function LayerPanel({ data }: { data: GameData }) {
  const visible = useGame((s) => s.visibleLayers);
  const toggle = useGame((s) => s.toggleLayer);
  const settings = useGame((s) => s.settings);
  const update = useGame((s) => s.updateSettings);

  return (
    <div className="pad">
      <h3>Map layers</h3>
      <p className="muted small">
        Turning a layer on also labels it. Voronoi cells show which feature each
        part of the city is nearest to.
      </p>

      <ul className="list layers">
        <li>
          <label>
            <input
              type="checkbox"
              checked={visible.includes('districts')}
              onChange={() => toggle('districts')}
            />
            <span className="grow">Supervisor districts</span>
            <span className="muted small">{data.districts.features.length}</span>
          </label>
        </li>

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
        Named for what it tests rather than for how cautious it is. "Conservative"
        and "Strict" described the engine's attitude; "Zone centre" and "Whole
        zone" describe the thing on the map you are ruling in or out.
      */}
      <label className="setting">
        <span>
          Rule zones out by
          <span className="muted small">
            {settings.strictness === 'strict'
              ? 'Zone centre: the station in the middle either fits the answer or it does not. Matches the numbers in the Ask list.'
              : `Whole zone: kept unless every point in the ${formatDistance(ZONE_RADIUS_M, settings.units)} circle contradicts the answer. Never rules out the true zone, but narrows slowly.`}
          </span>
        </span>
        <div className="seg">
          <button
            className={settings.strictness === 'strict' ? 'on' : ''}
            onClick={() => update({ strictness: 'strict' })}
          >Zone centre</button>
          <button
            className={settings.strictness === 'conservative' ? 'on' : ''}
            onClick={() => update({ strictness: 'conservative' })}
          >Whole zone</button>
        </div>
      </label>

      <label className="setting">
        <span>
          Game size
          <span className="muted small">
            Selects which questions are in play. San Francisco is a hybrid — {data.stations.length} stations
            says medium, 120 km² says small.
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

      <label className="setting">
        <span>
          Supervisor districts as 4th division
          <span className="muted small">
            House rule. SF has no formal 4th administrative division, so that question is normally dead.
            Both sides must agree before the round starts.
          </span>
        </span>
        <input
          type="checkbox"
          checked={settings.supervisorDistrictsAsAdmin4}
          onChange={(e) => update({ supervisorDistrictsAsAdmin4: e.target.checked })}
        />
      </label>
    </div>
  );
}
