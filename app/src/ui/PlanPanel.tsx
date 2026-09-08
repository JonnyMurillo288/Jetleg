import { useGame } from '../store/game';
import { PLAN_COLORS, type PlanCandidate } from '../engine/plan';
import { formatDistance } from './units';
import { ZONE_RADIUS_M } from '../engine/candidates';
import type { Question } from '../engine/types';

/**
 * Compare up to three questions before spending one.
 *
 * The seeker's real decision is not how to answer — it is which question is
 * worth the cards it costs. That decision is currently made by scrolling a list
 * of eighty rows under a clock. This is the shortlist: same numbers, side by
 * side, with the candidate regions drawn on the map in matching colours so you
 * can see what each one would actually carve off the board.
 */
export function PlanPanel(props: {
  candidates: PlanCandidate[];
  alive: number;
  askCounts: Record<string, number>;
  onAsk: (q: Question) => void;
}) {
  const { candidates, alive, askCounts, onAsk } = props;
  const units = useGame((s) => s.settings.units);
  const planOnMap = useGame((s) => s.planOnMap);
  const setPlanOnMap = useGame((s) => s.setPlanOnMap);
  const toggle = useGame((s) => s.togglePlanQuestion);
  const clearPlan = useGame((s) => s.clearPlan);

  if (candidates.length === 0) {
    return (
      <div className="panel pad">
        <p className="muted">
          Nothing shortlisted yet. In <b>Ask</b>, open a question and tap <b>+ Plan</b> to
          compare it here — up to three at a time.
        </p>
        <p className="muted small">
          Each candidate is drawn on the map in its own colour, so you can see what it
          would rule out before you spend the cards on it.
        </p>
      </div>
    );
  }

  // The sharpest question is the one whose *worse* outcome still leaves the
  // fewest zones. Comparing best cases would recommend a lottery ticket.
  const scored = candidates.filter((c) => c.worst !== null);
  const bestWorst = scored.length ? Math.min(...scored.map((c) => c.worst!)) : null;

  return (
    <div className="panel">
      <div className="row pad-x">
        <label className="row small grow">
          <input type="checkbox" checked={planOnMap} onChange={() => setPlanOnMap(!planOnMap)} />
          Show candidates on the map
        </label>
        <button className="link" onClick={clearPlan}>Clear</button>
      </div>

      <ul className="list plan">
        {candidates.map((c, i) => {
          const color = PLAN_COLORS[i % PLAN_COLORS.length];
          const asked = askCounts[c.question.id] ?? 0;
          const sharpest = c.worst !== null && c.worst === bestWorst && scored.length > 1;
          // One side empty means the answer is already known — the same waste
          // the Ask list greys out, and the whole reason to shortlist first.
          const noSplit = !!c.split && (c.split.yes === 0 || c.split.no === 0);
          return (
            <li key={c.question.id} className="plancard">
              <div className="row tight-gap">
                <i className="sw" style={{ background: color }} />
                <b>{c.question.label}</b>
                {noSplit && <span className="tag warn">no split</span>}
                {sharpest && !noSplit && <span className="tag good">sharpest</span>}
                <span className="grow" />
                <button className="link" onClick={() => toggle(c.question.id)}>Remove</button>
              </div>

              <p className="qtext small">“{c.question.text}”</p>

              {c.blocked ? (
                <p className="warntext small">{c.blocked}</p>
              ) : c.split ? (
                <>
                  <SplitBar yes={c.split.yes} no={c.split.no} color={color} />
                  <p className="small">
                    <b>{c.worst}</b> zones left at worst, <b>{c.best}</b> at best
                    <span className="muted"> · from {alive}</span>
                  </p>
                  {noSplit && (
                    <p className="warntext small">
                      Every remaining zone falls on the same side — you already know the
                      answer, and asking still costs the cards.
                    </p>
                  )}
                </>
              ) : (
                <p className="muted small">No split preview for this category.</p>
              )}

              {c.note && <p className="muted small">{c.note}</p>}
              {c.radiusM !== undefined && (
                <p className="muted small">
                  You are {formatDistance(c.radiusM, units)} from your nearest — that is the
                  radius this question draws.
                </p>
              )}

              <div className="row">
                <button onClick={() => onAsk(c.question)}>Ask this</button>
                <span className="muted small">
                  {c.question.draw}
                  {asked > 0 && <> · already asked, ×{asked + 1} cost</>}
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="muted small pad-x">
        Splits count station centre points, the same as the Ask list. Elimination itself
        follows the rule set in Map — with “Whole zone” a candidate survives unless its
        whole {formatDistance(ZONE_RADIUS_M, units)} circle contradicts the answer, so the
        real count after asking can be a little higher.
      </p>
    </div>
  );
}

/** Yes and no as one bar: the shape of the split reads faster than the numbers. */
function SplitBar({ yes, no, color }: { yes: number; no: number; color: string }) {
  const total = Math.max(1, yes + no);
  return (
    <div className="splitbar" title={`${yes} yes / ${no} no`}>
      <span className="seg-yes" style={{ width: `${(yes / total) * 100}%`, background: color }} />
      <span className="seg-no" style={{ width: `${(no / total) * 100}%` }} />
      <span className="splitnums">
        <b>{yes}</b> yes · <b>{no}</b> no
      </span>
    </div>
  );
}
