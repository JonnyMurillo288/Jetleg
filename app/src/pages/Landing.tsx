import { useEffect, useState } from 'react';
import { useActiveRound, useGame } from '../store/game';
import { CITY_NAME, HOME_MAP_NAME } from '../community/board';
import { listMaps, type MapSummary } from '../community/api';
import { cityName, flagOf } from '../community/cities';
import { mapHref } from '../route';
import { PRODUCTS, ROOM_SEATS } from '../payments/products';
import './landing.css';

const img = (name: string) => `${import.meta.env.BASE_URL}${name}`;

/**
 * The front door, and the case for playing.
 *
 * The pictures here are pictures, not maps: `landing-sf.jpg` comes from
 * `npm run shot:landing` and everything under `marketing/` from
 * `npm run shot:marketing`, both screenshots of the real app. A live map
 * would cost a first-time visitor the whole map engine and every layer file
 * before they had decided to play. Retake them when what they show changes.
 *
 * Nothing on this page may claim more than the app does. The map cards are
 * read from the server, never written here, and every stat named is one
 * `stats/wrapped.ts` actually works out.
 */
export function Landing() {
  const round = useActiveRound();
  const inProgress = !!round && !round.endedAt;
  const played = useGame((s) => s.rounds.length);

  return (
    <div className="page landing">
      <header className="lp-hero">
        <img
          className="lp-hero-img"
          src={img('landing-sf.jpg')}
          width={1600}
          height={1000}
          alt={`The ${CITY_NAME} board: every hiding zone is a transit stop and the 500 m circle around it.`}
        />
        <nav className="lp-nav" aria-label="Site">
          <a className="lp-brand" href="#/">JetLeg</a>
          <span className="grow" />
          <a href="#/start">Play</a>
          <a href="#/maps">Maps</a>
          <a href="#/maps/new">Create</a>
          <a href="#/stats">Stats</a>
        </nav>
        <div className="lp-hero-text">
          <p className="lp-eyebrow">Customize your games.</p>
          <h1>Customize your games in your city</h1>
          <p className="lp-lede">
            Turn real places into games of hide and seek. Play a map made by someone who knows the city, or
            build your own — its boundary, its hiding zones, its rules. Then look back at how the hunt unfolded.
          </p>
          <div className="lp-ctas">
            {inProgress && (
              <a className="lp-btn primary" href="#/play">Continue your round</a>
            )}
            <a className={`lp-btn ${inProgress ? 'light' : 'primary'}`} href="#/start">Explore games</a>
            <a className="lp-btn light" href="#/maps/new">Create a map</a>
          </div>
          {inProgress && <p className="lp-resume">{round!.label} is still in progress.</p>}
          <p className="lp-inspired">Inspired by <i>Jet Lag: The Game</i>’s Hide and Seek.</p>
        </div>
      </header>

      <main>
        <section className="lp-section" aria-labelledby="how">
          <div className="lp-wrap">
            <h2 id="how">Ready, set, hide.</h2>
            <p className="lp-intro">Pick a place, gather your friends, and let the city do the rest.</p>
            <ol className="lp-steps">
              <li>
                <span className="lp-num">01</span>
                <strong>Find your game</strong>
                <span>Choose a city and a map to explore — ours, or one the community made.</span>
              </li>
              <li>
                <span className="lp-num">02</span>
                <strong>Bring your friends</strong>
                <span>Start a game and share its code. Hiders and seekers join from their own phones.</span>
              </li>
              <li>
                <span className="lp-num">03</span>
                <strong>Let the hunt begin</strong>
                <span>Ask questions, log the answers, and watch the map rule out every zone they contradict.</span>
              </li>
              <li>
                <span className="lp-num">04</span>
                <strong>See how it played out</strong>
                <span>When the round ends, go back through it question by question.</span>
              </li>
            </ol>
            <a className="lp-btn primary" href="#/start">Find your next game</a>
          </div>
        </section>

        <MapShelf />

        <section className="lp-section" aria-labelledby="place">
          <div className="lp-wrap">
            <p className="lp-kicker">What makes this map different?</p>
            <h2 id="place">A game built for this place.</h2>
            <p className="lp-intro">
              Every JetLeg map is a set of choices: where the edge of the game is, which stops you can hide at,
              and which places the questions are about. Here is one of ours.
            </p>
            <article className="lp-feature-card">
              <header>
                <h3>{HOME_MAP_NAME}</h3>
              </header>
              <ul className="lp-points">
                <li>
                  <strong>Transit stops as hiding zones</strong>
                  <span>Transit stops across the whole city, each the centre of a 500 m hiding zone.</span>
                </li>
                <li>
                  <strong>Matching zones from real places</strong>
                  <span>Parks, libraries, museums, hospitals, consulates and more split the city into cells, so
                    “is your nearest library the same as mine?” has exactly one right answer.</span>
                </li>
              </ul>
              <a className="lp-btn primary" href="#/start">Play this map</a>
            </article>
          </div>
        </section>

        <section className="lp-section alt" aria-labelledby="build">
          <div className="lp-wrap">
            <p className="lp-kicker">Any place can be a playground</p>
            <h2 id="build">Build a game that’s uniquely yours.</h2>
            <p className="lp-intro">
              Start with the whole city. Keep only what makes a great game. The map studio begins with real
              geographic data and lets you pare it down into something deliberate.
            </p>
            <div className="lp-shots">
              <figure>
                <img src={img('marketing/studio-curate.jpg')} width={1440} height={900} loading="lazy"
                  alt="The map studio with every station on the San Francisco board, and the 35 it suggests removing ringed in blue." />
                <figcaption>
                  <strong>Start with the map. Make it yours.</strong> Every stop on the board, with the ones the
                  studio suggests cutting ringed — nothing goes until you say so.
                </figcaption>
              </figure>
              <figure>
                <img src={img('marketing/studio-zones.jpg')} width={1440} height={900} loading="lazy"
                  alt="The map studio drawing San Francisco's libraries as matching cells: each cell is the ground nearest one library." />
                <figcaption>
                  <strong>Every neighbourhood brings something different.</strong> Matching cells built from the
                  city’s libraries, cut to the boundary. Use them as built, or import your own.
                </figcaption>
              </figure>
            </div>
            <ul className="lp-grid">
              <li><strong>Choose your playing field</strong><span>Set the boundary for a city, a neighbourhood or a campus — look it up on OpenStreetMap, or draw it by hand.</span></li>
              <li><strong>Pick your hiding locations</strong><span>Pull in transit stops from OpenStreetMap, then keep exactly the ones that belong in your game.</span></li>
              <li><strong>Make your own zones</strong><span>Choose the places matching questions are about, and the cells that decide them.</span></li>
              <li><strong>Set the rules</strong><span>Pick the hiding-zone size and the game size, so everyone plays the same game.</span></li>
              <li><strong>Share your creation</strong><span>Publish it for anyone to play. Others can like it, discuss it, or branch it into their own.</span></li>
            </ul>
            <div className="lp-ctas">
              <a className="lp-btn primary" href="#/maps/new">Start creating</a>
              <a className="lp-btn" href="#/maps">Explore the map studio</a>
            </div>
          </div>
        </section>

        <section className="lp-section" aria-labelledby="play">
          <div className="lp-wrap lp-split">
            <figure className="lp-phone">
              <img src={img('marketing/game-seeker.jpg')} width={780} height={1688} loading="lazy"
                alt="A seeker's phone mid-round: 77 of 192 zones left, the radar circle drawn, and the next questions with how many zones each would split." />
              <figcaption>A seeker, three answers in: 77 of 192 zones still possible.</figcaption>
            </figure>
            <div>
              <p className="lp-kicker">Gameplay</p>
              <h2 id="play">Less setup. More adventure.</h2>
              <p className="lp-intro">
                The map is ready before the game begins, so you can focus on the hunt instead of the paperwork.
              </p>
              <ul className="lp-points">
                <li><strong>Interactive game map</strong><span>Every hiding zone, where you are, and which zones are still standing.</span></li>
                <li><strong>Questions &amp; answers</strong><span>Matching, measuring, radar, thermometer, photo and tentacle questions — each showing how many zones it would split before you ask it.</span></li>
                <li><strong>Game chat</strong><span>Ask in the chat with the clock running; the hider answers with a tap or a photo, its location data stripped.</span></li>
                <li><strong>Custom rules</strong><span>Play with the stops, zones and settings the map’s creator chose.</span></li>
              </ul>
              <a className="lp-btn primary" href="#/start">Start a game</a>
            </div>
          </div>
        </section>

        <section className="lp-section alt" aria-labelledby="stats">
          <div className="lp-wrap lp-split reverse">
            <div>
              <p className="lp-kicker">Game stats</p>
              <h2 id="stats">Every game has a story. See yours.</h2>
              <p className="lp-intro">The hunt doesn’t end when someone gets found. Go back through any round, question by question:</p>
              <ul className="lp-ticks">
                <li>How many zones each answer ruled out, and the one that took the board below half</li>
                <li>Your best and weakest questions</li>
                <li>Whether the hider’s real zone survived every answer</li>
                <li>How close you came to the hider, and when</li>
                <li>The wait between questions and the ground you covered</li>
                <li>Cards the hider drew and kept</li>
              </ul>
              <p className="muted small">
                Worked out on your phone from the round itself. Nothing is uploaded unless you turn on sharing
                with your team.
              </p>
              <a className="lp-btn primary" href="#/stats">{played ? 'See your rounds' : 'Explore game stats'}</a>
            </div>
            <figure className="lp-phone">
              <img src={img('marketing/stats-round.jpg')} width={780} height={1688} loading="lazy"
                alt="Stats for a finished round: 3 of 192 zones left after 6 questions, the best and weakest question, and the hider's real station." />
              <figcaption>A sample round in {CITY_NAME}: six questions, answered truthfully.</figcaption>
            </figure>
          </div>
        </section>

        <section className="lp-section" aria-labelledby="price">
          <div className="lp-wrap">
            <p className="lp-kicker">What it costs</p>
            <h2 id="price">Free to explore. One room for the whole group.</h2>
            <div className="lp-prices">
              <div className="lp-price">
                <strong>Free, always</strong>
                <ul className="lp-ticks">
                  <li>Browse every map, and look at any board</li>
                  <li>Build, publish and branch maps in the map studio</li>
                  <li>Look back at rounds you have played</li>
                </ul>
              </div>
              <div className="lp-price featured">
                <strong>A game room</strong>
                <p className="lp-amounts">
                  {Object.values(PRODUCTS).map((p) => (
                    <span key={p.room}><b>{p.price}</b> for {p.label}</span>
                  ))}
                </p>
                <ul className="lp-ticks">
                  <li>One person buys it; up to {ROOM_SEATS} players join with its code</li>
                  <li>Unlimited rounds until the time runs out</li>
                  <li>The clock starts at the first round, so buy it the night before</li>
                  <li>No sign-in needed to play</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="lp-section" aria-labelledby="why">
          <div className="lp-wrap lp-narrow">
            <h2 id="why">Not just another map. A whole new way to play.</h2>
            <p className="lp-intro">
              No two cities are alike, so why should their games be? JetLeg turns real geography into hide and
              seek designed around the character, quirks and challenges of each place — and lets you relive
              every round afterwards.
            </p>
            <p className="lp-slogan">Create it. Share it. Play it.</p>
          </div>
        </section>

        <section className="lp-final" aria-labelledby="final">
          <div className="lp-wrap lp-narrow">
            <h2 id="final">The world is your game board.</h2>
            <p>Find your map. Find your friends. Find the hider.</p>
            <div className="lp-ctas center">
              <a className="lp-btn primary" href="#/start">Explore games</a>
              <a className="lp-btn light" href="#/maps/new">Create your own</a>
            </div>
          </div>
        </section>
      </main>

      <footer className="pagefoot">
        <a href="#/about">About</a>
        <a href="#/rules">Rules &amp; safety</a>
        <a href="#/privacy">Privacy</a>
        <a href="#/stats">Game stats</a>
        <p className="lp-disclaimer">
          Inspired by <i>Jet Lag: The Game</i>’s Hide and Seek. JetLeg is an unofficial, fan-made companion, not
          affiliated with or endorsed by its makers.
        </p>
      </footer>
    </div>
  );
}

