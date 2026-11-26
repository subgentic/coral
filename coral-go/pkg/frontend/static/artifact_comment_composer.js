// The comment composer: the form that writes a new comment, a reply or an edit (split out of attachComments, #8379).
import { importOnce } from './import_once.js';
import { el } from './dom_el.js';
import { showToast } from './utils.js';
import { loadStyles } from './lazy_styles.js';
await loadStyles('artifact_comment_composer.css');
let hintSeq = 0;
const api = await importOnce('./artifact_comments_api.js');
const { createFieldPictures, savedWords } = await importOnce('./field_pictures.js');
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
    function composer(editOf, automatic) {
        const review = st.reviewDrafts?.snapshot().data?.drafts_supported ? st.reviewDrafts : null;
        const cm = automatic || st.composing;
        const box = el('form', 'ac-composer'); box.noValidate = true; if (automatic) box.dataset.idleWhole = '';
        if (review && cm.anchor?.whole) box.append(el('h4', 'ac-whole-label', 'Whole-document comment'));
        else if (cm.anchor) { const a = cm.anchor; const q = el('blockquote', 'ac-quote', cm.atS != null ? `Video: ${cm.timeLabel || cm.atS + ' seconds'}` : a.whole ? 'The whole document' : a.quote); box.append(q); }
        const ta = el('textarea', 'field ac-input'); ta.rows = 3; ta.maxLength = BODY_MAX; ta.value = cm.draft != null ? cm.draft : (editOf ? editOf.body : ''); // what was typed wins over the saved text once typing started, so a redraw (a reply that arrived) keeps an edit's words (#13299)
        ta.setAttribute('aria-label', editOf ? 'Edit your comment' : cm.parentId != null ? 'Your reply' : 'Your comment'); ta.placeholder = cm.parentId != null ? 'Write a reply…' : 'Add a comment…';
        const sends = /Mac/.test(navigator.platform) ? '⌘ Return' : 'Ctrl+Enter', words = () => `${ta.value.length} / ${BODY_MAX}`; // the count is only the count: the shortcut is said once, in the line under the box (#16399; it was said twice, in two spellings)
        const count = el('span', 'ac-counter', words());
        ta.addEventListener('input', () => { count.textContent = words(); cm.draft = ta.value; if (automatic) { st.composing = ta.value.trim() ? cm : null; if (st.composing) delete box.dataset.idleWhole; else box.dataset.idleWhole = ''; } for (const b of box.closest('.artifact-viewer-content')?.querySelectorAll('.ac-draft-bar button, .ac-draft-card button') || []) b.disabled = !!st.composing; });
        const target = editOf ? (cm.pictureTarget || (cm.pictureTarget = { hex: ownHex(editOf), server: st.server, board: st.board })) : null;
        const tray = editOf ? (cm.tray || (cm.tray = createFieldPictures({ server: target.server, field: 'body', initial: editOf.images || [], hintWhenAdded: true, includeDraft: false, uploadPicture: (blob, versionOf) => api.uploadCommentImage(target.hex, target.server, blob, versionOf, target.board) }))) : (cm.tray || (cm.tray = imgs.createImageTray({ ...(review ? { hintText: 'Pictures are included when you send these draft comments.' } : {}), upload: (blob, versionOf) => api.uploadCommentImage(cm.hex || st.hex, st.server, blob, versionOf, st.board) }))); // a new comment or reply can carry pictures; an edit keeps the ones it has
        const cancel = btn('ac-cancel', 'Cancel'); cancel.addEventListener('click', () => { if (tray) tray.destroy(); st.composing = null; st.wholeComposer = null; st.error = ''; render(); });
        const draft = !editOf && review;
        const send = btn(`${draft ? '' : 'btn-primary '}ac-send`, editOf ? 'Save' : review ? 'Save draft' : cm.parentId != null ? 'Reply' : 'Comment'); send.type = 'submit';
        const saveSend = draft ? btn('btn-primary ac-send ac-save-send', 'Send') : null;
        if (saveSend) saveSend.type = 'submit';
        const err = el('p', 'ac-error', st.error); err.setAttribute('role', 'alert'); err.hidden = !st.error;
        const actionWord = !editOf && review ? 'save this draft' : 'send';
        const how = el('p', 'ac-counter ac-sendhint', matchMedia('(pointer: coarse)').matches ? `Return starts a new line. Tap the button to ${actionWord}.` : `Enter starts a new line. Press ${sends} to ${actionWord}.`); how.id = `ac-sendhint-${Math.random().toString(36).slice(2, 8)}`; ta.setAttribute('aria-describedby', how.id); ta.dataset.sendhint = how.id; // Enter is a new line, so the way to send is said (#15231, walk 8 M3)
        const row = el('div', 'ac-composer-row');
        const actions = saveSend ? el('span', 'ac-draft-actions') : null;
        if (actions) actions.append(cancel, send, saveSend);
        row.append(count, ...(tray && !editOf ? [tray.picker()] : []), ...(actions ? [actions] : [cancel, send]));
        if (draft) for (const [button, glyph] of [[row.querySelector('.ac-add-image'), 'image'], [cancel, 'close'], [send, 'save'], [saveSend, 'send']]) {
            if (!button) continue;
            const label = button.textContent, icon = el('span', 'material-icons ac-action-icon');
            icon.dataset.glyph = glyph; icon.setAttribute('aria-hidden', 'true'); button.setAttribute('aria-label', label); if (!button.title && matchMedia('(max-width: 600px)').matches) button.setAttribute('title', label);
            button.replaceChildren(icon, el('span', 'ac-action-label', label));
        }
        const hint = editOf || review ? '' : st.hint?.() || '', hintEl = hint ? el('p', 'ac-note ac-hint', hint) : null; // always drawn with its line; shown while the file waits for review (the review bar toggles it with the file's state, #15128)
        if (hintEl) { hintEl.id = `ac-hint-${++hintSeq}`; const on = !!st.hintOn?.(); hintEl.hidden = !on; if (on) ta.setAttribute('aria-describedby', `${hintEl.id} ${how.id}`); } // a screen reader hears it where the person types
        const draftHint = draft ? el('p', 'ac-draft-save-hint', 'Saved as a draft. Send with Send comments or Send.') : null;
        if (draftHint) { draftHint.id = `ac-draft-hint-${++hintSeq}`; ta.setAttribute('aria-describedby', `${draftHint.id} ${how.id}`); }
        box.append(ta, ...(draftHint ? [draftHint] : []), ...(hintEl ? [hintEl] : []), how, ...(tray ? editOf ? [tray.node] : [tray.node, tray.hint()] : []), err, row);
        const syncButtons = () => { const blocked = !!tray && (tray.busy() || tray.failed()); send.disabled = blocked; if (saveSend) saveSend.disabled = blocked || !review.snapshot().data?.can_send; };
        if (tray) { tray.detach(); tray.attach(box, ta); tray.listen(() => { if (automatic) { st.composing = cm; delete box.dataset.idleWhole; } syncButtons(); }); } // Both actions wait for pictures still going up or failed.
        syncButtons();
        box.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = ta.value.trim(), pictures = tray ? tray.hexes() : [];
            if (!text && !pictures.length) { st.error = 'Write something first.'; err.textContent = st.error; err.hidden = false; return; }
            if (tray && (tray.busy() || tray.failed())) return;
            const alsoSend = !!saveSend && e.submitter === saveSend;
            send.disabled = true; if (saveSend) saveSend.disabled = true;
            if (editOf) run(async () => { const kept = await api.editComment(target.hex, target.server, editOf.id, text, tray.payload()); tray.destroy(); if (kept.picturesNotSaved) showToast(savedWords({ pictures_not_saved: true }, 'Comment saved'), true); }, 'Comment saved');
            else if (review) run(async () => {
                await review.create({ body: text, ...(cm.parentId != null ? { parent_id: cm.parentId } : { anchor: cm.anchor }), images: pictures });
                if (tray) tray.destroy();
                if (alsoSend) {
                    // The draft is durable before delivery: on a send failure, show
                    // the saved card and existing send error, never a duplicate editor.
                    st.composing = null; st.wholeComposer = null;
                    const targets = review.snapshot().data?.targets?.join(', ') || '';
                    const outcome = await review.send();
                    return outcome.status === 'queued' ? { queuedFor: targets || 'the agent' } : targets;
                }
            }, alsoSend ? 'Review comments sent' : 'Draft saved. Not sent to an agent.');
            else run(async () => { const c = await api.createComment(cm.hex || st.hex, st.server, { body: text, anchor: cm.anchor, parentId: cm.parentId, board: st.board, images: pictures, atS: cm.atS, endS: cm.endS }); if (tray) tray.destroy(); st.active = c.id; st.scrollCard = true; if (c.notDelivered && !c.sentTo) { st.undelivered.set(cm.parentId != null ? cm.parentId : c.id, c.notDelivered); showToast(`Not delivered: ${c.notDelivered}`, true); } else st.undelivered.delete(cm.parentId != null ? cm.parentId : c.id); if (c.sentTo && st.board === '~no-team') (st.noTeamSent || (st.noTeamSent = new Set())).add(cm.parentId != null ? cm.parentId : c.id); return c.sentTo || (c.queuedFor ? { queuedFor: c.queuedFor } : ''); }, cm.parentId != null ? 'Reply posted' : 'Comment posted');
        });
        ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel.click(); } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) box.requestSubmit(); });
        return box;
    }
    return { composer, editing };
}
