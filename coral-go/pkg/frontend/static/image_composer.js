/* Image composer: picker, drag/paste, per-session uploads and attachment chips. Moved from controls.js (#8372). */

import { importOnce } from './import_once.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { sessionServer, sessionTeamKey } from './server_base.js';
import { blockedReason } from './hub_access.js';
import { prepareImage, PICKER_ACCEPT } from './image_attach.js';
import { sleepingBlocked } from './control_runtime.js';
import { registerUnsavedWork } from './update_banner.js';
import { registerActions } from './actions.js';

// Active upload promises scoped by session_id
export const activeUploadPromisesBySession = new Map(); // session_id -> Promise[]
// Attached image paths scoped by session_id (cleared on send)
const pendingAttachmentsBySession = new Map();
export const uploadDrafts = new Map();
let pictureView;
export const hasFailedAttachments = sid => (uploadDrafts.get(sid) || []).some(it => it.state === 'failed');

// An image attached or on its way is unsent work: a reload after a server update waits for it, as for typed text (update_banner.js; an empty composer with a picture in it is not an idle tab, #8735).
registerUnsavedWork(() => activeUploadPromisesBySession.size > 0 || uploadDrafts.size > 0 || [...pendingAttachmentsBySession.values()].some(list => list.length > 0));

export function getPendingAttachments(session = state.currentSession) {
    const sid = session?.session_id;
    if (!sid) return [];
    if (!pendingAttachmentsBySession.has(sid)) {
        pendingAttachmentsBySession.set(sid, []);
    }
    return pendingAttachmentsBySession.get(sid);
}

export function initImageDrop() {
    const commandPane = document.getElementById("command-pane");
    if (!commandPane) return;

    // Create drop overlay
    const overlay = document.createElement("div");
    overlay.id = "drop-overlay";
    overlay.className = "drop-overlay";
    overlay.innerHTML = `<div class="drop-overlay-content">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>
        </svg>
        <span>Drop image to attach</span>
    </div>`;
    overlay.style.display = "none";
    commandPane.style.position = "relative";
    commandPane.appendChild(overlay);

    let dragCounter = 0;

    commandPane.addEventListener("dragenter", (e) => {
        e.preventDefault();
        if (!hasImageFiles(e)) return;
        dragCounter++;
        overlay.style.display = "flex";
    });

    commandPane.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (hasImageFiles(e)) e.dataTransfer.dropEffect = "copy";
    });

    commandPane.addEventListener("dragleave", (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            overlay.style.display = "none";
        }
    });

    commandPane.addEventListener("drop", async (e) => {
        e.preventDefault();
        dragCounter = 0;
        overlay.style.display = "none";

        const dropped = [...(e.dataTransfer?.files || [])];
        const files = dropped.filter(f => f.type.startsWith("image/"));
        // A file that is not an image is not attached: say what to do instead of nothing (#10147).
        if (files.length < dropped.length || dropped.length === 0) {
            // said once for one drop, however many elements the event reaches, and naming the file: "Mention it with @data.csv" (#10311)
            const other = dropped.find(f => !f.type.startsWith("image/"));
            if (Date.now() - lastDropNotice > 1500) { lastDropNotice = Date.now(); showToast(other && other.name && !/\s/.test(other.name) ? `${NOT_IMAGES} Mention it with @${other.name}.` : NOT_IMAGES, files.length === 0); }
        }
        if (files.length === 0) return;

        const session = state.currentSession;
        for (const file of files) {
            await uploadAndInsertImage(file, session);
        }
    });

    // Also support paste — listen on document so it works even when textarea isn't focused
    const pasteHandler = async (e) => {
        // Only handle when a live session is selected
        if (!state.currentSession || state.currentSession.type !== "live") return;
        // Skip if pasting inside other inputs (not the command input)
        const tag = e.target.tagName;
        if ((tag === "INPUT" || tag === "TEXTAREA") && e.target.id !== "command-input") return;
        if (e.target.isContentEditable) return;

        const items = [...(e.clipboardData?.items || [])];
        const imageItems = items.filter(item => item.type.startsWith("image/"));
        if (imageItems.length === 0) return;

        // Extract all files synchronously before any async work,
        // because clipboardData items become invalid after the event.
        const files = imageItems.map(item => item.getAsFile()).filter(Boolean);
        if (files.length === 0) return;

        e.preventDefault();
        const session = state.currentSession;
        for (const file of files) {
            await uploadAndInsertImage(file, session);
        }
    };
    document.addEventListener("paste", pasteHandler);
}

function hasImageFiles(e) {
    if (e.dataTransfer?.types?.includes("Files")) {
        // Check items if available
        const items = e.dataTransfer.items;
        if (items) {
            for (const item of items) {
                if (item.kind === "file" && item.type.startsWith("image/")) return true;
            }
        }
        return true; // Can't check types on dragenter in some browsers, assume images
    }
    return false;
}

/** The Add image button (#6088): opens the file picker (a phone offers Photo Library, Take Photo and Browse). Launch tier through Coral Hub, as the upload route is: a refused account is told why. This runs
 *  straight from the tap, with nothing awaited before the click, or a phone would not open the picker. */
