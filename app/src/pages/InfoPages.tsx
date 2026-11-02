import { Page } from './Page';

/**
 * Who to write to about the site or about data held on its server. Left
 * empty until there is an address meant to be public; the pages below say
 * so plainly rather than inventing one.
 */
const CONTACT_EMAIL = '';

const Contact = () =>
  CONTACT_EMAIL
    ? <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
    : <>the person who runs this site</>;

export function AboutPage() {
  return (
    <Page title="About">
      <article className="prose">
        <h2>What JetLeg is</h2>
        <p>
          JetLeg is the map for a game of Hide+Seek played across a whole city on public transit. One
          player hides within walking distance of a transit station. The others chase them down by asking
          questions — <i>are you within 2 km of me? is your nearest park the same as mine?</i> — and every
          answer rules part of the city out.
        </p>
        <p>
          The app does the part that is slow and error-prone by hand: it draws each answer on the map,
          crosses off the stations that no longer fit, and tells the hider the truthful answer to give.
          Seekers see what is left. Hiders see what they have given away.
        </p>

        <h2>How to use it</h2>
        <ul>
          <li><a href="#/start">Start a game</a> — pick a city and one of its maps, then choose whether you are seeking or hiding.</li>
          <li><a href="#/maps">Explore maps</a> — boards other players have published, with their history and discussion.</li>
          <li><a href="#/maps/new">Create a map</a> — a different set of stations for San Francisco, or a whole board for another city.</li>
          <li><a href="#/stats">Game stats</a> — any round, looked back on question by question.</li>
        </ul>

        <h2>Yours, on your device</h2>
        <p>
          A round is stored on the phone it is played on, and works with no connection once the map has
          loaded. A hider's position never leaves their phone. What the site does keep on a server, and
          when, is set out on the <a href="#/privacy">privacy page</a>.
        </p>

        <h2>Credits</h2>
        <p>
          Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors,
          available under the Open Database License. Background map tiles by{' '}
          <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a>. Maps in the
          community section are made by the players who published them.
        </p>
        <p>
          JetLeg is an unofficial, fan-made companion. It is not affiliated with or endorsed by the makers
          of <i>Jet Lag: The Game</i> or its Hide+Seek game; you need their rulebook and cards to play.
        </p>
      </article>
    </Page>
  );
}

export function PrivacyPage() {
  return (
    <Page title="Privacy">
      <article className="prose">
        <h2>The short version</h2>
        <p>
          Your game lives on your device. The server holds an anonymous id for the device and, beyond that,
          only what a feature you chose to use needs — paying, joining a game with other phones, or
          publishing to the community. It never stores where you are.
        </p>

        <h2>What stays on your device</h2>
        <ul>
          <li>Every round: the questions, the answers, and where you were when you asked them.</li>
          <li>Your settings, anything you draw with the measuring tools, and the map you chose to play on.</li>
          <li>Game files you save or open. Opening one on the <a href="#/stats">stats page</a> reads it in your browser; it is not uploaded.</li>
          <li>
            A game's chat — its questions, answers, messages and photos. They go from phone to phone
            through a relay that keeps nothing, and each phone keeps its own copy with its rounds. Saving a
            game file includes them. Deleting the rounds from that game deletes them, photos included, once
            you have also left the game.
          </li>
        </ul>
        <p>
          Clearing this site's data in your browser removes all of it. So can your phone, after a few weeks
          unused — save a game file if you want to keep a round.
        </p>

        <h2>Your location</h2>
        <ul>
          <li>Your position is used on your device to answer questions. It is not stored on a server.</li>
          <li>
            If you join a game with other phones, a <b>seeker's</b> live position is passed to the other
            phones in that game so it can be drawn on their maps. It is relayed, not kept, and stops when
            you leave the game or close the app.
          </li>
          <li>A <b>hider's</b> position is never sent, to anyone.</li>
          <li>
            A photo sent in the game chat has its hidden location data — the position a phone camera writes
            into every picture — removed on your phone before it is sent.
          </li>
        </ul>

        <h2>What the server keeps, and when</h2>
        <ul>
          <li>
            <b>When you open the game:</b> your device is given an anonymous id — no name, no email — so
            the site can tell whether that device has a pass to play.
          </li>
          <li>
            <b>If you buy a pass:</b> payment is handled by Stripe; this site never sees your card. It keeps
            a record of the pass, the device it was activated on, and the email you gave Stripe, so a pass
            can be restored.
          </li>
          <li>
            <b>If you join a game:</b> the name you typed, which game and team you are in, and whether you
            are seeking or hiding.
          </li>
          <li>
            <b>If you sign in</b> (needed only to publish, like or comment), with an emailed code or with
            Google: your email address, your display name, and what you publish — maps, comments, likes
            and dislikes. Published maps and comments are public, under your display name. Your email is
            not shown.
          </li>
          <li>
            <b>Signing in with Google</b> keeps your Google account's id, email address and name, and
            nothing else. Google's sign-in also offers your profile picture and language; they are thrown
            away as the account is saved. Your name is only ever suggested as a display name — you choose
            what is shown.
          </li>
          <li>
            <b>Only if you turn it on:</b> finished rounds saved to your team's history. It is off by
            default; the switch, and exactly what is sent, is on the <a href="#/stats">stats page</a>.
          </li>
        </ul>

        <h2>Other services the site talks to</h2>
        <ul>
          <li>Map tiles are loaded from OpenFreeMap, which sees the area you are looking at, as any map service does.</li>
          <li>The map studio's search and import tools query OpenStreetMap's public services for the place you name.</li>
          <li>Google, if you choose to sign in with it.</li>
          <li>Stripe, when you pay. The server that holds the items above is run on Supabase; the site itself is served by Cloudflare.</li>
        </ul>
        <p>There is no advertising and no analytics or tracking script on this site.</p>

        <h2>Deleting your data</h2>
        <p>
          Anything on your device you can delete yourself. Maps and comments you published can be deleted
          from their own pages. To have an account and everything attached to it removed from the server,
          ask <Contact />.
        </p>
      </article>
    </Page>
  );
}
