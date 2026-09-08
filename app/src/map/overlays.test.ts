import { describe, it, expect } from 'vitest';
import { buildMeasureFc } from './overlays';
import { formatDistance } from '../ui/units';
import type { MeasureState } from '../store/game';

const CIVIC: [number, number] = [-122.4194, 37.7793];
const base: MeasureState = { tool: 'off', radiusM: 500, shapes: [], draft: [] };

const kinds = (fc: ReturnType<typeof buildMeasureFc>) =>
  fc.features.map((f) => f.properties?.kind);

describe('distance formatting', () => {
  it('switches units at a readable threshold, not a mathematical one', () => {
    expect(formatDistance(400, 'metric')).toBe('400 m');
    expect(formatDistance(1500, 'metric')).toBe('1.50 km');
    expect(formatDistance(100, 'imperial')).toBe('328 ft');
    expect(formatDistance(1609.344, 'imperial')).toBe('1.00 mi');
  });
});

describe('measuring tool drawing', () => {
  it('draws a circle plus its radius label', () => {
    const fc = buildMeasureFc(
      { ...base, shapes: [{ id: 'a', kind: 'circle', center: CIVIC, radiusM: 500 }] },
      'metric',
    );
    expect(kinds(fc)).toEqual(['circle', 'centre']);
    expect(fc.features[1].properties?.label).toBe('r 500 m');
  });

  it('labels every leg of a line and totals it at the far end', () => {
    // Three points, two legs.
    const points: [number, number][] = [CIVIC, [-122.4194, 37.7883], [-122.4094, 37.7883]];
    const fc = buildMeasureFc({ ...base, shapes: [{ id: 'b', kind: 'line', points }] }, 'metric');
    const segments = fc.features.filter((f) => f.properties?.kind === 'segment');
    const vertices = fc.features.filter((f) => f.properties?.kind === 'vertex');
    const totals = fc.features.filter((f) => f.properties?.kind === 'centre');

    expect(segments).toHaveLength(2);
    expect(vertices).toHaveLength(3);
    expect(totals).toHaveLength(1);
    // ~1 km north then ~880 m east.
    expect(segments[0].properties?.label).toBe('999 m');
    expect(totals[0].properties?.label).toMatch(/^total 1\.8[0-9] km$/);
  });

  it('draws the line still being placed, flagged as a draft', () => {
    const fc = buildMeasureFc({ ...base, draft: [CIVIC, [-122.4094, 37.7793]] }, 'imperial');
    expect(fc.features.some((f) => f.properties?.draft === true)).toBe(true);
  });

  it('is empty when nothing has been drawn', () => {
    expect(buildMeasureFc(base, 'metric').features).toHaveLength(0);
  });
});
