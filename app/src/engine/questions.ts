import type { GameSize, Question } from './types';

/**
 * The full Hide+Seek question catalog: 80 questions in six categories.
 *
 * Counts reconcile against the rulebook's own total:
 *   20 matching + 20 measuring + 10 radar + 4 thermometer + 18 photo + 8 tentacle
 *
 * Draw rewards and time limits are per category, verbatim from the rulebook.
 */

const ALL: GameSize[] = ['small', 'medium', 'large'];
const MED_LARGE: GameSize[] = ['medium', 'large'];
const LARGE: GameSize[] = ['large'];

const q: Question[] = [];

// ------------------------------------------------------------- matching (20)
// "Is your nearest ___ the same as my nearest ___?"  draw 3, keep 1

const matching = (label: string, group: string, layer?: string, caveat?: string) =>
  q.push({
    id: `match-${slug(label)}`,
    category: 'matching',
    label,
    group,
    layer,
    text: `Is your nearest ${label.toLowerCase()} the same as my nearest ${label.toLowerCase()}?`,
    draw: 'draw 3, keep 1',
    timeLimitMin: 5,
    sizes: ALL,
    answerKind: 'yesno',
    caveat,
  });

matching('Commercial Airport', 'Transit', 'airports',
  'An airport counts as commercial if you can view flights to/from it on Google Flights.');
matching('Transit Line', 'Transit', 'transitLines',
  'You must be aboard a mode of transit, and it must be moving. If your train passes through the hider’s station without stopping, the answer is no.');
matching('Station Name’s Length', 'Transit', undefined,
  'Character count of the station name as your mapping app gives it. Hyphens and spaces count; "Station" counts if the app includes it.');
matching('Street or Path', 'Transit', 'streets',
  'A street ends when its name changes — "Jet Lag St. East" and "Jet Lag St. West" are different streets. Unnamed paths start and end at intersections.');

matching('1st Administrative Division', 'Administrative Divisions', 'admin1', 'US states.');
matching('2nd Administrative Division', 'Administrative Divisions', 'admin2', 'US counties.');
matching('3rd Administrative Division', 'Administrative Divisions', 'admin3', 'US municipalities.');
matching('4th Administrative Division', 'Administrative Divisions', 'admin4',
  'Boroughs, wards or special districts. San Francisco has no formal 4th division — enable the supervisor-district house rule in settings to use this question.');

matching('Mountain', 'Natural', 'mountains', 'Anything classified as a mountain by your mapping app. Measure to the map icon.');
matching('Landmass', 'Natural', 'landmass',
  'A landmass entirely surrounded by the seekers’ landmass counts as a match.');
matching('Park', 'Natural', 'parks', 'Measure to the map icon, even if you are standing inside a larger park.');

matching('Amusement Park', 'Places of Interest', 'amusementParks');
matching('Zoo', 'Places of Interest', 'zoos');
matching('Aquarium', 'Places of Interest', 'aquariums');
matching('Golf Course', 'Places of Interest', 'golfCourses', 'Outdoor courses only. Mini-golf and driving ranges do not count.');
matching('Museum', 'Places of Interest', 'museums');
matching('Movie Theater', 'Places of Interest', 'movieTheaters');

matching('Hospital', 'Public Utilities', 'hospitals');
matching('Library', 'Public Utilities', 'libraries');
matching('Foreign Consulate', 'Public Utilities', 'consulates', 'Honorary consulates are excluded.');

// ------------------------------------------------------------ measuring (20)
// "Compared to me, are you closer to or further from ___?"  draw 3, keep 1

const measuring = (label: string, group: string, layer?: string, caveat?: string) =>
  q.push({
    id: `meas-${slug(label)}`,
    category: 'measuring',
    label,
    group,
    layer,
    text: `Compared to me, are you closer to or further from ${article(label)} ${label.toLowerCase()}?`,
    draw: 'draw 3, keep 1',
    timeLimitMin: 5,
    sizes: ALL,
    answerKind: 'closerFurther',
    caveat,
  });

measuring('Commercial Airport', 'Transit-related', 'airports');
measuring('High-Speed Train Line', 'Transit-related', 'hsr',
  'EU definition: 250 km/h on purpose-built line, ~200 km/h on upgraded line.');
measuring('Rail Station', 'Transit-related', 'railStations', 'Light and heavy rail; metros and subways count.');

measuring('International Border', 'Borders', 'intlBorder', 'Enclaves count.');
measuring('1st Administrative Division Border', 'Borders', 'admin1Border', 'US state lines.');
measuring('2nd Administrative Division Border', 'Borders', 'admin2Border', 'US county lines.');

