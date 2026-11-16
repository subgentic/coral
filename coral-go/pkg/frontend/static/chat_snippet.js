// Search snippets are text, with Markdown formatting removed and the query marked.
// Reuse the safe DOM renderer, then copy only text into the list: no links or HTML.
import { loadSafeMarkdown } from './vendor_loader.js';
import { renderSafe } from './safe_markdown.js';
export const prepareSnippets = () => loadSafeMarkdown().catch(() => {});
const cache = new Map();
export function snippetText(raw) {
    const source = String(raw || '');
    if (cache.has(source)) return cache.get(source);
    if (!source) return '';
    const rendered = renderSafe(source), root = rendered.node;
    for (const block of root.querySelectorAll('p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,br')) block.append(document.createTextNode(' '));
    const text = root.textContent.replace(/\s+/g, ' ').trim();
    if (cache.size >= 200) cache.clear();
    if (!rendered.partial) cache.set(source, text);
    return text;
}
export function markSnippet(host, text, query) {
    host.replaceChildren();
    const q = String(query || '').trim();
    if (!q) { host.textContent = text; return; }
    const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
        host.append(document.createTextNode(text.slice(cursor, match.index)));
        const mark = document.createElement('mark'); mark.textContent = match[0]; host.append(mark);
        cursor = match.index + match[0].length;
    }
    host.append(document.createTextNode(text.slice(cursor)));
}