/**
 * Three published maps, as the server has them. Ones whose creator said what
 * makes them different go first; with no server, or no maps yet, the section
 * says so rather than showing made-up ones.
 */
function MapShelf() {
  const [maps, setMaps] = useState<MapSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    listMaps('top').then((r) => {
      if (!live) return;
      if (!r.ok) { setFailed(true); return; }
      const described = r.value.filter((m) => m.description.trim());
      setMaps([...described, ...r.value.filter((m) => !m.description.trim())].slice(0, 3));
    });
    return () => { live = false; };
  }, []);

  return (
    <section className="lp-section alt" aria-labelledby="library">
      <div className="lp-wrap">
        <p className="lp-kicker">Community maps</p>
        <h2 id="library">Your next adventure is already mapped out.</h2>
        <p className="lp-intro">
          From whole cities to a single neighbourhood, play games designed by people who know their places best —
          each with its own stops, zones and rules.
        </p>
        {maps && maps.length > 0 && (
          <ul className="lp-cards">
            {maps.map((m) => (
              <li key={m.id}>
                <a className="lp-mapcard" href={mapHref(m.id)}>
                  <strong>{m.name}</strong>
                  <span className="muted small">
                    {flagOf(m.country)} {cityName(m.city)} · by {m.authorName}
                  </span>
                  <span className="lp-facts">
                    {m.stationCount} stations · ▲ {m.likeCount}
                    {m.branchCount > 0 && ` · ${m.branchCount} ${m.branchCount === 1 ? 'branch' : 'branches'}`}
                  </span>
                  {m.description.trim() && (
                    <span className="lp-different">
                      <em>What makes it different?</em> {m.description}
                    </span>
                  )}
                  <span className="lp-view">View map →</span>
                </a>
              </li>
            ))}
          </ul>
        )}
        {maps && maps.length === 0 && <p className="lp-empty">No one has published a map here yet. Yours could be the first.</p>}
        {!maps && !failed && <p className="lp-empty muted">Loading maps…</p>}
        {failed && <p className="lp-empty">Browse what has been published, or start your own, in the map studio.</p>}
        <div className="lp-ctas">
          <a className="lp-btn primary" href="#/maps">Explore community maps</a>
        </div>
      </div>
    </section>
  );
}
