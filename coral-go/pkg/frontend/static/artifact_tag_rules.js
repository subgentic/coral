/* The rules of an artifact tag (#8594), the server's (internal/board/artifact_tags.go): lowercase letters, digits, spaces and hyphens, 1 to 24 characters, at most 5 on a file; the starter set the menus offer first. Pure (no DOM,
 * no imports): the filters and the editor both read it, and it is tested on its own. */

export const STARTER = ['for review', 'internal', 'final', 'draft'];
export const MAX_TAGS = 5;
export const MAX_LEN = 24;
export const REVIEW = 'for review';

/** A tag as the server stores it: spaces made one, lowercase; '' for one the server would refuse. */
export function normalizeTag(s) {
    const t = String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    return t.length >= 1 && t.length <= MAX_LEN && /^[\p{L}\p{N} -]+$/u.test(t) ? t : '';
}

