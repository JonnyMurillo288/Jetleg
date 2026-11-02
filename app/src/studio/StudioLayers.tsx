import { useState } from 'react';
import type { GameData } from '../data/load';
import { LAYER_DEFS } from '../data/layers';

/** What the studio's map shows. Its own, not the game's: looking at a map here changes nothing there. */
export type StudioView = {
  stationDots: boolean;
  zoneBuffers: boolean;
  /** Place categories drawn as points. */
  places: string[];
  /** Place categories whose Voronoi cells are drawn. */
  cells: string[];
};

export const DEFAULT_VIEW: StudioView = { stationDots: true, zoneBuffers: true, places: [], cells: [] };

const flip = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

/**
 * The studio's layers control, on the map: station points and hiding zones,
 * every category of places, and their Voronoi cells — each on or off — so
 * the stations can be put away to look at the parks, or one category looked
 * at alone.
 *
 * The category being edited stays on (`editing`): its points are what the
 * taps land on.
 */
export function StudioLayers(props: { data: GameData; view: StudioView; onView: (v: StudioView) => void; editing: string | null; editingCells: boolean }) {
  const { data, view, onView, editing } = props;
  const [open, setOpen] = useState(false);
  const places = LAYER_DEFS.filter((d) => d.kind === 'point' && (data.layers[d.key]?.features.length ?? 0) > 0);
  const lines = LAYER_DEFS.filter((d) => d.kind === 'line' && (data.layers[d.key]?.features.length ?? 0) > 0);
  const withCells = LAYER_DEFS.filter((d) => (data.voronoi[d.key]?.features.length ?? 0) > 0);
  const on = view.places.filter((k) => data.layers[k]?.features.length).length + view.cells.filter((k) => data.voronoi[k]?.features.length).length;
  const off = (view.stationDots ? 0 : 1) + (view.zoneBuffers ? 0 : 1);

  const row = (key: string, label: string, n: number, unit: string, checked: boolean, toggle: () => void, locked = false) => (
    <label key={key} className="tight">
      <input type="checkbox" checked={checked || locked} disabled={locked} onChange={toggle} />
      <span>
        {label}
        <span className="muted small">{n} {unit}{locked ? ' · being edited' : ''}</span>
      </span>
    </label>
  );

  return (
    <div className="maptools studio-layers">
      <div className="maptools-row">
        <button className={`maplayers-btn ${open ? 'on' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          Layers{!open && on + off > 0 ? ` · ${on} on${off ? `, ${off} hidden` : ''}` : ''}
        </button>
      </div>
      {open && (
        <div className="maplayers-panel">
          <label>
            <input type="checkbox" checked={view.stationDots} onChange={() => onView({ ...view, stationDots: !view.stationDots })} />
            <span>Station points<span className="muted small">{data.stations.length} stations</span></span>
          </label>
          <label>
            <input type="checkbox" checked={view.zoneBuffers} onChange={() => onView({ ...view, zoneBuffers: !view.zoneBuffers })} />
            <span>Hiding zones<span className="muted small">{data.zoneRadiusM} m around each station</span></span>
          </label>

          <div className="maplayers-section">
            Places
            <span className="muted small">
              <button className="link" onClick={() => onView({ ...view, places: [...places, ...lines].map((d) => d.key) })}>All</button>
              {' · '}
              <button className="link" onClick={() => onView({ ...view, places: [] })}>None</button>
            </span>
          </div>
          <div className="maplayers-scroll">
            {[...places, ...lines].map((d) =>
              row(d.key, d.label, data.layers[d.key].features.length, d.kind === 'line' ? 'lines' : 'places',
                view.places.includes(d.key), () => onView({ ...view, places: flip(view.places, d.key) }), editing === d.key))}
            {places.length + lines.length === 0 && <p className="muted small">This map has no places yet.</p>}
          </div>

          <div className="maplayers-section">
            Voronoi cells
            <span className="muted small">
              Which place each part of the map is nearest to
              {view.cells.length > 0 && <> · <button className="link" onClick={() => onView({ ...view, cells: [] })}>Clear cells</button></>}
            </span>
          </div>
          <div className="maplayers-scroll">
            {withCells.map((d) =>
              row(`${d.key}:voronoi`, d.label, data.voronoi[d.key].features.length, 'cells',
                view.cells.includes(d.key), () => onView({ ...view, cells: flip(view.cells, d.key) }), editing === d.key && props.editingCells))}
            {withCells.length === 0 && <p className="muted small">No cells built yet.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
