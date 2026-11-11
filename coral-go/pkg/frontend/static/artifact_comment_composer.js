// The comment composer: the form that writes a new comment, a reply or an edit (split out of attachComments, #8379).
import { importOnce } from './import_once.js';
import { el } from './dom_el.js';
import { showToast } from './utils.js';
let hintSeq = 0;
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
        const sends = /Mac/.test(navigator.platform) ? '⌘ Return' : 'Ctrl+Enter', words = () => `${ta.value.length} / ${BODY_MAX}${matchMedia('(pointer: coarse)').matches ? '' : ` · ${sends} sends`}`; // Enter adds a line: the shortcut is said beside the count (#15119)
        const count = el('span', 'ac-counter', words());
        ta.addEventListener('input', () => { count.textContent = words(); cm.draft = ta.value; });
        const tray = editOf ? null : (cm.tray || (cm.tray = imgs.createImageTray({ upload: (blob, versionOf) => api.uploadCommentImage(cm.hex || st.hex, st.server, blob, versionOf, st.board) }))); // a new comment or reply can carry pictures; an edit keeps the ones it has
        const cancel = btn('ac-cancel', 'Cancel'); cancel.addEventListener('click', () => { if (tray) tray.destroy(); st.composing = null; st.error = ''; render(); });
        const send = btn('btn-primary ac-send', editOf ? 'Save' : cm.parentId != null ? 'Reply' : 'Comment'); send.type = 'submit';
        const err = el('p', 'ac-error', st.error); err.setAttribute('role', 'alert'); err.hidden = !st.error;
        const row = el('div', 'ac-composer-row'); row.append(count, ...(tray ? [tray.picker()] : []), cancel, send);
        const hint = editOf ? '' : st.hint?.() || '', hintEl = hint ? el('p', 'ac-note ac-hint', hint) : null; // always drawn with its line; shown while the file waits for review (the review bar toggles it with the file's state, #15128)
        if (hintEl) { hintEl.id = `ac-hint-${++hintSeq}`; const on = !!st.hintOn?.(); hintEl.hidden = !on; if (on) ta.setAttribute('aria-describedby', hintEl.id); } // a screen reader hears it where the person types
        box.append(ta, ...(hintEl ? [hintEl] : []), ...(tray ? [tray.node, tray.hint()] : []), err, row);
        if (tray) { tray.attach(box, ta); tray.listen(() => { send.disabled = tray.busy() || tray.failed(); }); send.disabled = tray.busy() || tray.failed(); } // Send waits for a picture still going up, and for a failed one to be removed
        box.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = ta.value.trim(), pictures = tray ? tray.hexes() : [];
            if (!text && !pictures.length) { st.error = 'Write something first.'; err.textContent = st.error; err.hidden = false; return; }
            send.disabled = true;
            if (editOf) run(() => api.editComment(ownHex(editOf), st.server, editOf.id, text), 'Comment saved');
            else run(async () => { const c = await api.createComment(cm.hex || st.hex, st.server, { body: text, anchor: cm.anchor, parentId: cm.parentId, board: st.board, images: pictures, atS: cm.atS, endS: cm.endS }); if (tray) tray.destroy(); st.active = c.id; st.scrollCard = true; if (c.notDelivered && !c.sentTo) { st.undelivered.set(cm.parentId != null ? cm.parentId : c.id, c.notDelivered); showToast(`Not delivered: ${c.notDelivered}`, true); } else st.undelivered.delete(cm.parentId != null ? cm.parentId : c.id); return c.sentTo; }, cm.parentId != null ? 'Reply posted' : 'Comment posted');
        });
        ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel.click(); } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) box.requestSubmit(); });
        return box;
    }
    return { composer, editing };
}
