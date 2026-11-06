import { Page } from './Page';

/**
 * Who to write to about the site or about data held on its server. Set at
 * build time (VITE_CONTACT_EMAIL, else VITE_REPORT_EMAIL) so each deployment
 * names its own and no address is committed. Unset, the pages say so
 * plainly rather than inventing one.
 */
const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL || import.meta.env.VITE_REPORT_EMAIL || '';

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
        <p>
          Before you play, read <a href="#/rules">playing safely</a>: the game happens on real streets and real
          transit. Before you publish or comment, read the <a href="#/rules">community rules</a>.
        </p>

        <h2>Contact</h2>
        <p>Questions about the site, a map, or your data: <Contact />.</p>

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
          JetLeg is inspired by <i>Jet Lag: The Game</i>’s Hide and Seek. It is an unofficial, fan-made
          companion, not affiliated with or endorsed by its makers; you need their rulebook and cards to play.
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
            the site can tell whether that device has a place in a game room.
          </li>
          <li>
            <b>If you buy a game room:</b> payment is handled by Stripe; this site never sees your card. It
            keeps a record of the room, which device bought it, and the email you gave Stripe.
          </li>
          <li>
            <b>If you join a game:</b> the name you typed, which game and team you are in, whether you
            are seeking or hiding, and that your device holds one of the room's places.
          </li>
          <li>
            <b>If you sign in</b> (needed only to publish, like or comment), with an emailed code or with
            Google: your email address, your display name, and what you publish — maps, comments, likes
            and dislikes. Published maps and comments are public, under your display name. Your email is
            not shown.
          </li>
          <li>
            <b>If you report a map or comment:</b> what you reported, your reason, and that it was you. Only
            the site's moderators can read reports; the person you reported is not told who it was.
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
          from their own pages.
        </p>
        <p>
          To delete your account, sign in and choose <b>Delete account</b> (under Map studio, beside your
          name). It takes effect at once and removes your display name, every map you published with its
          history and discussion, and your comments, likes and reports. Two things stay. A game room you
          bought keeps running for the players in it, and its record — the room and the email you gave
          Stripe for the receipt — is kept as the record of that payment. A place you took in a room stays
          taken, with nothing linking it to you.
        </p>
        <p>Anything else, or if you cannot sign in any more: <Contact />.</p>
      </article>
    </Page>
  );
}

export function RulesPage() {
  return (
    <Page title="Community rules">
      <article className="prose">
        <h2>Playing safely</h2>
        <p>
          JetLeg is played on real streets and real public transit, often in a hurry. Nothing in a game is
          worth getting hurt, fined or arrested for.
        </p>
        <ul>
          <li>Follow the law, the transit system's rules, and pay your fares.</li>
          <li>Stay off tracks and away from platform edges. Do not run in stations or on escalators.</li>
          <li>Look up from your phone when you cross a street.</li>
          <li>Do not enter private property, closed areas, or anywhere you would not normally be allowed.</li>
          <li>Agree before you start when the game ends, and how to reach each other if something goes wrong.</li>
          <li>
            A hider's position is never sent by the app. Tell someone outside the game where you will be,
            and keep your phone charged.
          </li>
          <li>Players under 18 should play with an adult's say-so, and in a group.</li>
        </ul>

        <h2>Publishing maps and comments</h2>
        <p>Maps and comments are public. Everything you publish must keep to these rules:</p>
        <ul>
          <li>
            <b>Public places only.</b> No hiding zones, places or boundaries that send players onto private
            property, into schools, or anywhere unsafe or off-limits.
          </li>
          <li>
            <b>No personal information.</b> No one's home, workplace, phone number or other private details —
            in a map's name, its description, its places or a comment.
          </li>
          <li><b>Be decent.</b> No harassment, threats, hate, or sexual content. Nothing illegal.</li>
          <li><b>Be honest.</b> Name and describe maps truthfully. No spam, advertising or pretending to be someone else.</li>
          <li>
            <b>Credit other makers.</b> Build on someone's map by branching it, which credits them, rather than
            publishing a copy as your own.
          </li>
        </ul>

        <h2>Reports and moderation</h2>
        <p>
          Signed-in players can report a map or a comment from its page. Moderators read every report. When
          three different players have reported the same thing, it is hidden straight away until a moderator
          looks, so something harmful does not stay up overnight. A moderator then either restores it or
          keeps it hidden.
        </p>
        <p>
          A hidden map or comment is not deleted: its author can still see it, play it and download it, and is
          told it is hidden. Maps and accounts that break these rules repeatedly may be removed.
        </p>
        <p>To appeal, or to report something urgent: <Contact />.</p>
      </article>
    </Page>
  );
}
