// The comment composer: the form that writes a new comment, a reply or an edit (split out of attachComments, #8379).
import { importOnce } from './import_once.js';
const api = await importOnce('./artifact_comments_api.js');

const BODY_MAX = 8192; // the server's cap on a comment (bytes; most text is one byte a character)
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (cls, text, label) => { const b = el('button', 'btn ' + cls, text); b.type = 'button'; if (label) b.setAttribute('aria-label', label); return b; };

/** The forms of one comments panel: `st` is the panel's state (`st.composing` is what is being written), `run` does a change and redraws, `ownHex` names the version a comment lives on. */
export function createComposer({ st, render, run, ownHex }) {
    // the editor of an existing comment, in place of its text
    function editing(c) {
        if (!st.composing || st.composing.editId !== c.id) return null;
        return composer(c);
    }
    function composer(editOf) {
        const cm = st.composing;
        const box = el('form', 'ac-composer'); box.noValidate = true;
        if (cm.anchor) { const a = cm.anchor; const q = el('blockquote', 'ac-quote', a.whole ? 'The whole document' : a.quote); box.append(q); }
        const ta = el('textarea', 'field ac-input'); ta.rows = 3; ta.maxLength = BODY_MAX; ta.value = editOf ? editOf.body : (cm.draft || '');
        ta.setAttribute('aria-label', editOf ? 'Edit your comment' : cm.parentId != null ? 'Your reply' : 'Your comment'); ta.placeholder = cm.parentId != null ? 'Write a reply…' : 'Add a comment…';
        const count = el('span', 'ac-counter', `${ta.value.length} / ${BODY_MAX}`);
        ta.addEventListener('input', () => { count.textContent = `${ta.value.length} / ${BODY_MAX}`; cm.draft = ta.value; });
        const cancel = btn('ac-cancel', 'Cancel'); cancel.addEventListener('click', () => { st.composing = null; st.error = ''; render(); });
        const send = btn('btn-primary ac-send', editOf ? 'Save' : cm.parentId != null ? 'Reply' : 'Comment'); send.type = 'submit';
        const err = el('p', 'ac-error', st.error); err.setAttribute('role', 'alert'); err.hidden = !st.error;
        const row = el('div', 'ac-composer-row'); row.append(count, cancel, send);
        box.append(ta, err, row);
        box.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = ta.value.trim();
            if (!text) { st.error = 'Write something first.'; err.textContent = st.error; err.hidden = false; return; }
            send.disabled = true;
            if (editOf) run(() => api.editComment(ownHex(editOf), st.server, editOf.id, text), 'Comment saved');
            else run(async () => { const c = await api.createComment(cm.hex || st.hex, st.server, { body: text, anchor: cm.anchor, parentId: cm.parentId, board: st.board }); st.active = c.id; st.scrollCard = true; }, cm.parentId != null ? 'Reply posted' : 'Comment posted');
        });
        ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel.click(); } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) box.requestSubmit(); });
        return box;
    }
    return { composer, editing };
}
