/* Which approved skills a few typed letters mean (#12677): pure, so the $ menu's rule is tested on its own (skill_filter.test.mjs). */

/** The skills whose name or description a few letters start. Name matches come first. */
export function filterSkills(skills, words) {
    const q = String(words || '').trim().toLowerCase();
    if (!q) return skills.slice();
    const tokens = q.split(/\s+/), parts = t => String(t || '').toLowerCase().split(/[^a-z0-9\u00c0-\uffff]+/).filter(Boolean);
    const score = s => {
        const name = String(s.name || '').toLowerCase(), nameParts = parts(name), descParts = parts(s.description);
        if (name.startsWith(q)) return 0;
        if (tokens.every(t => nameParts.some(w => w.startsWith(t)))) return 1;
        if (name.includes(q)) return 2;
        if (tokens.every(t => nameParts.some(w => w.startsWith(t)) || descParts.some(w => w.startsWith(t)))) return 3;
        return -1;
    };
    return skills.map(s => [score(s), s]).filter(x => x[0] >= 0).sort((a, b) => a[0] - b[0]).map(x => x[1]);
}

