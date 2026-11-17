/* A goal's short name (#15245): the title is the whole goal text, so two long goals from one sentence read alike cut at "add…". The short name is its first clause outside brackets (up to a full stop, colon,
 * semicolon, dash or line break), at most 60 characters, cut at a word; "#N" in front is the number agents write ("goal #3"). The number agents write ("goal #3") is drawn in front by CSS from the element's data-goal-id, so the element's own text stays the name. The full title stays in the tooltip, the label and the goal's page. */
const CLAUSE = /[.:;—–\n]/;
export function shortTitle(title) {
    const t = String(title || '').replace(/[ \t]+/g, ' ').trim();
    let round = 0, square = 0, end = t.length;
    for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (c === '(') round++;
        else if (c === ')') round = Math.max(0, round - 1);
        else if (c === '[') square++;
        else if (c === ']') square = Math.max(0, square - 1);
        else if (!round && !square && (CLAUSE.test(c) || (c === '-' && t[i-1] === ' ' && t[i+1] === ' '))) { end = i; break; }
    }
    const first = t.slice(0, end).trim() || t;
    if (first.length <= 60) return first;
    const cut = first.slice(0, 60), at = cut.lastIndexOf(' ');
    let label = (at > 20 ? cut.slice(0, at) : cut).trimEnd();
    for (const [open, close] of [['(', ')'], ['[', ']']]) {
        const start = label.lastIndexOf(open);
        if (start > 0 && start > label.lastIndexOf(close)) label = label.slice(0, start).trimEnd();
    }
    return label + '…';
}
