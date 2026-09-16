/**
 * Station name length, for the "Station Name's Length" matching question.
 *
 * Counts letters, digits, spaces and hyphens as they appear on the map;
 * everything else (&, /, periods, apostrophes) is stripped first, so two
 * stations whose names differ only by punctuation still match.
 */
export function stationNameLength(name: string): number {
  return name.replace(/[^A-Za-z0-9\- ]/g, '').length;
}
