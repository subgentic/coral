/* A goal's short name (#15245): the title is the whole goal text, so two long goals from one sentence read alike cut at "add…". The short name is its first clause (up to a full stop, colon,
 * semicolon, dash or line break), at most 60 characters, cut at a word; "#N" in front is the number agents write ("goal #3"). The number agents write ("goal #3") is drawn in front by CSS from the element's data-goal-id, so the element's own text stays the name. The full title stays in the tooltip, the label and the goal's page. */
const CLAUSE = /\s*(?:[.:;—–\n]|\s-\s)\s*/;
export function shortTitle(title) {
    const t = String(title || '').replace(/[ \t]+/g, ' ').trim(), first = t.split(CLAUSE)[0].trim() || t;
    if (first.length <= 60) return first;
    const cut = first.slice(0, 60), at = cut.lastIndexOf(' ');
    return (at > 20 ? cut.slice(0, at) : cut).trimEnd() + '…';
}
