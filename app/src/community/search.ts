/**
 * A search term made safe to put inside a PostgREST filter: the characters
 * that filter syntax gives meaning to (commas, brackets, quotes, wildcards,
 * backslashes) are dropped, so a name can only ever be matched, never change
 * the query.
 */
export function searchTerm(q: string): string {
  return q.replace(/[^\p{L}\p{N}\p{M} '.&-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/**
 * The `or` filter matching a map by its name or its author's, for a term
 * already through `searchTerm`. Quoted, and the term has no quote, comma or
 * bracket left to break out of it.
 */
export function nameOrAuthor(term: string): string {
  const pattern = `"*${term}*"`;
  return `name.ilike.${pattern},author_name.ilike.${pattern}`;
}
