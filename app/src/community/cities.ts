import type { CityRow } from './api';
import { CITY, CITY_COUNTRY, CITY_NAME } from './board';
import { countryCode } from './format';

/**
 * The city directory behind "Start a game": type a city, see its flag and
 * how many maps it has.
 *
 * A city here is the short label its maps are filed under ('sf', 'oakland')
 * — what an author typed, not a gazetteer entry. The one city the app ships
 * a board for is always present, with or without a server.
 */

export type CityEntry = {
  /** The label maps are filed under. */
  city: string;
  /** What to call it on screen. */
  name: string;
  /** ISO 3166-1 alpha-2, lowercase; null when no map names one. */
  country: string | null;
  /** Main maps, not branches — capped; show it with `countLabel`. */
  mapCount: number;
  /** The board this app ships is for this city. */
  builtIn: boolean;
};

/**
 * The directory never shows a number past this: beyond ten it says "10+".
 * It is a cap on the number shown, not on how many maps a city may have.
 */
export const COUNT_CAP = 10;

export const countLabel = (n: number): string => (n > COUNT_CAP ? `${COUNT_CAP}+` : String(Math.max(0, Math.floor(n))));

/**
 * A country's flag, as the pair of regional-indicator letters that spell its
 * code. Systems without flag glyphs (Windows) show the two letters instead,
 * which still says which country. No country: a globe.
 */
export function flagOf(country: string | null | undefined): string {
  const code = countryCode(country);
  if (!code) return '🌐';
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 97));
}

/** "United States" for 'us'; null for a code that names no country. */
export function countryName(country: string | null | undefined): string | null {
  const code = countryCode(country).toUpperCase();
  if (!code) return null;
  try {
    const name = new Intl.DisplayNames(undefined, { type: 'region', fallback: 'none' }).of(code);
    return name ?? null;
  } catch {
    return null;
  }
}

/** A label as a name: 'east-bay' → 'East Bay'. The shipped city has a proper one. */
export function cityName(city: string): string {
  if (city === CITY) return CITY_NAME;
  return city.replace(/[-_]+/g, ' ').replace(/(^|\s)\p{L}/gu, (m) => m.toUpperCase()).trim();
}

/**
 * The directory: what the server knows, plus the shipped board — which is a
 * map in its own right and counts as one.
 */
export function cityDirectory(rows: CityRow[]): CityEntry[] {
  const entries = new Map<string, CityEntry>();
  for (const r of rows) {
    entries.set(r.city, { city: r.city, name: cityName(r.city), country: countryCode(r.country) || null, mapCount: r.mapCount, builtIn: false });
  }
  const shipped = entries.get(CITY);
  entries.set(CITY, {
    city: CITY,
    name: CITY_NAME,
    country: CITY_COUNTRY,
    // Past the cap there is nothing more to say, so it stays there.
    mapCount: Math.min((shipped?.mapCount ?? 0) + 1, COUNT_CAP + 1),
    builtIn: true,
  });
  return [...entries.values()].sort((a, b) => b.mapCount - a.mapCount || a.name.localeCompare(b.name));
}

const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Cities matching what has been typed, best first: a name or label that
 * starts with it, then one that merely contains it. Nothing typed: all of
 * them, busiest first.
 */
export function matchCities(entries: CityEntry[], query: string): CityEntry[] {
  const q = fold(query);
  if (!q) return entries;
  const rank = (e: CityEntry) => {
    const names = [fold(e.name), fold(e.city), fold(countryName(e.country) ?? '')];
    if (names.slice(0, 2).some((n) => n.startsWith(q))) return 0;
    if (names.slice(0, 2).some((n) => n.split(' ').some((w) => w.startsWith(q)) || n.includes(q))) return 1;
    return names[2] && names[2].startsWith(q) ? 2 : -1;
  };
  return entries
    .map((e) => ({ e, r: rank(e) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r)
    .map((x) => x.e);
}
