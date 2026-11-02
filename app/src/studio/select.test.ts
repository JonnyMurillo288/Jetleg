import { describe, expect, it } from 'vitest';
import type { LngLat } from '../engine/types';
import { combine, idsInShape } from './select';

// A grid of points 0.002° apart around San Francisco: about 180 m by 220 m.
const grid: { id: string; at: LngLat }[] = [];
for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) grid.push({ id: `${i},${j}`, at: [-122.45 + i * 0.002, 37.75 + j * 0.002] });

describe('selecting with a shape', () => {
  it('a rectangle selects exactly the points inside it', () => {
    const ring: LngLat[] = [[-122.4455, 37.7535], [-122.4395, 37.7535], [-122.4395, 37.7585], [-122.4455, 37.7585]];
    const got = idsInShape(grid, ring).sort();
    const want = grid.filter(({ at: [x, y] }) => x > -122.4455 && x < -122.4395 && y > 37.7535 && y < 37.7585).map((p) => p.id).sort();
    expect(want.length).toBe(9);
    expect(got).toEqual(want);
  });

  it('a lasso that crosses itself selects by even-odd, like a drawn loop', () => {
    // A bow tie: two triangles meeting at the centre.
    const bow: LngLat[] = [[-122.4505, 37.7495], [-122.4305, 37.7695], [-122.4305, 37.7495], [-122.4505, 37.7695]];
    const got = new Set(idsInShape(grid, bow));
    expect(got.has('0,5') || got.has('0,4')).toBe(true); // left wing
    expect(got.has('9,5') || got.has('9,4')).toBe(true); // right wing
    expect(got.has('4,0')).toBe(false); // the gap below the knot
  });

  it('with zones, a station whose circle reaches the shape is selected too', () => {
    const tiny: LngLat[] = [[-122.44, 37.76], [-122.4399, 37.76], [-122.4399, 37.7601], [-122.44, 37.7601]];
    expect(idsInShape(grid, tiny)).toEqual(['5,5']);
    const touching = idsInShape(grid, tiny, 250);
    // Within 250 m: the point itself and its eight neighbours (180–285 m away, so not all).
    expect(touching).toContain('5,5');
    expect(touching).toContain('4,5');
    expect(touching).toContain('5,4');
    expect(touching).not.toContain('3,5');
  });

  it('adds to a selection or takes away from it', () => {
    expect(combine(['a', 'b'], ['b', 'c'], 'add')).toEqual(['a', 'b', 'c']);
    expect(combine(['a', 'b', 'c'], ['b', 'x'], 'remove')).toEqual(['a', 'c']);
  });

  it('a line is not a shape', () => {
    expect(idsInShape(grid, [[-122.45, 37.75], [-122.43, 37.77]])).toEqual([]);
  });
});
