import { DOMPURIFY_CONFIG, sanitizeHtml, keepFragmentsInside } from './utils.js';

/* A Markdown file's front matter (a skill's name, description, metadata) as a small key/value header (#16651). Loaded only for a text that starts with a --- line. */

/** { facts: [[key, value]], rest }: the leading `---` block of `key: value` lines split from the Markdown after it. Indented lines continue the key above; an unclosed block (40 lines) or one with no key is not front matter. */
export function splitMarkdownFrontMatter(text) {
    const s = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    const lines = s.split(/\r?\n/);
    if (lines[0].trim() !== '---') return { facts: [], rest: s };
    let end = -1;
    for (let i = 1; i < lines.length && i <= 40; i++) if (lines[i].trim() === '---') { end = i; break; }
    if (end < 0) return { facts: [], rest: s };
    const facts = [];
    for (const line of lines.slice(1, end)) {
        const m = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line);
        if (m) facts.push([m[1], m[2].trim().replace(/^(["'])(.*)\1$/, '$2')]);
        else if (facts.length && line.trim()) { const last = facts[facts.length - 1]; last[1] = `${last[1]} ${line.trim()}`.trim(); }
    }
    if (!facts.length) return { facts: [], rest: s };
    return { facts, rest: lines.slice(end + 1).join('\n').replace(/^\s*\n/, '') };
}

/** Redraws a rendered Markdown preview (a text with front matter) without it, under a key/value header; anything else is left as drawn. Values are text, never markup. */
export function show(body, content) {
    const { facts, rest } = splitMarkdownFrontMatter(content), prose = body.firstElementChild;
    if (!facts.length || !prose || !body.isConnected) return false;
    prose.innerHTML = sanitizeHtml(marked.parse(rest), DOMPURIFY_CONFIG, { links: 'file', headings: 2 });
    const dl = document.createElement('dl'); dl.className = 'preview-front-matter';
    for (const [k, v] of facts) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); }
    prose.prepend(dl);
    keepFragmentsInside(body);
    return true;
}
