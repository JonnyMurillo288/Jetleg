import { useGame, type MeasureShape } from '../store/game';
import { metresCached } from '../engine/project';
import type { Station } from '../engine/types';
import { formatDistance, fromRadiusInput, radiusPresets, radiusUnit, toRadiusInput } from './units';

/**
 * The measuring tool: circles of a stated radius, and free lines with lengths.
 *
 * This is a planning instrument, not part of the game. Its value is answering
 * the questions the catalog cannot: how far is that walk, could the hider have
 * reached this side of the park, what would a radar of *this* radius cut from
 * *that* corner rather than from where I happen to be standing. Nothing drawn
 * here eliminates anything.
 */
export function MeasurePanel({
  alive,
  total,
  onArm,
}: {
  alive: Station[];
  total: number;
  /** Called when a tool is picked, so the panel can get off the map. */
  onArm: () => void;
}) {
  const measure = useGame((s) => s.measure);
  const units = useGame((s) => s.settings.units);
  const setTool = useGame((s) => s.setMeasureTool);
  const setRadius = useGame((s) => s.setMeasureRadius);
  const finishLine = useGame((s) => s.finishMeasureLine);
  const undoPoint = useGame((s) => s.undoMeasurePoint);
  const removeShape = useGame((s) => s.removeMeasureShape);
  const clear = useGame((s) => s.clearMeasure);

  const draftLength = pathLength(measure.draft);

  return (
    <div className="maplayers-panel measure">
      {/*
        Picking a tool closes this panel. It is 17rem wide on a 414 px screen —
        a third of the board, over the part of the city you are most likely to
        be measuring — and the next thing you want after arming a tool is
        somewhere to tap. The floating hint keeps the controls that still matter.
      */}
      <div className="seg wide flush">
        <button className={measure.tool === 'circle' ? 'on' : ''} onClick={() => { const on = measure.tool !== 'circle'; setTool(on ? 'circle' : 'off'); if (on) onArm(); }}>
          Circle
        </button>
        <button className={measure.tool === 'line' ? 'on' : ''} onClick={() => { const on = measure.tool !== 'line'; setTool(on ? 'line' : 'off'); if (on) onArm(); }}>
          Line
        </button>
        <button className={measure.tool === 'off' ? 'on' : ''} onClick={() => setTool('off')}>
          Off
        </button>
      </div>

      {measure.tool === 'circle' && (
        <>
          <div className="chips flush">
            {radiusPresets(units).map((p) => (
              <button
                key={p.label}
                className={`chip ${Math.abs(p.m - measure.radiusM) < 1 ? 'on' : ''}`}
                onClick={() => setRadius(p.m)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <label className="row small">
            Radius
            <input
              className="num"
              type="number"
              min={10}
              step={10}
              value={toRadiusInput(measure.radiusM, units)}
              onChange={(e) => setRadius(fromRadiusInput(Number(e.target.value) || 0, units))}
            />
            {radiusUnit(units)}
          </label>
          <p className="muted small">Tap the map to drop a circle of this radius.</p>
        </>
      )}

      {measure.tool === 'line' && (
        <>
          <p className="muted small">
            {measure.draft.length === 0
              ? 'Tap the map to start a line. Every leg is labelled with its length.'
              : `${measure.draft.length} point${measure.draft.length === 1 ? '' : 's'} · ${formatDistance(draftLength, units)} so far`}
          </p>
          <div className="row">
            <button disabled={measure.draft.length < 2} onClick={finishLine}>Finish line</button>
            <button disabled={!measure.draft.length} onClick={undoPoint}>Undo point</button>
          </div>
        </>
      )}

      {measure.shapes.length > 0 && (
        <>
          <div className="maplayers-section">Drawn</div>
          <ul className="list measures">
            {measure.shapes.map((s, i) => (
              <li key={s.id}>
                <i className="sw measure" />
                <span className="grow small">
                  {describe(s, units)}
                  {s.kind === 'circle' && (
                    <span className="muted"> · {inCircle(s, alive)}/{total} zones</span>
                  )}
                </span>
                <button className="link" onClick={() => removeShape(s.id)} aria-label={`Delete shape ${i + 1}`}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
          <button className="link" onClick={clear}>Clear all</button>
        </>
      )}
    </div>
  );
}

function describe(s: MeasureShape, units: 'imperial' | 'metric'): string {
  if (s.kind === 'circle') return `r ${formatDistance(s.radiusM, units)}`;
  return `${s.points.length} pts · ${formatDistance(pathLength(s.points), units)}`;
}

/**
 * Zones whose station centre falls inside the circle.
 *
 * Centre points, not the 500 m hiding circles — the same reading the ask list's
 * split uses, so a measured circle and a radar preview never disagree.
 */
function inCircle(s: Extract<MeasureShape, { kind: 'circle' }>, alive: Station[]): number {
  let n = 0;
  for (const st of alive) if (metresCached(s.center, [st.lon, st.lat]) <= s.radiusM) n++;
  return n;
}

export function pathLength(points: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += metresCached(points[i - 1], points[i]);
  return total;
}
