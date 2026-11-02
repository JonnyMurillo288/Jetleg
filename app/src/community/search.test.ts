import { describe, expect, it } from 'vitest';
import { nameOrAuthor, searchTerm } from './search';

describe('searchTerm', () => {
  it('keeps what names are made of', () => {
    expect(searchTerm('  São Paulo  ')).toBe('São Paulo');
    expect(searchTerm("O'Hare & Loop - v2.1")).toBe("O'Hare & Loop - v2.1");
    expect(searchTerm('東京')).toBe('東京');
  });
  it('drops everything that means something to a PostgREST filter', () => {
    const t = searchTerm('a",author_id.eq.x),(name.ilike.*%_\\b');
    expect(t).not.toMatch(/[",()*%_\\]/);
    // Whatever is left sits inside one quoted value: two quotes, one comma, the one between the two columns.
    const f = nameOrAuthor(t);
    expect(f.match(/"/g)).toHaveLength(4);
    expect(f.match(/,/g)).toHaveLength(1);
  });
  it('is capped', () => {
    expect(searchTerm('x'.repeat(500))).toHaveLength(60);
  });
});