measuring('Sea Level', 'Natural', 'elevation', 'Your altitude. Sampled from a terrain model rather than the phone compass, which is unreliable.');
measuring('Body of Water', 'Natural', 'water', 'Any named body of water on your maps app, excluding pools.');
measuring('Coastline', 'Natural', 'coastline',
  'Where land meets the ocean, a great lake, or a waterway flowing into one that is never less than 2 km across.');
measuring('Mountain', 'Natural', 'mountains');
measuring('Park', 'Natural', 'parks');

measuring('Amusement Park', 'Places of Interest', 'amusementParks');
measuring('Zoo', 'Places of Interest', 'zoos');
measuring('Aquarium', 'Places of Interest', 'aquariums');
measuring('Golf Course', 'Places of Interest', 'golfCourses');
measuring('Museum', 'Places of Interest', 'museums');
measuring('Movie Theater', 'Places of Interest', 'movieTheaters');

measuring('Hospital', 'Public Utilities', 'hospitals');
measuring('Library', 'Public Utilities', 'libraries');
measuring('Foreign Consulate', 'Public Utilities', 'consulates');

// --------------------------------------------------------------- radar (10)
// "Are you within ___ of me?"  draw 2, keep 1

for (const [label, m] of [
  ['500 m', 500], ['1 km', 1000], ['2 km', 2000], ['5 km', 5000], ['10 km', 10000],
  ['15 km', 15000], ['40 km', 40000], ['80 km', 80000], ['160 km', 160000],
] as [string, number][]) {
  q.push({
    id: `radar-${m}`,
    category: 'radar',
    label,
    group: 'Radar',
    text: `Are you within ${label} of me?`,
    distanceM: m,
    draw: 'draw 2, keep 1',
    timeLimitMin: 5,
    sizes: ALL,
    answerKind: 'yesno',
    caveat: 'Radar asks about the hider’s location, not their hiding zone.',
  });
}
q.push({
  id: 'radar-choose',
  category: 'radar',
  label: 'Choose',
  group: 'Radar',
  text: 'Are you within [your chosen distance] of me?',
  draw: 'draw 2, keep 1',
  timeLimitMin: 5,
  sizes: ALL,
  answerKind: 'yesno',
  caveat: 'You may use any distance you wish. Set it when you log the answer.',
});

// --------------------------------------------------------- thermometer (4)
// "After traveling ___, am I hotter or colder?"  draw 2, keep 1

for (const [label, m, sizes] of [
  ['1 km', 1000, ALL], ['5 km', 5000, ALL], ['15 km', 15000, MED_LARGE], ['75 km', 75000, LARGE],
] as [string, number, GameSize[]][]) {
  q.push({
    id: `thermo-${m}`,
    category: 'thermometer',
    label,
    group: 'Thermometer',
    text: `After traveling ${label}, am I hotter or colder?`,
    distanceM: m,
    draw: 'draw 2, keep 1',
    timeLimitMin: 5,
    sizes,
    answerKind: 'hotterColder',
    caveat: 'Send the hider your start pin, travel at least this distance as the crow flies, then send your end pin.',
  });
}

// --------------------------------------------------------------- photo (18)
// "Send me a photo of ___."  draw 1, keep 1

const photo = (label: string, spec: string, sizes: GameSize[]) =>
  q.push({
    id: `photo-${slug(label)}`,
    category: 'photo',
    label,
    group: 'Photo',
    text: `Send me a photo of ${label.toLowerCase()}.`,
    draw: 'draw 1, keep 1',
    timeLimitMin: 10,
    sizes,
    answerKind: 'photo',
    spec,
  });

photo('Any Building Visible from Transit Station',
  'Stand directly outside a station entrance (your choice if there are several). Must include roof and both sides, with the top of the building in the top 1/3 of the frame.', ALL);
photo('The Widest Street', 'Must include both sides of the street. Background not required.', ALL);
photo('A Tree', 'Must include the entire tree.', ALL);
photo('The Tallest Structure In Your Current Sightline',
  'Tallest from your perspective, not objectively. Must include the top and both sides, top in the top 1/3 of the frame.', ALL);
photo('You', 'Selfie mode. Phone perpendicular to the ground, arm fully extended, default lens, no zoom.', ALL);
photo('The Sky', 'Place the phone on the ground and shoot directly up. Default lens, no zoom.', ALL);

photo('The Tallest Building Visible from Transit Station',
  'Tallest from your perspective. The station itself does not count, unless a tall building with an unrelated purpose sits atop it. Stand outside an entrance; include roof and both sides, top in the top 1/3.', MED_LARGE);
