import { useGame, type MapLayers as MapLayerState } from '../store/game';
import { LAYER_DEFS, type GameData } from '../data/load';
import { ZONE_RADIUS_M } from '../engine/candidates';
import { formatDistance } from './units';

/**
 * Which layers are drawn on the map.
 *
 * Deciding what to ask next means reading the board, so the controls that
 * change what the board shows belong on the board rather than in the sheet. The
 * game layers come first; the Voronoi cells sit below them, because a matching
 * question is literally a question about which cell you are standing in.
 */
export function LayersPanel({
  data,
  alive,
  total,
}: {
  data: GameData;
  alive: number;
  total: number;
}) {
  const mapLayers = useGame((s) => s.mapLayers);
  const toggleMap = useGame((s) => s.toggleMapLayer);
  const visible = useGame((s) => s.visibleLayers);
  const toggleLayer = useGame((s) => s.toggleLayer);
  const units = useGame((s) => s.settings.units);

  const board: { key: keyof MapLayerState; label: string; hint: string }[] = [
    { key: 'outOfPlay', label: 'Out of play', hint: 'Shade everywhere the answers rule out' },
    { key: 'zoneBuffers', label: 'Zone buffers', hint: `${formatDistance(ZONE_RADIUS_M, units)} circle around each station` },
    { key: 'stationDots', label: 'Station dots', hint: 'The stations themselves' },
  ];

  const withCells = cellLayers(data);
  const activeCells = withCells.filter((d) => visible.includes(`${d.key}:voronoi`)).length;

  return (
    <div className="maplayers-panel">
      {board.map((it) => (
        <label key={it.key}>
          <input type="checkbox" checked={mapLayers[it.key]} onChange={() => toggleMap(it.key)} />
          <span>
            {it.label}
            <span className="muted small">{it.hint}</span>
          </span>
        </label>
      ))}

      <div className="maplayers-section">
        Voronoi cells
        <span className="muted small">Which feature each part of the city is nearest to</span>
      </div>

      <div className="maplayers-scroll">
        {withCells.map((d) => {
          const key = `${d.key}:voronoi`;
          const n = data.voronoi[d.key].features.length;
          return (
            <label key={key} className="tight">
              <input
                type="checkbox"
                checked={visible.includes(key)}
                onChange={() => toggleLayer(key)}
              />
              <span>
                {d.label}
                <span className="muted small">{n} cells</span>
              </span>
            </label>
          );
        })}
      </div>

      {activeCells > 0 && (
        <button className="link" onClick={() => {
          for (const d of withCells) {
            if (visible.includes(`${d.key}:voronoi`)) toggleLayer(`${d.key}:voronoi`);
          }
        }}>
          Clear all cells
        </button>
      )}

      <div className="maplayers-legend">
        <span><i className="sw alive" /> {alive} still possible</span>
        <span><i className="sw dead" /> {total - alive} ruled out</span>
      </div>
    </div>
  );
}

/** Only layers that actually have cells to draw. */
export const cellLayers = (data: GameData) =>
  LAYER_DEFS.filter((d) => (data.voronoi[d.key]?.features.length ?? 0) > 0);

/** How many cell layers are switched on, for the collapsed button label. */
export function activeCellCount(data: GameData, visible: string[]): number {
  return cellLayers(data).filter((d) => visible.includes(`${d.key}:voronoi`)).length;
}
