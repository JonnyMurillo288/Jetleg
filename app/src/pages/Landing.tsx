import { useActiveRound, useGame } from '../store/game';
import { CITY_NAME } from '../community/board';

/**
 * The front door.
 *
 * The map here is a picture, not a map: `landing-sf.jpg` is a screenshot of
 * the built-in board, taken by `npm run shot:landing`. A live one would cost
 * a first-time visitor the whole map engine and every layer file before they
 * had decided to play. Retake it when the board changes.
 */
export function Landing() {
  const round = useActiveRound();
  const inProgress = !!round && !round.endedAt;
  const played = useGame((s) => s.rounds.length);

  return (
    <div className="page landing">
      <div className="hero">
        <img
          src={`${import.meta.env.BASE_URL}landing-sf.jpg`}
          width={1600}
          height={1000}
          alt={`The ${CITY_NAME} board: every hiding zone is a transit station and the 500 m circle around it.`}
        />
        <div className="hero-text">
          <h1>JetLeg</h1>
          <p>The map and deduction board for a game of Hide+Seek across a whole city.</p>
        </div>
        <span className="hero-caption">{CITY_NAME} · the built-in board</span>
      </div>

      <main className="page-body">
        <nav className="navgrid" aria-label="Site">
          {inProgress && (
            <a className="navcard primary" href="#/play">
              <strong>Continue your round</strong>
              <span>{round!.label} is still in progress.</span>
            </a>
          )}
          <a className={`navcard ${inProgress ? '' : 'primary'}`} href="#/start">
            <strong>Start a game</strong>
            <span>Pick a city and a map, then play.</span>
          </a>
          <a className="navcard" href="#/maps">
            <strong>Explore maps</strong>
            <span>Boards other players have published.</span>
          </a>
          <a className="navcard" href="#/maps/new">
            <strong>Create a map</strong>
            <span>New stations, or a whole new city.</span>
          </a>
          <a className="navcard" href="#/stats">
            <strong>Game stats</strong>
            <span>{played ? 'Your rounds, question by question.' : 'Every round, question by question.'}</span>
          </a>
        </nav>

        <footer className="pagefoot">
          <a href="#/about">About</a>
          <a href="#/privacy">Privacy</a>
        </footer>
      </main>
    </div>
  );
}
