import { describe, expect, it } from 'vitest';
import { parseRoute } from '../route';
import { cityDirectory, cityName, countLabel, countryName, flagOf, matchCities } from './cities';
import { parseMapFile, serializeMap } from './format';

describe('city directory', () => {
  it('shows a count up to ten, and "10+" past it', () => {
    expect([0, 1, 9, 10, 11, 250].map(countLabel)).toEqual(['0', '1', '9', '10', '10+', '10+']);
  });

  it('spells a flag from a country code, and a globe without one', () => {
    expect(flagOf('us')).toBe('🇺🇸');
    expect(flagOf('JP')).toBe('🇯🇵');
    expect(flagOf(null)).toBe('🌐');
    expect(flagOf('usa')).toBe('🌐');
    expect(countryName('us')).toBe('United States');
    expect(countryName('')).toBeNull();
  });

  it('always lists the shipped city, and counts its built-in board as a map', () => {
    expect(cityDirectory([])).toEqual([{ city: 'sf', name: 'San Francisco', country: 'us', mapCount: 1, builtIn: true }]);

    const dir = cityDirectory([
      { city: 'sf', country: 'us', mapCount: 6 },
      { city: 'oakland', country: 'us', mapCount: 2 },
      { city: 'east-bay', country: null, mapCount: 11 },
    ]);
    expect(dir.map((c) => [c.city, c.mapCount])).toEqual([['east-bay', 11], ['sf', 7], ['oakland', 2]]);
    expect(dir.find((c) => c.city === 'east-bay')).toMatchObject({ name: 'East Bay', country: null, builtIn: false });
    // Ten community maps and the built-in one is eleven, which reads "10+"; it never goes past the cap.
    expect(countLabel(cityDirectory([{ city: 'sf', country: 'us', mapCount: 10 }])[0].mapCount)).toBe('10+');
    expect(cityDirectory([{ city: 'sf', country: 'us', mapCount: 11 }])[0].mapCount).toBe(11);
  });

  it('finds a city by its name or its label, as it is typed', () => {
    const dir = cityDirectory([
      { city: 'oakland', country: 'us', mapCount: 2 },
      { city: 'san-jose', country: 'us', mapCount: 1 },
      { city: 'osaka', country: 'jp', mapCount: 3 },
    ]);
    const found = (q: string) => matchCities(dir, q).map((c) => c.city);
    expect(found('')).toEqual(['osaka', 'oakland', 'sf', 'san-jose']);
    expect(found('san')).toEqual(['sf', 'san-jose']);
    expect(found('SF')).toEqual(['sf']);
    expect(found('  oak')).toEqual(['oakland']);
    expect(found('jose')).toEqual(['san-jose']);
    expect(found('japan')).toEqual(['osaka']);
    expect(found('atlantis')).toEqual([]);
    expect(cityName('san-jose')).toBe('San Jose');
  });
});

describe('a map’s country', () => {
  const map = {
    format: 'jetleg-map', formatVersion: 1, kind: 'stations', city: 'sf', name: 'Two stops', description: '', rules: {},
    stations: [
      { id: 'a', name: 'A', lon: -122.4, lat: 37.77, modes: ['bus'], routes: [] },
      { id: 'b', name: 'B', lon: -122.41, lat: 37.78, modes: ['bus'], routes: [] },
    ],
  };

  it('is kept when it is a country code, dropped when it is not', () => {
    const withCountry = parseMapFile({ ...map, country: ' JP ' });
    expect(withCountry.ok && withCountry.map.country).toBe('jp');
    const junk = parseMapFile({ ...map, country: 'Japan' });
    expect(junk.ok && 'country' in junk.map).toBe(false);
  });

  it('leaves a map without one serializing exactly as before', () => {
    const plain = parseMapFile(map);
    expect(plain.ok && serializeMap(plain.map)).not.toContain('country');
    const withCountry = parseMapFile({ ...map, country: 'us' });
    const text = withCountry.ok ? serializeMap(withCountry.map) : '';
    expect(JSON.parse(text).country).toBe('us');
    expect(parseMapFile(JSON.parse(text))).toEqual(withCountry);
  });
});

describe('routes', () => {
  it('reads every page from its hash', () => {
    expect(parseRoute('')).toEqual({ page: 'home' });
    expect(parseRoute('#')).toEqual({ page: 'home' });
    expect(parseRoute('#/')).toEqual({ page: 'home' });
    expect(parseRoute('#/play')).toEqual({ page: 'play' });
    expect(parseRoute('#/start')).toEqual({ page: 'start' });
    expect(parseRoute('#/stats')).toEqual({ page: 'stats' });
    expect(parseRoute('#/about')).toEqual({ page: 'about' });
    expect(parseRoute('#/privacy')).toEqual({ page: 'privacy' });
    expect(parseRoute('#/maps')).toEqual({ page: 'maps' });
    expect(parseRoute('#/maps/new')).toEqual({ page: 'maps', create: true });
    expect(parseRoute('#/maps/map/abc-123')).toEqual({ page: 'maps', open: 'abc-123' });
    expect(parseRoute('#/nonsense')).toEqual({ page: 'home' });
  });
});
