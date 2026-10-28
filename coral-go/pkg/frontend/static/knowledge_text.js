/* What a knowledge entry's text is made of (#7761): the Open Knowledge Format the distillation writes, a YAML front matter between two --- lines (type, title, description, tags: [a, b], timestamp) and then Markdown, whose links to
 * the team's other entries are relative files (./orchestrator.md). Pure functions, no DOM: the Knowledge tab shows the front matter as a block of facts and the rest through the safe renderer. */

const FRONT_LINES = 40; // the front matter is a few lines; a text whose first --- has no closing one this near is a document that starts with a rule

/** Splits `text` into its front matter and the Markdown after it: { facts, body }. facts is null when there is none (a text that does not start with a --- line, or whose block is not closed).
 *  facts: { type, title, description, tags: string[], timestamp } (what is there; "" or [] otherwise). Values are text, never markup. */
export function splitFrontMatter(text) {
    const s = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    const lines = s.split(/\r?\n/);
    if (lines[0].trim() !== '---') return { facts: null, body: s };
    let end = -1;
    for (let i = 1; i < lines.length && i <= FRONT_LINES; i++) { if (lines[i].trim() === '---') { end = i; break; } }
    if (end < 0) return { facts: null, body: s };
    const facts = { type: '', title: '', description: '', tags: [], timestamp: '' };
    for (const line of lines.slice(1, end)) {
        const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1].toLowerCase(), value = unquote(m[2].trim());
        if (key === 'tags') facts.tags = tagsOf(m[2].trim());
        else if (key in facts) facts[key] = value;
    }
    return { facts, body: lines.slice(end + 1).join('\n').replace(/^\s*\n/, '') };
}

function unquote(v) {
    return v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'")) ? v.slice(1, -1) : v;
}

/** tags: [a, b] or a, b -> ["a", "b"] */
function tagsOf(v) {
    const inner = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1) : v;
    return inner.split(',').map(t => unquote(t.trim())).filter(Boolean);
}

/** The distilled index is written with the team's board id (a name like b-p23b3rfwea): its first heading and its title line say the team's own name instead (#10376). Only those two lines: the body is the entry's. */
export function withTeamLabel(text, teamId, label) {
    const id = String(teamId == null ? '' : teamId), t = String(text == null ? '' : text);
    if (!id || !label || id === label) return t;
    return t.split('\n').map((line, i, all) => {
        const heading = line.startsWith('# ') && all.slice(0, i).every(l => !l.startsWith('# ')) && line.includes(id);
        const title = /^title:\s/.test(line) && line.slice(line.indexOf(':') + 1).trim() === id;
        if (heading) return line.split(id).join(label);
        if (title) return line.replace(id, label);
        return line;
    }).join('\n');
}

/** The file name the distillation gives an agent's notes: the name lower-cased, spaces as hyphens, and only a-z, 0-9, - and _ kept (internal/background/knowledge.go slugify). */
export function slugOf(name) {
    return String(name == null ? '' : name).toLowerCase().replace(/ /g, '-').replace(/[^a-z0-9_-]/g, '');
}

/** The entry a relative link in an entry's Markdown (./orchestrator.md, ../orchestrator.md) names, or null: only a plain file name of an entry the team has. A Windows device name's slug carries a trailing "_" (con_). */
export function entryForLink(url, entries) {
    const m = /^\.{1,2}\/([^/\\\s?#]+)\.md$/i.exec(String(url));
    if (!m) return null;
    const stem = m[1].toLowerCase();
    if (stem === 'index') return (entries || []).find(e => e.key === 'index') || null;
    return (entries || []).find(e => e.key !== 'index' && (slugOf(e.name) === stem || `${slugOf(e.name)}_` === stem)) || null;
}
