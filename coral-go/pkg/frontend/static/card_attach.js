/* Images in the question card's answer box (#11386): a person can paste an image into "Or type your own answer" (or press Add image) to direct the agent. It goes up the way the message box's images do (postImage, one uploader:
 * POST /api/upload, the same limits and type checks, the same failures in words), shows as a chip with a remove button inside the card, and is sent WITH the typed text as the answer: the image's artifact link and the one
 * hint to fetch it first (attachmentsLead, exactly what the message box types), then the text. The card's images are its own: they never join the message box's strip, and they go when the answer is sent. */
import { state } from './state.js';
import { escapeAttr, showToast } from './utils.js';
import { sessionServer } from './server_base.js';
import { blockedReason } from './hub_access.js';
import { prepareImage } from './image_attach.js';
import { postImage } from './image_composer.js';
import { attachmentsLead } from './shared_images.js';
import { registerUnsavedWork } from './update_banner.js';

const bySession = new Map(); // session_id -> { list: [{ path, filename, artifact, previewUrl }], uploading: n }
const slot = sid => { let s = bySession.get(sid); if (!s) { s = { list: [], uploading: 0 }; bySession.set(sid, s); } return s; };

// An image on its way into an answer is unsent work, as typed text is (update_banner.js).
registerUnsavedWork(() => [...bySession.values()].some(s => s.list.length > 0 || s.uploading > 0));

/** The parts an answer starts with for this agent's card images (their links, then the one hint), [] with none. */
export const answerLead = sid => attachmentsLead(slot(sid).list);
export const cardImagesUploading = sid => slot(sid).uploading > 0;

/** The images are sent (or the card is gone): drop them and their thumbnails. */
export function clearCardImages(sid) {
    const s = bySession.get(sid); if (!s) return;
    for (const a of s.list) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    bySession.delete(sid);
    for (const card of document.querySelectorAll('#live-history-messages .chat-needs-input')) drawCardImages(card, sid);
}

/** Draw the chips of this agent's card images in every answer box of `card` (the card is drawn again whenever the terminal's screen changes: the chips are kept apart and drawn back). */
export function drawCardImages(card, sid) {
    const s = slot(sid);
    for (const form of card.querySelectorAll('.cni-text-form')) {
        const row = form.querySelector('.cni-attach'); if (!row) continue;
        const busy = s.uploading > 0;
        row.hidden = s.list.length === 0 && !busy;
        const chips = s.list.map((a, i) => `<div class="image-attachment" title="${escapeAttr(a.filename)}"><img src="${escapeAttr(a.previewUrl)}" alt="Image ${Number(i) + 1}" />`
            + `<button type="button" class="image-attachment-remove cni-attach-remove" data-index="${Number(i)}" aria-label="Remove image ${Number(i) + 1}" title="Remove ${escapeAttr(a.filename)}">&times;</button></div>`).join('');
        row.innerHTML = chips + (busy ? `<div class="image-uploading" role="status">Uploading ${Number(s.uploading) === 1 ? 'image' : `${Number(s.uploading)} images`}…</div>` : '');
    }
}

const cardOf = el => el.closest('.chat-needs-input') || el;

/** Put images into the answer box of `form`: each is checked and made smaller like the message box's, then uploaded one at a time. */
async function attach(files, form) {
    const session = state.currentSession;
    if (!session || session.type !== 'live') return;
    const why = blockedReason(sessionServer(session), 'launch'); // an upload writes a file on the agent's computer: the same tier as the message box's
    if (why) { showToast(why, true); return; }
    const sid = session.session_id, s = slot(sid);
    for (const file of files) {
        const prepared = await prepareImage(file);
        if (prepared.error) { showToast(prepared.error, true); continue; }
        s.uploading++; drawCardImages(cardOf(form), sid);
        let result = null;
        try { result = await postImage(prepared.file, session, () => attach([file], form)); } finally { s.uploading--; }
        if (result) s.list.push({ path: result.path, filename: result.filename, artifact: result.artifact || null, previewUrl: URL.createObjectURL(prepared.file) });
        drawCardImages(cardOf(form), sid);
    }
}

const formOf = e => (e.target instanceof Element ? e.target.closest('#live-history-messages .cni-text-form') : null);

document.addEventListener('paste', e => {
    const form = formOf(e); if (!form) return;
    const files = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean); // taken now: the clipboard's items are not valid after the event
    if (!files.length) return; // text pastes as text
    e.preventDefault();
    attach(files, form);
});

document.addEventListener('click', e => {
    const add = e.target instanceof Element ? e.target.closest('#live-history-messages .cni-attach-btn') : null;
    if (add) { const input = add.closest('.cni-text-form')?.querySelector('.cni-attach-input'); if (input) input.click(); return; }
    const rm = e.target instanceof Element ? e.target.closest('#live-history-messages .cni-attach-remove') : null;
    if (!rm || !state.currentSession) return;
    const sid = state.currentSession.session_id, s = slot(sid), i = Number(rm.dataset.index), gone = s.list.splice(i, 1)[0];
    if (gone && gone.previewUrl) URL.revokeObjectURL(gone.previewUrl);
    drawCardImages(cardOf(rm), sid);
    rm.closest('.cni-text-form')?.querySelector('.cni-text-input')?.focus();
});

document.addEventListener('change', e => {
    const input = e.target instanceof Element ? e.target.closest('#live-history-messages .cni-attach-input') : null;
    if (!input) return;
    const files = [...(input.files || [])]; input.value = ''; // taken before the input is cleared, so the same photo can be chosen again
    if (files.length) attach(files, input.closest('.cni-text-form'));
});
