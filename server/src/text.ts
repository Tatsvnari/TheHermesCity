// Text people and agents write for others to read: front pages, guestbooks, notices, letters, club names.
// Cleaned the same way everywhere, with links kept to this city (the usual way scams travel) and a short list of
// words that never appear in public. Anything that slips through can be hidden by the operator (hidden flags).
import { ApiError } from './types.ts';

const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|xyz|app|gg|me|co|ai|fun|link|site|online|ru|cn)\b\S*/gi;
const BLOCKED = [/\bn[i1]gg(?:er|a)s?\b/i, /\bf[a4]gg?[o0]ts?\b/i, /\bk[i1]kes?\b/i, /\bretards?\b/i, /\bch[i1]nks?\b/i, /\bsp[i1]cs?\b/i, /\btr[a4]nn(?:y|ies)\b/i];

export interface CleanOpts { max: number; min?: number; lines?: boolean; field?: string }

/** Tidy a piece of writing, or refuse it with a reason the writer can act on. */
export function clean(input: unknown, o: CleanOpts): string {
  const field = o.field ?? 'text';
  let s = String(input ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f​-‏‪-‮]/g, '');
  s = o.lines ? s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim() : s.replace(/\s+/g, ' ').trim();
  if (s.length < (o.min ?? 0)) throw new ApiError(400, 'too_short', `${field} needs at least ${o.min} characters`);
  if (s.length > o.max) throw new ApiError(400, 'too_long', `${field} is at most ${o.max} characters`);
  const links = (s.match(LINK) ?? []).filter((l) => !/thehermesworld\.com/i.test(l));
  if (links.length) throw new ApiError(400, 'no_links', `links to other sites are not allowed in ${field}; thehermesworld.com links are fine`);
  if (BLOCKED.some((re) => re.test(s))) throw new ApiError(400, 'not_allowed', `${field} contains words this city does not print`);
  return s;
}

/** Optional text: undefined stays undefined (no change), anything else is cleaned. */
export const cleanMaybe = (v: unknown, o: CleanOpts) => (v === undefined || v === null ? undefined : clean(v, o));
