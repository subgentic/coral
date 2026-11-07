// The comment composer: the form that writes a new comment, a reply or an edit (split out of attachComments, #8379).
import { importOnce } from './import_once.js';
import { el } from './dom_el.js';
const api = await importOnce('./artifact_comments_api.js');
const imgs = await importOnce('./artifact_comment_images.js'); // pictures in a comment (#11651)

const BODY_MAX = 8192; // the server's cap on a comment (bytes; most text is one byte a character)
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
        if (cm.anchor) { const a = cm.anchor; const q = el('blockquote', 'ac-quote', cm.atS != null ? `Video: ${cm.timeLabel || cm.atS + ' seconds'}` : a.whole ? 'The whole document' : a.quote); box.append(q); }
        const ta = el('textarea', 'field ac-input'); ta.rows = 3; ta.maxLength = BODY_MAX; ta.value = cm.draft != null ? cm.draft : (editOf ? editOf.body : ''); // what was typed wins over the saved text once typing started, so a redraw (a reply that arrived) keeps an edit's words (#13299)
        ta.setAttribute('aria-label', editOf ? 'Edit your comment' : cm.parentId != null ? 'Your reply' : 'Your comment'); ta.placeholder = cm.parentId != null ? 'Write a reply…' : 'Add a comment…';
        const count = el('span', 'ac-counter', `${ta.value.length} / ${BODY_MAX}`);
        ta.addEventListener('input', () => { count.textContent = `${ta.value.length} / ${BODY_MAX}`; cm.draft = ta.value; });
        const tray = editOf ? null : (cm.tray || (cm.tray = imgs.createImageTray({ upload: (blob, versionOf) => api.uploadCommentImage(cm.hex || st.hex, st.server, blob, versionOf, st.board) }))); // a new comment or reply can carry pictures; an edit keeps the ones it has
        const cancel = btn('ac-cancel', 'Cancel'); cancel.addEventListener('click', () => { if (tray) tray.destroy(); st.composing = null; st.error = ''; render(); });
        const send = btn('btn-primary ac-send', editOf ? 'Save' : cm.parentId != null ? 'Reply' : 'Comment'); send.type = 'submit';
        const err = el('p', 'ac-error', st.error); err.setAttribute('role', 'alert'); err.hidden = !st.error;
        const row = el('div', 'ac-composer-row'); row.append(count, ...(tray ? [tray.picker()] : []), cancel, send);
        box.append(ta, ...(tray ? [tray.node, tray.hint()] : []), err, row);
        const sendingWords = editOf ? 'Saving…' : cm.parentId != null ? 'Sending reply…' : 'Sending…', idleWords = send.textContent;
        const showSending = on => { send.disabled = on || (tray ? tray.busy() || tray.failed() : false); send.textContent = on ? sendingWords : idleWords; send.setAttribute('aria-busy', String(!!on)); ta.readOnly = !!on; cancel.disabled = !!on; box.classList.toggle('ac-sending', !!on); }; // the words stay in the box while it is answered (#14027)
        if (tray) { tray.attach(box, ta); tray.listen(() => { send.disabled = !!cm.sending || tray.busy() || tray.failed(); }); send.disabled = !!cm.sending || tray.busy() || tray.failed(); } // a picture that changes while the comment is on its way never makes Send ready again (#14027) // Send waits for a picture still going up, and for a failed one to be removed
        if (cm.sending) showSending(true); // a redraw while it is on its way keeps the busy button and the words
        box.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = ta.value.trim(), pictures = tray ? tray.hexes() : [];
            if (!text && !pictures.length) { st.error = 'Write something first.'; err.textContent = st.error; err.hidden = false; return; }
            if (st.busy || cm.sending) return; // a second press while it is on its way sends nothing
            cm.sending = true; cm.draft = ta.value; showSending(true);
            const working = editOf ? 'Saving your comment…' : cm.parentId != null ? 'Sending your reply…' : 'Sending your comment…';
            const failed = e => { cm.sending = false; throw e; }; // a refusal keeps the words and the box, and the error says why
            if (editOf) run(() => api.editComment(ownHex(editOf), st.server, editOf.id, text).catch(failed), 'Comment saved', working);
            else run(async () => { try { const c = await api.createComment(cm.hex || st.hex, st.server, { body: text, anchor: cm.anchor, parentId: cm.parentId, board: st.board, images: pictures, atS: cm.atS, endS: cm.endS }); if (tray) tray.destroy(); st.active = c.id; st.scrollCard = true; return c.sentTo; } catch (e) { failed(e); } }, cm.parentId != null ? 'Reply posted' : 'Comment posted', working);
        });
        ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel.click(); } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) box.requestSubmit(); });
        return box;
    }
    return { composer, editing };
}
