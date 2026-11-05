/* Comments on an agent's diff (#12536, the Operator: "let me comment in the files diff view too, similar to how we handle the artifacts review"). The artifact comments' panel, pointed at one changed file of one live
 * agent: nothing here draws a thread. attachComments (artifact_comments.js) does, with the same composer, pictures with Mark up, Resolve and Reopen and the same agent-reply thread. The subject is a key
 * diff:<team>:<session>:<16 hex of sha256(path)> in the place of a digest (the server checks the file is in the agent's changed list and the session is a live one of that team), the anchor is the lines selected in
 * the diff (path, side, line range, the lines with a little context, the compare it was made on), and a comment whose lines are no longer in the diff is tagged "outdated", kept, and not sent again. Only on the
 * computer itself: through Coral Hub the person's own source code is not reached by these routes. */
import { importOnce } from './import_once.js';
import { loadStyles } from './lazy_styles.js';
import { contextServer, isCloud } from './server_base.js';
import { state } from './state.js';
import { el } from './dom_el.js';
const { attachComments } = await importOnce('./artifact_comments.js');
await loadStyles('diff-comments.css');

const MAX_QUOTE = 8192, MAX_LINES = 200, CONTEXT_LINES = 3, MAX_CONTEXT = 600;

/** The thread key of the file at `path` of the session `sid` on `team`: what the comments routes take where a document has its digest. */
export async function diffSubject(team, sid, path) {
    const sum = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path));
    return `diff:${team}:${sid}:${[...new Uint8Array(sum).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The state fields of the merge view's extension, found once when the diff is drawn: one of them holds the view's own chunks ({ fromA, toA, fromB, toB }, offsets in the old and the new text), which is where the removed lines' numbers are read. */
export function mergeFields(ext) {
    const out = [];
    const walk = e => { if (Array.isArray(e)) e.forEach(walk); else if (e && typeof e === 'object' && typeof e.createF === 'function') out.push(e); };
    walk(ext);
    return out;
}

/** The chunks the merge view holds now, or null when they cannot be read. */
const chunksOf = (view, fields) => {
    for (const f of fields || []) {
        let v;
        try { v = view.state.field(f, false); } catch { continue; }
        if (Array.isArray(v) && (!v.length || ('fromA' in v[0] && 'fromB' in v[0]))) return v;
    }
    return null;
};

/** The old-side line numbers of the removed rows from..to (indexes into the block) of one removed block: the block sits in the new text where its chunk begins, and the chunk says where it began in the old text, so the numbers are the view's own and nothing is searched for or guessed (a "}" that repeats is named where it was removed). null when the view's chunks cannot be read. */
function oldLines(block, from, to, view, texts, fields) {
    const chunks = chunksOf(view, fields);
    if (!chunks) return null;
    let pos;
    try { pos = view.posAtDOM(block, 0); } catch { return null; }
    const c = chunks.find(k => k.fromB === pos && k.toA > k.fromA) || chunks.find(k => k.fromB <= pos && pos <= k.toB && k.toA > k.fromA);
    if (!c) return null;
    const at = texts.original.slice(0, c.fromA).split('\n').length; // the old line the chunk begins on
    return { start: at + from, end: at + to, lines: texts.original.split('\n') };
}

const lineCount = t => (t ? t.split('\n').length : 0);
const clip = (t, n) => (t.length > n ? t.slice(t.length - n) : t);
const headClip = (t, n) => (t.length > n ? t.slice(0, n) : t);

/** The anchor of the text selected in this file's diff, or null when nothing in it is selected. side is new for lines of the file as it is now and old for lines the diff shows as removed; the line numbers are the file's own on that side. */
export function selectionAnchor(slot, view, texts, file, base, fields) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    const end = sel.focusNode && (sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement);
    if (!node || !end || !slot.contains(node) || !slot.contains(end)) return null;
    const text = sel.toString();
    if (!text.trim()) return null;
    const chunkA = node.closest('.cm-deletedChunk'), chunkB = end.closest('.cm-deletedChunk');
    if (chunkA !== chunkB) return { tooLong: true, why: 'Select lines on one side' }; // removed and kept lines in one selection have no one set of numbers
    const old = !!chunkA;
    let startLine, endLine, before, after;
    if (old) {
        const rows = [...chunkA.querySelectorAll('.cm-deletedLine')], at = el => Math.max(0, rows.indexOf(el.closest('.cm-deletedLine')));
        const x = at(node), y = at(end), got = oldLines(chunkA, Math.min(x, y), Math.max(x, y), view, texts, fields);
        if (!got) return null;
        startLine = got.start; endLine = got.end;
        before = got.lines.slice(Math.max(0, startLine - 1 - CONTEXT_LINES), startLine - 1).join('\n'); after = got.lines.slice(endLine, endLine + CONTEXT_LINES).join('\n');
    } else {
        let a, b;
        try { a = view.posAtDOM(sel.anchorNode, sel.anchorOffset); b = view.posAtDOM(sel.focusNode, sel.focusOffset); } catch { return null; }
        const doc = view.state.doc, from = Math.min(a, b), to = Math.max(a, b);
        if (to <= from) return null;
        startLine = doc.lineAt(from).number; endLine = doc.lineAt(Math.max(from, to - 1)).number;
        before = doc.sliceString(doc.line(Math.max(1, startLine - CONTEXT_LINES)).from, doc.line(startLine).from).replace(/\n$/, '');
        after = endLine < doc.lines ? doc.sliceString(doc.line(endLine + 1).from, doc.line(Math.min(doc.lines, endLine + CONTEXT_LINES)).to) : '';
    }
    if (text.length > MAX_QUOTE || lineCount(text) > MAX_LINES) return { tooLong: true };
    return { path: file.filepath, side: old ? 'old' : 'new', start_line: Math.max(1, startLine), end_line: Math.max(1, endLine, startLine), quote: text, prefix: clip(before, MAX_CONTEXT), suffix: headClip(after, MAX_CONTEXT), base };
}

/** The comment on the file's changes as a whole: the file's own lines, with no quote. */
const fileAnchor = (texts, file, base) => ({ path: file.filepath, side: 'new', start_line: 1, end_line: Math.max(1, lineCount(texts.content)), quote: '', base });

/** Is a comment's anchor still in the diff? A comment with no quote (the file as a whole) always is. */
export const stillThere = (a, texts) => !a || !a.quote || (a.side === 'old' ? texts.original : texts.content).includes(a.quote);

const mounted = new WeakMap(); // slot -> its handle
let boxSeq = 0;

/** The file's row, the block above its diff slot, or null. */
const rowOf = slot => { const r = slot.previousElementSibling; return r && r.classList.contains('file-item') ? r : null; };
/** Put a file's comment icon back in its row (a list that was drawn again keeps the diff slot but brings a new row). */
export function placeDiffCommentIcon(slot) { mounted.get(slot)?.place(); }

/** Put the comments of `file` under its diff in `slot`. view is the editor of the diff, texts its two texts. Does nothing through Coral Hub or when the agent has no team. */
export async function attachDiffComments(slot, file, view, texts, base = '', fields = []) {
    const drawing = slot.dataset.drawing;
    const current = () => !!drawing && slot.dataset.drawing === drawing && !slot.hidden && slot.contains(view.dom);
    if (!current()) return; // the lazy import may have finished after this editor closed
    const s = state.currentSession, team = s && s.board_project, sid = s && s.session_id;
    if (!s || s.type !== 'live' || !sid) return;
    if (isCloud() || !team) { // a line that says why there is no Comment button (#12570): comments go to an agent on a team's board, on the computer itself
        if (!slot.querySelector('.diff-comments-note')) slot.append(el('p', 'diff-comments-note', isCloud() ? 'Comments on a diff are made on the computer itself.' : 'Comments need a team: this agent is not on one, so there is no board to send a comment to.'));
        return;
    }
    mounted.get(slot)?.destroy();
    const key = await diffSubject(team, sid, file.filepath);
    if (!current()) return; // the digest must not attach a thread to a closed or replacement diff
    const box = el('div', 'diff-comments'), body = el('div', 'diff-comments-body'), btn = el('button', 'btn btn-small diff-comment-btn', 'Comment');
    body.hidden = true; btn.type = 'button'; btn.hidden = true; btn.setAttribute('aria-label', `Comment on the selected lines of ${file.filepath}`);
    box.id = `diff-comments-${++boxSeq}`; box.hidden = true; // the thread is drawn when the person asks: one small icon in the file's row (#13528)
    box.append(body); slot.prepend(box); slot.append(btn); // the thread is right under the row, not at the end of a long diff
    // The icon: a comment bubble in the file's row. Pressing it opens the thread with the composer for the file; pressing it again hides them (a draft stays). The count of open comments is on it, so a file with a thread says so before it is opened.
    const name = file.filepath.split('/').pop() || file.filepath;
    const icon = el('button', 'btn btn-quiet btn-icon btn-xs file-comment-btn'), glyph = el('span', 'material-icons', 'chat_bubble_outline'), badge = el('span', 'file-comment-count');
    icon.type = 'button'; icon.setAttribute('aria-controls', box.id); glyph.setAttribute('aria-hidden', 'true'); badge.hidden = true; icon.append(glyph, badge);
    let count = 0, opened = false;
    const paint = () => {
        const label = count ? `Comment on ${name}, ${count} comment${count === 1 ? '' : 's'}` : `Comment on ${name}`;
        icon.setAttribute('aria-label', label); icon.title = label; icon.setAttribute('aria-expanded', String(opened));
        badge.textContent = count > 99 ? '99+' : String(count); badge.hidden = !count;
    };
    const show = on => { opened = on; box.hidden = !on; paint(); };
    const placeIcon = () => { const row = rowOf(slot); if (!row || row.contains(icon)) return; const acts = row.querySelector('.file-action-btns'); if (acts) acts.before(icon); else row.append(icon); };
    const comments = attachComments(box, body, box, { toggleHost: true, compact: true, sheet: () => false, shown: () => true, words: { quote: '' }, wholeAnchor: () => fileAnchor(texts, file, base), outdated: c => !stillThere(c.anchor, texts),
        onState: now => { count = now.count; if (opened && !now.composing && !now.count) { opened = false; box.hidden = true; } paint(); } }); // a cancelled composer on a file with no comments leaves nothing open
    comments.open(key, contextServer(), team);
    comments.docWhole();
    comments.setSheet(true);
    let anchor = null;
    const place = () => {
        const a = selectionAnchor(slot, view, texts, file, base, fields);
        anchor = a && !a.tooLong ? a : null;
        btn.hidden = !a;
        if (!a) return;
        btn.textContent = a.tooLong ? (a.why || 'Too many lines') : 'Comment'; btn.disabled = !!a.tooLong; // a selection over the cap says so, and offers nothing
        const r = window.getSelection().getRangeAt(0).getBoundingClientRect(), at = slot.getBoundingClientRect();
        btn.style.top = `${Math.max(0, r.bottom - at.top + 4)}px`; btn.style.left = `${Math.min(Math.max(0, r.left - at.left), Math.max(0, at.width - 96))}px`;
    };
    let timer = 0;
    const soon = () => { clearTimeout(timer); timer = setTimeout(place, 60); };
    slot.addEventListener('mouseup', soon); slot.addEventListener('keyup', soon); slot.addEventListener('touchend', soon);
    btn.addEventListener('mousedown', e => e.preventDefault()); // pressing it must not clear the selection it is about
    btn.addEventListener('click', () => { if (!anchor) return; show(true); comments.composeOn(anchor); btn.hidden = true; window.getSelection().removeAllRanges(); });
    icon.addEventListener('click', e => {
        e.stopPropagation(); // the row opens the file when it is pressed: this button is not that
        if (opened) { show(false); return; }
        show(true);
        if (!comments.isComposing()) comments.composeOn(fileAnchor(texts, file, base)); // false when this person cannot comment (locked): the thread opens and says why
        else box.querySelector('.ac-input')?.focus();
    });
    paint(); placeIcon();
    const handle = { place: placeIcon, destroy() { clearTimeout(timer); slot.removeEventListener('mouseup', soon); slot.removeEventListener('keyup', soon); slot.removeEventListener('touchend', soon); comments.close(); box.remove(); btn.remove(); icon.remove(); mounted.delete(slot); } };
    mounted.set(slot, handle);
}

/** Take the comments off a slot (its diff was closed). */
export function detachDiffComments(slot) { mounted.get(slot)?.destroy(); }
