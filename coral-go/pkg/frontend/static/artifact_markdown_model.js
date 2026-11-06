// Rendered text editing. Keep original source bytes; the lexer is used for positions, never serialization.
export const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
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
    if (new TextEncoder().encode(source).length > MAX_BYTES) throw new Error('Markdown editing is limited to 2 MiB.');
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
    const lexer = new marked.Lexer({ gfm: true }), tokens = lexer.lex(text.slice(offset)); let cursor = offset;
    for (const token of tokens) {
        if (token.type === 'space') continue;
        // Marked omits reference definitions from its token array. Consume their exact
        // raw ranges before searching: a URL may repeat the next paragraph's words.
        for (;;) {
            const remaining = text.slice(cursor), blank = /^(?:[ \t]*\n)*/.exec(remaining)[0];
            const definition = lexer.tokenizer.def(remaining.slice(blank.length));
            if (!definition) break;
            const raw = blank + definition.raw; add(raw, cursor, 'definition'); cursor += raw.length;
        }
        const at = text.indexOf(token.raw, cursor);
        if (at < 0 || text.slice(cursor, at).trim()) throw new Error('Lexer source positions could not be verified; this document stays read-only.');
        add(token.raw, at, token.type, token); cursor = at + token.raw.length;
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
    if (!run.editable || original.text !== run.text) throw new Error('This text cannot be changed without affecting its Markdown.');
    if (HIDDEN.test(text)) throw new Error('Hidden and bidirectional characters cannot be inserted here.');
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

/** Visible names for invisible characters; the source itself is never changed. */
export function visibleSpecials(text) {
    return String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, c => `⟦U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`);
}

/** Reapply only whole edited blocks whose original bytes have one unambiguous match
 * in the newest source. Construct from newest bytes; never serialize or replace a
 * block the agent changed. Ambiguous blocks are left for the person to redo. */
export function reapplyEdits(base, draft, newest, marked) {
    const before = analyze(base, marked).blocks, after = analyze(draft, marked).blocks, current = analyze(newest, marked).blocks;
    if (before.length !== after.length) return { ok: false };
    const counts = new Map(), locations = new Map(), edits = []; let left = 0, right = 0;
    for (const b of before) { const raw = base.slice(b.start, b.end); counts.set(raw, (counts.get(raw) || 0) + 1); }
    for (const b of current) { const raw = newest.slice(b.start, b.end), list = locations.get(raw) || []; list.push(b); locations.set(raw, list); }
    for (let i = 0; i < before.length; i++) {
        const b = before[i], d = after[i];
        if (b.type !== d.type || base.slice(left, b.start) !== draft.slice(right, d.start)) return { ok: false };
        const raw = base.slice(b.start, b.end), changed = draft.slice(d.start, d.end);
        if (raw !== changed) {
            const matches = locations.get(raw) || [];
            if (b.reason || d.reason || counts.get(raw) !== 1 || matches.length !== 1 || matches[0].type !== b.type) return { ok: false };
            edits.push({ start: matches[0].start, end: matches[0].end, text: changed });
        }
        left = b.end; right = d.end;
    }
    if (base.slice(left) !== draft.slice(right)) return { ok: false };
    let source = newest;
    for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    return { ok: true, source, changed: edits.length > 0 };
}
