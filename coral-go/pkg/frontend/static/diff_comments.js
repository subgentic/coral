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

const lineCount = t => (t ? t.split('\n').length : 0);
const clip = (t, n) => (t.length > n ? t.slice(t.length - n) : t);
const headClip = (t, n) => (t.length > n ? t.slice(0, n) : t);

/** The anchor of the text selected in this file's diff, or null when nothing in it is selected. side is new for lines of the file as it is now and old for lines the diff shows as removed; the line numbers are the file's own on that side. */
export function selectionAnchor(slot, view, texts, file, base) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    const end = sel.focusNode && (sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement);
    if (!node || !end || !slot.contains(node) || !slot.contains(end)) return null;
    const text = sel.toString();
    if (!text.trim()) return null;
    const old = !!node.closest('.cm-deletedChunk') || !!end.closest('.cm-deletedChunk');
    let startLine, endLine, before, after;
    if (old) {
        const at = texts.original.indexOf(text);
        if (at < 0) return null;
        startLine = lineCount(texts.original.slice(0, at)); endLine = startLine + lineCount(text) - 1;
        const lines = texts.original.split('\n');
        before = lines.slice(Math.max(0, startLine - 1 - CONTEXT_LINES), startLine - 1).join('\n'); after = lines.slice(endLine, endLine + CONTEXT_LINES).join('\n');
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

const mounted = new WeakMap(); // slot -> its box

/** Put the comments of `file` under its diff in `slot`. view is the editor of the diff, texts its two texts. Does nothing through Coral Hub or when the agent has no team. */
export async function attachDiffComments(slot, file, view, texts, base = '') {
    const s = state.currentSession, team = s && s.board_project, sid = s && s.session_id;
    if (isCloud() || !team || !sid || !s || s.type !== 'live') return;
    mounted.get(slot)?.destroy();
    const key = await diffSubject(team, sid, file.filepath);
    const box = el('div', 'diff-comments'), body = el('div', 'diff-comments-body'), btn = el('button', 'btn btn-small diff-comment-btn', 'Comment');
    body.hidden = true; btn.type = 'button'; btn.hidden = true; btn.setAttribute('aria-label', `Comment on the selected lines of ${file.filepath}`);
    box.append(body); slot.append(box, btn);
    const words = { empty: 'No comments on this file yet. Select lines in the diff and press Comment: your comment goes to the agent, who answers here.', whole: 'Comment on this file’s changes', quote: '' };
    const comments = attachComments(box, body, box, { toggleHost: true, sheet: () => false, shown: () => true, words, wholeAnchor: () => fileAnchor(texts, file, base), outdated: c => !stillThere(c.anchor, texts) });
    comments.open(key, contextServer(), team);
    comments.docWhole();
    comments.setSheet(true);
    let anchor = null;
    const place = () => {
        const a = selectionAnchor(slot, view, texts, file, base);
        anchor = a && !a.tooLong ? a : null;
        btn.hidden = !a;
        if (!a) return;
        btn.textContent = a.tooLong ? 'Too many lines' : 'Comment'; btn.disabled = !!a.tooLong; // a selection over the cap says so, and offers nothing
        const r = window.getSelection().getRangeAt(0).getBoundingClientRect(), at = slot.getBoundingClientRect();
        btn.style.top = `${Math.max(0, r.bottom - at.top + 4)}px`; btn.style.left = `${Math.min(Math.max(0, r.left - at.left), Math.max(0, at.width - 96))}px`;
    };
    let timer = 0;
    const soon = () => { clearTimeout(timer); timer = setTimeout(place, 60); };
    slot.addEventListener('mouseup', soon); slot.addEventListener('keyup', soon); slot.addEventListener('touchend', soon);
    btn.addEventListener('mousedown', e => e.preventDefault()); // pressing it must not clear the selection it is about
    btn.addEventListener('click', () => { if (!anchor) return; comments.composeOn(anchor); btn.hidden = true; window.getSelection().removeAllRanges(); });
    const handle = { destroy() { clearTimeout(timer); slot.removeEventListener('mouseup', soon); slot.removeEventListener('keyup', soon); slot.removeEventListener('touchend', soon); comments.close(); box.remove(); btn.remove(); mounted.delete(slot); } };
    mounted.set(slot, handle);
}

/** Take the comments off a slot (its diff was closed). */
export function detachDiffComments(slot) { mounted.get(slot)?.destroy(); }
