/* Which words of a task's result are a file in its worker's folder (#18200): pure, so a test reads it without a page. */
// A path as a person writes one in a result: an optional folder part and a file name with a common text or code extension. Not .env or the like: those never get a link.
const EXT = 'md|txt|html|htm|css|js|mjs|cjs|ts|tsx|jsx|json|go|py|rb|rs|sh|yml|yaml|toml|csv|xml|sql|c|h|cpp|java|swift|kt|php|log|ini|cfg|svg';
const PATH_RE = new RegExp(`(^|[\\s(\`'"])((?:/|\\./)?(?:[\\w.-]+/)*[\\w-][\\w.-]*\\.(?:${EXT}))(?=\\.?(?:$|[\\s)\`'",;:!?]))`, 'gi');

/** The path under the agent's folder, or '' when it is not one: an absolute path must start with the folder, nothing may climb out of it, and nothing starts with a dash. */
export function relPath(token, workdir) {
    let p = String(token || '');
    if (p.startsWith('/')) {
        const w = String(workdir || '').replace(/\/+$/, '');
        if (!w || !p.startsWith(w + '/')) return '';
        p = p.slice(w.length + 1);
    }
    if (p.startsWith('./')) p = p.slice(2);
    if (!p || p.startsWith('-') || p.split('/').some(s => s === '' || s === '.' || s === '..')) return '';
    return p;
}

/** The pieces of `text`: [{ text }] and [{ text, rel }] for each path under `workdir`. */
export function split(text, workdir) {
    const out = []; let at = 0, m; PATH_RE.lastIndex = 0;
    while ((m = PATH_RE.exec(text))) {
        const rel = relPath(m[2], workdir), start = m.index + m[1].length;
        if (!rel) continue;
        if (start > at) out.push({ text: text.slice(at, start) });
        out.push({ text: m[2], rel }); at = start + m[2].length;
    }
    if (at < text.length) out.push({ text: text.slice(at) });
    return out;
}
