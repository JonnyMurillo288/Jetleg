import { useState } from 'react';
import { useGame, type MapLayers as MapLayerState } from '../store/game';
import { LAYER_DEFS, type GameData } from '../data/load';

/**
 * Layer control that lives on the map rather than in the sheet.
 *
 * Deciding what to ask next means reading the board, so the controls that change
 * what the board shows belong where you are looking. The board layers come
 * first; the Voronoi cells sit below them, because a matching question is
 * literally a question about which cell you are standing in.
 */
export function MapLayersControl({
  data,
  alive,
  total,
}: {
  data: GameData;
  alive: number;
  total: number;
}) {
  const [open, setOpen] = useState(false);
  const mapLayers = useGame((s) => s.mapLayers);
  const toggleMap = useGame((s) => s.toggleMapLayer);
  const visible = useGame((s) => s.visibleLayers);
  const toggleLayer = useGame((s) => s.toggleLayer);

  const board: { key: keyof MapLayerState; label: string; hint: string }[] = [
    { key: 'outOfPlay', label: 'Out of play', hint: 'Shade everywhere the answers rule out' },
    { key: 'zoneBuffers', label: 'Zone buffers', hint: '500 m circle around each station' },
    { key: 'stationDots', label: 'Station dots', hint: 'The stations themselves' },
  ];

  // Only layers that actually have cells to draw.
  const withCells = LAYER_DEFS.filter((d) => (data.voronoi[d.key]?.features.length ?? 0) > 0);
  const activeCells = withCells.filter((d) => visible.includes(`${d.key}:voronoi`)).length;

  return (
    <div className="maplayers">
      <button
        className={`maplayers-btn ${open ? 'on' : ''}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        Layers{activeCells > 0 && !open ? ` · ${activeCells}` : ''}
      </button>

      {open && (
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
      )}
    </div>
  );
}
