import { useEffect, useState } from 'react';
import type { GameData } from '../data/load';
import type { Station } from '../engine/types';
import { useGame } from '../store/game';
import { activeCellCount, LayersPanel } from './MapLayers';
import { MeasurePanel } from './MeasurePanel';
import { formatDistance } from './units';

/**
 * The controls that live on the map rather than in the sheet.
 *
 * One row of buttons, one panel open at a time. On a phone held one-handed
 * there is no room for two panels, and every pixel of open panel is a pixel of
 * board you cannot see — which is the thing you opened the panel to think about.
 */
export function MapToolbar({
  data,
  alive,
  total,
  canMeasure,
}: {
  data: GameData;
  alive: Station[];
  total: number;
  /**
   * Layers is map display (which POI/Voronoi layers are visible) and stays
   * free always. Measure is a planning aid — it reports how many surviving
   * zones a circle contains, which is engine-derived — so it's a game
   * mechanic, gated the same way asking a question is: behind an active
   * round, which is itself gated behind an entitlement in RoundGate.
   */
  canMeasure: boolean;
}) {
  const [open, setOpen] = useState<'none' | 'layers' | 'measure'>('none');
  const visible = useGame((s) => s.visibleLayers);
  const measure = useGame((s) => s.measure);
  const setTool = useGame((s) => s.setMeasureTool);
  const finishLine = useGame((s) => s.finishMeasureLine);
  const undoPoint = useGame((s) => s.undoMeasurePoint);
  const units = useGame((s) => s.settings.units);

  const cells = activeCellCount(data, visible);
  const drawn = measure.shapes.length;
  const toggle = (which: 'layers' | 'measure') => setOpen(open === which ? 'none' : which);

  // If a round ends (or was never entitled) while the tool is armed, its
  // button and hint vanish with it — release the map's taps back to the
  // game rather than leaving them silently swallowed with no visible "Done".
  useEffect(() => {
    if (!canMeasure) {
      if (measure.tool !== 'off') setTool('off');
      setOpen((o) => (o === 'measure' ? 'none' : o));
    }
  }, [canMeasure]);

  return (
    <div className="maptools">
      <div className="maptools-row">
        <button
          className={`maplayers-btn ${open === 'layers' ? 'on' : ''}`}
          onClick={() => toggle('layers')}
          aria-expanded={open === 'layers'}
        >
          Layers{cells > 0 && open !== 'layers' ? ` · ${cells}` : ''}
        </button>
        {canMeasure && (
          <button
            className={`maplayers-btn ${open === 'measure' || measure.tool !== 'off' ? 'on' : ''}`}
            onClick={() => toggle('measure')}
            aria-expanded={open === 'measure'}
          >
            Measure{drawn > 0 && open !== 'measure' ? ` · ${drawn}` : ''}
          </button>
        )}
      </div>

      {/*
        While a tool is armed the map's taps belong to it, not to the game — so
        say so, and put the way out where the thumb already is. The freeze this
        avoids is a player wondering why tapping a station no longer claims it.
      */}
      {canMeasure && measure.tool !== 'off' && (
        <div className="toolhint">
          <span className="grow">
            {measure.tool === 'circle'
              ? `Tap to drop a ${formatDistance(measure.radiusM, units)} circle`
              : measure.draft.length
                ? `${measure.draft.length} point${measure.draft.length === 1 ? '' : 's'} — tap to add`
                : 'Tap the map to start a line'}
          </span>
          {/* The panel is closed while drawing, so undo has to live here too —
              otherwise a mis-tap can only be fixed by starting over. */}
          {measure.tool === 'line' && measure.draft.length > 0 && (
            <button className="link" onClick={undoPoint}>Undo</button>
          )}
          {measure.tool === 'line' && measure.draft.length >= 2 && (
            <button className="link" onClick={finishLine}>Finish</button>
          )}
          <button className="link" onClick={() => setTool('off')}>Done</button>
        </div>
      )}

      {open === 'layers' && <LayersPanel data={data} alive={alive.length} total={total} />}
      {canMeasure && open === 'measure' && <MeasurePanel alive={alive} total={total} onArm={() => setOpen('none')} />}
    </div>
  );
}