photo('A Trace of the Nearest Street/Path',
  'The street must be visible on your mapping app. Trace intersection to intersection — screenshot and black out everything but the street, or trace on paper over the screen.', MED_LARGE);
photo('2 Buildings', 'Must include the bottom and up to four stories.', MED_LARGE);
photo('A Restaurant Interior', 'No zoom. Shoot through the window from outside the restaurant.', MED_LARGE);
photo('A Park', 'No zoom, phone perpendicular to the ground. Stand 2 metres from any obstruction.', MED_LARGE);
photo('A Grocery Store Aisle', 'No zoom. Stand at the end of the aisle and shoot directly down it.', MED_LARGE);
photo('A Place of Worship',
  'Must include a 2 m x 2 m section with three distinct elements — enough that someone standing there could confidently match it.', MED_LARGE);
photo('A Train Platform',
  'Must include a 2 m x 2 m section with three distinct elements — enough that someone standing there could confidently match it.', MED_LARGE);

photo('1 km of Streets Traced',
  'Continuous, at least 5 turns, no doubling back. Send north-south oriented. Streets must appear on the mapping app.', LARGE);
photo('The Tallest Mountain Visible from Transit Station',
  'Tallest from your perspective. Max 3x zoom; the summit must be in the top 1/3 of the frame.', LARGE);
photo('The Biggest Body of Water in Your Zone',
  'Max 3x zoom. Must include both sides of the water or the horizon. Water visible from the zone but not touching it does not count.', LARGE);
photo('5 Buildings', 'Must include the bottom and up to four stories.', LARGE);

// ------------------------------------------------------------- tentacle (8)
// "Within ___ of me, which ___ are you nearest to?"  draw 4, keep 2
// Banned in small games.

const tentacle = (label: string, layer: string, m: number, sizes: GameSize[]) =>
  q.push({
    id: `tent-${slug(label)}-${m}`,
    category: 'tentacle',
    label: `${label} within ${m >= 1000 ? `${m / 1000} km` : `${m} m`}`,
    group: 'Tentacle',
    layer,
    distanceM: m,
    text: `Within ${m >= 1000 ? `${m / 1000} km` : `${m} m`} of me, which ${label.toLowerCase()} are you nearest to?`,
    draw: 'draw 4, keep 2',
    timeLimitMin: 5,
    sizes,
    answerKind: 'tentacle',
    caveat: 'If the hider is not within reach, "not within reach" is a valid answer.',
  });

tentacle('Museums', 'museums', 2000, MED_LARGE);
tentacle('Libraries', 'libraries', 2000, MED_LARGE);
tentacle('Movie Theaters', 'movieTheaters', 2000, MED_LARGE);
tentacle('Hospitals', 'hospitals', 2000, MED_LARGE);
tentacle('Metro Lines', 'transitLines', 25000, LARGE);
tentacle('Zoos', 'zoos', 25000, LARGE);
tentacle('Aquariums', 'aquariums', 25000, LARGE);
tentacle('Amusement Parks', 'amusementParks', 25000, LARGE);

// --------------------------------------------------------------------------

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function article(label: string): string {
  return /^[aeiou]/i.test(label) ? 'an' : 'a';
}

export const QUESTIONS: Question[] = q;

export const QUESTIONS_BY_ID: Record<string, Question> = Object.fromEntries(
  QUESTIONS.map((x) => [x.id, x]),
);

export const CATEGORY_ORDER = ['matching', 'measuring', 'radar', 'thermometer', 'photo', 'tentacle'] as const;

export const CATEGORY_META: Record<string, { title: string; blurb: string; draw: string }> = {
  matching: { title: 'Matching', blurb: 'Is your nearest ___ the same as mine?', draw: 'draw 3, keep 1' },
  measuring: { title: 'Measuring', blurb: 'Closer to or further from ___?', draw: 'draw 3, keep 1' },
  radar: { title: 'Radar', blurb: 'Are you within ___ of me?', draw: 'draw 2, keep 1' },
  thermometer: { title: 'Thermometer', blurb: 'After traveling ___, hotter or colder?', draw: 'draw 2, keep 1' },
  photo: { title: 'Photo', blurb: 'Send me a photo of ___.', draw: 'draw 1, keep 1' },
  tentacle: { title: 'Tentacle', blurb: 'Within ___, which ___ are you nearest?', draw: 'draw 4, keep 2' },
};

/** Sanity check: the rulebook says 80. */
if (import.meta.env?.DEV && QUESTIONS.length !== 80) {
  console.warn(`Question catalog has ${QUESTIONS.length} entries, expected 80`);
}
