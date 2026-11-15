import { loadStyles } from './lazy_styles.js';
import { DOMPURIFY_CONFIG, sanitizeHtml, keepFragmentsInside } from './utils.js';

/* A Markdown file's front matter (a skill's name, description, metadata) as a small key/value header (#16651). A workspace file can be agent-written, so its links follow the file policy as in preview_content.js (#3542). Loaded after a Markdown preview is drawn; it acts only on a text that starts with a --- line. */

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
export async function show(body, content) {
    try {
        const { facts, rest } = splitMarkdownFrontMatter(content), prose = body.firstElementChild;
        if (!facts.length || !prose || !body.isConnected) return false;
        await loadStyles('md_front.css'); // the header's rules load with it, not at start (#16651)
        if (!body.isConnected) return false;
        // The block in view stays where it is: the redraw swaps the run-together front matter for the header, which is another height (#17927). The blocks after the front matter are the same in both renders, so the block is found again by its place from the end.
        const topOf = el => el.getBoundingClientRect().top - body.getBoundingClientRect().top;
        let anchor = null;
        if (body.scrollTop > 0) { const kids = Array.from(prose.children), i = kids.findIndex(k => topOf(k) + k.getBoundingClientRect().height > 1); if (i >= 0) anchor = { fromEnd: kids.length - i, offset: topOf(kids[i]) }; }
        prose.innerHTML = sanitizeHtml(marked.parse(rest), DOMPURIFY_CONFIG, { links: 'file', headings: 2 });
        const dl = document.createElement('dl'); dl.className = 'preview-front-matter';
        for (const [k, v] of facts) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); }
        prose.prepend(dl);
        keepFragmentsInside(body);
        const kid = anchor && prose.children[prose.children.length - anchor.fromEnd];
        if (kid) body.scrollTop += topOf(kid) - anchor.offset;
        return true;
    } catch { return false; } // a header that cannot be drawn leaves the preview as it was
}
