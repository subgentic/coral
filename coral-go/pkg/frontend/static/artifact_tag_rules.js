/* The rules of an artifact tag (#8594), the server's (internal/board/artifact_tags.go): lowercase letters, digits, spaces and hyphens, 1 to 24 characters, at most 5 on a file; the starter set the menus offer first. Pure (no DOM,
 * no imports): the filters and the editor both read it, and it is tested on its own. */

export const STARTER = ['for review', 'internal', 'final', 'draft'];
export const MAX_TAGS = 5;
export const MAX_LEN = 24;
export const REVIEW = 'for review';

/** A tag as the server stores it: white space (Unicode White_Space, as Go's) made one space and trimmed, lower-cased one character at a time with no locale and no final-sigma context, and '' for one the server would
 * refuse: a character whose lower case is not one character (capital I with a dot) is refused. tests/frontend/fixtures/artifact_tag_cases.json is the table both sides are tested with (#8680). */
export function normalizeTag(s) {
    const chars = [...String(s ?? '').replace(/\p{White_Space}+/gu, ' ').replace(/^ | $/g, '')];
    const lower = [];
    for (const c of chars) {
        const l = c.toLowerCase(); // one character alone: no final-sigma context
        if ([...l].length !== 1) return '';
        lower.push(l);
    }
    const t = lower.join('');
    const n = lower.length; // characters, as the server counts them (an astral letter is one), not UTF-16 units
    return n >= 1 && n <= MAX_LEN && /^[\p{L}\p{Nd} -]+$/u.test(t) ? t : ''; // a decimal digit only: the server's unicode.IsDigit refuses "²" and "½"
}
