/* Image composer: picker, drag/paste, per-session uploads and attachment chips. Moved from controls.js (#8372). */

import { state } from './state.js';
import { escapeHtml, escapeAttr, showToast } from './utils.js';
import { serverFetch, sessionServer } from './server_base.js';
import { blockedReason } from './hub_access.js';
import { prepareImage, artifactErrorText, PICKER_ACCEPT, parseUploadReply, uploadStatusFailure, uploadCodeFailure, UPLOAD_UNFINISHED } from './image_attach.js';
import { responseErrorText } from './server_status.js';
import { sleepingBlocked } from './control_runtime.js';
import { registerUnsavedWork } from './update_banner.js';
import { registerActions } from './actions.js';

// Active upload promises scoped by session_id
export const activeUploadPromisesBySession = new Map(); // session_id -> Promise[]
// Attached image paths scoped by session_id (cleared on send)
const pendingAttachmentsBySession = new Map(); // session_id -> [{ path, filename, previewUrl }]

// An image attached or on its way is unsent work: a reload after a server update waits for it, as for typed text (update_banner.js; an empty composer with a picture in it is not an idle tab, #8735).
registerUnsavedWork(() => activeUploadPromisesBySession.size > 0 || [...pendingAttachmentsBySession.values()].some(list => list.length > 0));

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

        for (const file of files) {
            await uploadAndInsertImage(file);
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
        for (const file of files) {
            await uploadAndInsertImage(file);
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

export async function uploadAndInsertImage(file, session = state.currentSession) {
    const targetSession = session || state.currentSession;
    const sid = targetSession?.session_id;
    if (!sid) return false;

    const uploadPromise = (async () => {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("session_id", sid); // the agent this image is for: its artifact copy goes on that agent's record (#5284)

        // A failed upload says so in a sentence, with Retry where trying again can work (#6088: through Coral Hub an upload can be cut short and answered with an EMPTY 200).
        const failed = (text, retry) => showToast(text, true, 10000, retry ? { action: { label: "Retry", onClick: () => uploadAndInsertImage(file, targetSession) } } : {});
        // The request and its answer: only what goes wrong HERE is "Upload didn't finish". What happens after the answer (the strip, the toasts) has its own line below: one catch used to say the upload had not finished when the
        // file had gone up and the page failed to show it (#8735), and told nobody which error it was.
        let resp, text;
        try {
            // The path is typed into the agent, so the file must land on the agent's own server.
            resp = await serverFetch(sessionServer(targetSession), "/api/upload", {
                method: "POST",
                body: formData,
            });
            if (resp.ok) text = await resp.text();
        } catch (e) {
            console.error("Upload request failed:", e);
            failed(UPLOAD_UNFINISHED, true);
            return false;
        }
        if (!resp.ok) {
            const said = await resp.clone().json().catch(() => null); // the hub's proxy names the limit it hit in "code" (#6190); it wins over the status
            const known = uploadCodeFailure(said && said.code) || uploadStatusFailure(resp.status);
            if (known) failed(known.text, known.retry);
            else showToast(`Image not uploaded: ${await responseErrorText(resp, sessionServer(targetSession), `HTTP ${resp.status}`)}`, true);
            return false;
        }
        const result = parseUploadReply(text);
        if (!result) { console.error("Upload answered with no usable reply:", resp.status, String(text).slice(0, 200)); failed(UPLOAD_UNFINISHED, true); return false; }
        if (result.error) {
            showToast(result.error, true);
            return false;
        }

        // The file is on the agent's server: it is attached first, so a page that then fails to draw it still sends it.
        let list;
        try {
            // Create a local object URL for the thumbnail preview
            const previewUrl = URL.createObjectURL(file);
            list = getPendingAttachments(targetSession);
            list.push({
                path: result.path,
                filename: result.filename,
                previewUrl,
                artifact: result.artifact || null, // the image as an artifact (#5284); null with artifact_error saying why
            });
        } catch (e) {
            console.error("Image uploaded but could not be attached:", e);
            showToast("Image uploaded but not attached. Try again.", true, 10000, { action: { label: "Retry", onClick: () => uploadAndInsertImage(file, targetSession) } });
            return false;
        }
        try {
            if (state.currentSession?.session_id === sid) {
                renderAttachments(targetSession);
                document.getElementById("command-input")?.focus();
            }
            // The chip says what was attached (a toast per file covered Send on a phone, #6160): a screen reader is told in a hidden status line; only a copy that could not be shared is a toast, as it is news the chip does not carry.
            const status = document.getElementById("image-attach-status");
            if (status) status.textContent = list.length === 1 ? `Attached ${result.filename}` : `${list.length} images attached`;
            if (result.artifact_error) showToast(`Attached ${result.filename}, not shared: ${artifactErrorText(result)}`, true);
        } catch (e) {
            console.error("Image attached but could not be shown:", e);
            showToast("Image attached; the preview is not shown, it will still be sent.", true);
        }
        return true;
    })();

    const activeList = activeUploadPromisesBySession.get(sid) || [];
    activeList.push(uploadPromise);
    activeUploadPromisesBySession.set(sid, activeList);
    if (state.currentSession?.session_id === sid) renderAttachments(targetSession); // "Uploading" shows in the chip row, not as a toast per file (#6160)

    try {
        return await uploadPromise;
    } finally {
        const currentList = activeUploadPromisesBySession.get(sid) || [];
        const nextList = currentList.filter(p => p !== uploadPromise);
        if (nextList.length > 0) {
            activeUploadPromisesBySession.set(sid, nextList);
        } else {
            activeUploadPromisesBySession.delete(sid);
        }
        if (state.currentSession?.session_id === sid) renderAttachments(targetSession);
    }
}

const NOT_IMAGES = "Only images can be attached here.";
let lastDropNotice = 0;

// An attachment is named by its place in the strip ("Image 2"), not by its file's name: the name is a generated id that says nothing; it stays in the tooltip.
const imageName = (i, n) => (n > 1 ? `Image ${i + 1}` : 'Image');

export function renderAttachments(session = state.currentSession) {
    const container = document.getElementById("image-attachments");
    if (!container) return;

    const list = getPendingAttachments(session);
    const uploading = (activeUploadPromisesBySession.get(session?.session_id) || []).length;
    if (list.length === 0 && uploading === 0) {
        container.innerHTML = "";
        container.style.display = "none";
        return;
    }

    container.style.display = "flex";
    const uploadingText = `Uploading ${uploading === 1 ? "image" : `${uploading} images`}…`;
    const pending = uploading ? `<div class="image-uploading">${escapeHtml(uploadingText)}</div>` : "";
    container.innerHTML = list.map((att, i) => `
        <div class="image-attachment" title="${escapeAttr(att.filename)}">
            <button type="button" class="image-attachment-open" data-on-click="attachment-open" data-index="${Number(i)}" aria-label="Enlarge ${escapeAttr(imageName(i, list.length).toLowerCase())}" title="Open ${escapeAttr(att.filename)} full size"><img src="${escapeAttr(att.previewUrl)}" alt="" /></button>
            <button type="button" class="image-attachment-remove" data-on-click="attachment-remove" data-index="${Number(i)}" aria-label="Remove ${escapeAttr(imageName(i, list.length).toLowerCase())}" title="Remove ${escapeAttr(att.filename)}">&times;</button>
        </div>
    `).join("") + pending;
}

/** The attachment's picture full size, in its own tab (#10147): the thumbnail is small. */
export function openAttachment(index, session = state.currentSession) {
    const att = getPendingAttachments(session || state.currentSession)[index];
    if (att?.previewUrl) window.open(att.previewUrl, "_blank", "noopener");
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
    const list = pendingAttachmentsBySession.get(sid) || [];
    for (const att of list) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
    }
    pendingAttachmentsBySession.set(sid, []);
    if (state.currentSession?.session_id === sid) {
        renderAttachments(targetSession);
    }
}