export function openImagePicker() {
    const session = state.currentSession;
    if (!session || session.type !== "live") return;
    if (sleepingBlocked()) return;
    const why = blockedReason(sessionServer(session), "launch");
    if (why) { showToast(why, true); return; }
    const input = document.getElementById("attach-image-input");
    if (!input) return;
    input.accept = PICKER_ACCEPT;
    input.click();
}

// The input's change is an action on the input itself (data-on-change in the template), not a listener the button's first press adds: a file given to the input any other way (a file chooser that is not
// the button's, a drag from the OS, a test) is taken the same (#10512). The files are taken before the input is cleared, so the same photo can be chosen again.
registerActions({
    'chat-team-files': async () => {
        const team = sessionTeamKey(state.currentSession);
        if (team) { window.closeSendMenu(); await (await importOnce('./team_page.js')).openTeamPage(team, { tab: 'artifacts' }); }
    },
    'attach-image-picked': el => { const files = [...(el.files || [])]; el.value = ''; if (files.length) uploadPickedImages(files); },
});

/** Pictures chosen in the picker go up one after another, not at once (a phone on a slow connection, and the hub's limit on parallel requests); each is made smaller first when it is a big photo. */
async function uploadPickedImages(files, session = state.currentSession) {
    for (const file of files) {
        const prepared = await prepareImage(file);
        if (prepared.error) { showToast(prepared.error, true); continue; }
        await uploadAndInsertImage(prepared.file, session);
    }
}

/** One image up to the agent's own server (POST /api/upload, source paste): the reply ({ path, filename, artifact, artifact_error }) or null after saying why in words, with Retry where trying again can work. `retry` is what that
 *  Retry runs. The composer's chips and the question card's answer box both go up this way (#11386): there is one uploader. */
export async function postImage(file, targetSession, retry) {
    return (await importOnce('./image_upload.js')).postImage(file, targetSession, retry);
}

export async function uploadAndInsertImage(file, session = state.currentSession) {
    const sid = session?.session_id; if (!sid) return false;
    const p = importOnce('./chat_picture_upload.js').then(m => m.uploadAndInsertImage(file, session));
    const list = activeUploadPromisesBySession.get(sid) || []; list.push(p); activeUploadPromisesBySession.set(sid, list);
    try { return await p; } catch { showToast('Picture could not be added. Try again.', true); return false; } finally {
        const rest = (activeUploadPromisesBySession.get(sid) || []).filter(it => it !== p);
        if (rest.length) activeUploadPromisesBySession.set(sid, rest); else activeUploadPromisesBySession.delete(sid);
        if (state.currentSession?.session_id === sid) renderAttachments(session);
    }
}

const NOT_IMAGES = "Only images can be attached here.";
let lastDropNotice = 0;

export function renderAttachments(session = state.currentSession) {
    for (const otherFiles of document.querySelectorAll('.composer-other-files')) otherFiles.hidden = !sessionTeamKey(session);
    const container = document.getElementById("image-attachments");
    if (!container) return;

    const list = getPendingAttachments(session), drafts = uploadDrafts.get(session?.session_id) || [];
    if (!list.length && !drafts.length) { container.replaceChildren(); container.style.display = 'none'; return; }
    container.style.display = 'flex';
    if (!pictureView) { importOnce('./picture_tray.js').then(m => { pictureView = m; renderAttachments(); }, () => showToast('Picture preview could not load. Your draft is kept.', true)); return; }
    const items = [...list.map(a => ({ ...a, state: 'ready' })), ...drafts];
    try { pictureView.drawPictureTray(container, items, {
        open: i => window.open(items[i].previewUrl, '_blank', 'noopener'),
        remove: i => { if (i < list.length) removeAttachment(i, session); else { const d = drafts.splice(i - list.length, 1)[0]; URL.revokeObjectURL(d.previewUrl); if (!drafts.length) uploadDrafts.delete(session.session_id); renderAttachments(session); } },
        retry: i => importOnce('./chat_picture_upload.js').then(m => m.retryDraft(items[i], session)),
    }); } catch (e) {
        console.error('Image attached but could not be shown:', e);
        showToast('Image attached; the preview is not shown, it will still be sent.', true);
    }
}

export function removeAttachment(index, session = state.currentSession) {
    const targetSession = session || state.currentSession;
    const list = getPendingAttachments(targetSession);
    const removed = list.splice(index, 1);
    if (removed[0]?.previewUrl) URL.revokeObjectURL(removed[0].previewUrl);
    renderAttachments(targetSession);
}

export function clearAttachments(session = state.currentSession) {
    const targetSession = session || state.currentSession;
    const sid = targetSession?.session_id;
    if (!sid) return;
    const drafts = uploadDrafts.get(sid) || []; for (const d of drafts) URL.revokeObjectURL(d.previewUrl); drafts.length = 0; uploadDrafts.delete(sid);
    const list = pendingAttachmentsBySession.get(sid) || [];
    for (const att of list) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
    }
    pendingAttachmentsBySession.set(sid, []);
    if (state.currentSession?.session_id === sid) {
        renderAttachments(targetSession);
    }
}
