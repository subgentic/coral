// Prototype only. Keep original source bytes; the lexer is used for positions, never serialization.
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
export const MAX_BYTES = 2 * 1024 * 1024;
export function normalizeSource(source) {
    let text = ''; const offsets = []; let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;
    while (i < source.length) { offsets.push(i); if (source[i] === '\r') { text += '\n'; i += source[i + 1] === '\n' ? 2 : 1; } else text += source[i++]; }
    offsets.push(source.length); return { text, offsets };
}
function inlineRuns(tokens, raw, base, out) {
    let cursor = 0;
    for (const token of tokens || []) {
        const at = raw.indexOf(token.raw, cursor); if (at < 0) return false;
        cursor = at + token.raw.length;
        if (token.type === 'image' || token.type === 'br') continue;
        if (token.tokens) { if (!inlineRuns(token.tokens, token.raw, base + at, out)) return false; continue; }
        if (token.type === 'codespan') {
            const m = /^(\x60+)([\s\S]*?)\1$/.exec(token.raw);
            if (!m) return false;
            out.push({ text: token.text, start: base + at + m[1].length, end: base + at + token.raw.length - m[1].length, editable: m[2] === token.text, kind: 'code' });
        } else {
            const text = token.type === 'html' ? token.raw : token.text;
            if (typeof text !== 'string') return false;
            out.push({ text, start: base + at, end: base + at + token.raw.length, editable: token.type === 'text' && token.raw === text, kind: 'text' });
        }
    }
    return true;
}
function listRuns(token, base, runs, units) {
    let cursor = 0;
    for (const item of token.items) {
        const at = token.raw.indexOf(item.raw, cursor); if (at < 0) return false;
        cursor = at + item.raw.length;
        // Nested/multiline lists need an indentation-aware source map; leave the block alone for now.
        if (item.tokens.some(t => !['text', 'paragraph'].includes(t.type))) return false;
        const first = runs.length;
        if (!inlineRuns(item.tokens, item.raw, base + at, runs)) return false;
        units.push({ start: base + at, end: base + at + item.raw.length, first, count: runs.length - first });
    }
    return true;
}
export function analyze(source, marked) {
    if (new TextEncoder().encode(source).length > MAX_BYTES) throw new Error('This prototype opens Markdown up to 2 MiB.');
    const { text, offsets } = normalizeSource(source); const blocks = []; let offset = 0;
    const front = /^---\n[\s\S]*?\n(?:---|\.\.\.)(?:\n|$)/.exec(text);
    const add = (raw, start, type, tokens = null) => {
        const countItems = t => (t.items || []).reduce((n, item) => n + 1 + (item.tokens || []).filter(x => x.type === 'list').reduce((sum, x) => sum + countItems(x), 0), 0);
        const block = { unitCount: ['paragraph', 'heading'].includes(type) ? 1 : type === 'list' ? countItems(tokens) : 0, type, raw, start: offsets[start], end: offsets[start + raw.length], runs: [], units: [], reason: '' };
        if (HIDDEN.test(raw)) block.reason = 'Hidden or bidirectional characters';
        else if (type === 'paragraph' || type === 'heading') {
            if (!inlineRuns(tokens.tokens, raw, start, block.runs)) block.reason = 'Text does not map exactly';
            block.units.push({ start, end: start + raw.length, first: 0, count: block.runs.length });
        } else if (type === 'list') { if (!listRuns(tokens, start, block.runs, block.units)) block.reason = 'Nested or indented list'; }
        else block.reason = ({ table: 'Table', code: 'Code block', html: 'Raw HTML', frontmatter: 'Front matter', definition: 'Reference definition', blockquote: 'Quoted block', hr: 'Divider' })[type] || 'Unsupported block';
        if (block.reason) block.runs = [];
        block.runs = block.runs.map(run => ({ ...run, start: offsets[run.start], end: offsets[run.end] }));
        blocks.push(block);
    };
    if (front) { add(front[0], 0, 'frontmatter'); offset = front[0].length; }
    const tokens = marked.lexer(text.slice(offset), { gfm: true }); let cursor = offset;
    for (const token of tokens) {
        const at = text.indexOf(token.raw, cursor); if (at < 0) throw new Error('Lexer source positions could not be verified.');
        if (at > cursor) add(text.slice(cursor, at), cursor, 'definition');
        if (token.type !== 'space') add(token.raw, at, token.type, token);
        cursor = at + token.raw.length;
    }
    if (cursor < text.length && text.slice(cursor).trim()) add(text.slice(cursor), cursor, 'definition');
    // Definitions only affect rendering context; source is never rebuilt from this context.
    const references = Object.entries(tokens.links || {}).map(([key, link]) => `[${key}]: <${String(link.href).replace(/>/g, '%3E')}>${link.title ? ' '+ JSON.stringify(link.title) : ''}`).join('\n');
    return { source, blocks, references, bom: source.charCodeAt(0) === 0xfeff };
}
export function mapRenderedBlock(block, element) {
    const nodes = []; const walker = document.createTreeWalker(element, 4);
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement.closest('p,h1,h2,h3,h4,h5,h6,li') && !node.parentElement.closest('pre')) nodes.push(node);
    }
    // No search/guess through repeated prose: every visible node must align, in order.
    if (nodes.length !== block.runs.length || nodes.some((n, i) => n.data !== block.runs[i].text)) return { exact: false, entries: [] };
    return { exact: true, entries: nodes.map((node, i) => ({ node, run: block.runs[i] })) };
}
const escapeInserted = s => s.replace(/[\\\x60*_[\]<>~!|#()+.\-]/g, '\\$&');
export function editRun(source, run, text) {
    const original = normalizeSource(source.slice(run.start, run.end));
    if (!run.editable || original.text !== run.text) throw new Error('This text run cannot be edited exactly.');
    if (HIDDEN.test(text)) throw new Error('Hidden and bidirectional characters are read-only in this prototype.');
    // Work in Unicode code points so an emoji is never split between surrogate halves.
    const before = Array.from(run.text), after = Array.from(text); let a = 0, b = 0;
    while (a < before.length && a < after.length && before[a] === after[a]) a++;
    while (b < before.length - a && b < after.length - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++;
    const removed = before.slice(a, before.length - b).join(''), inserted = after.slice(a, after.length - b).join('');
    if (/[\r\n]/.test(removed + inserted)) throw new Error('Edit words within one text run; changing line breaks is not supported.');
    if (run.kind === 'code' && /\x60/.test(inserted)) throw new Error('A code-span delimiter cannot be edited.');
    const start = run.start + original.offsets[before.slice(0, a).join('').length], end = run.start + original.offsets[run.text.length - before.slice(before.length - b).join('').length];
    const replacement = run.kind === 'code' ? inserted : escapeInserted(inserted);
    return { source: source.slice(0, start) + replacement + source.slice(end), patch: { start, end, removed: source.slice(start, end), inserted: replacement } };
}
export function bytePatch(before, after) {
    const a = new TextEncoder().encode(before), b = new TextEncoder().encode(after); let prefix = 0, suffix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
    return { offset: prefix, removedBytes: a.length - prefix - suffix, insertedBytes: b.length - prefix - suffix, unchangedPrefixBytes: prefix, unchangedSuffixBytes: suffix };
}
