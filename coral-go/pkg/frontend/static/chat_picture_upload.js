/* Chat's picture upload state transitions load only when a picture is added. The original
 * session is retained through upload/retry; the renderer never chooses its destination. */
import { state } from './state.js';
import { showToast } from './utils.js';
import { artifactErrorText } from './image_attach.js';
import { uploadAndInsertImage as queueUpload, postImage, getPendingAttachments, uploadDrafts, renderAttachments } from './image_composer.js';

export async function uploadAndInsertImage(file, session = state.currentSession) {
    const targetSession = session || state.currentSession;
    const sid = targetSession?.session_id;
    if (!sid) return false;

    const drafts = uploadDrafts.get(sid) || []; uploadDrafts.set(sid, drafts);
    let previewUrl = '';
    try { previewUrl = URL.createObjectURL(file); } catch { /* Retry preview creation after the upload; it must not prevent transport. */ }
    const draft = { name: file.name || 'Picture', file, previewUrl, state: 'uploading' }; drafts.push(draft);
    if (state.currentSession?.session_id === sid) renderAttachments(targetSession);
    const uploadPromise = (async () => {
        const result = await postImage(file, targetSession, () => retryDraft(draft, targetSession));
        if (!drafts.includes(draft)) return false;
        if (!result) { draft.state = 'failed'; return false; }
        drafts.splice(drafts.indexOf(draft), 1); if (!drafts.length) uploadDrafts.delete(sid);

        // The file is on the agent's server: it is attached first, so a page that then fails to draw it still sends it.
        let list;
        try {
            // Create a local object URL for the thumbnail preview
            const previewUrl = draft.previewUrl || URL.createObjectURL(file);
            list = getPendingAttachments(targetSession);
            list.push({
                path: result.path,
                filename: result.filename,
                previewUrl,
                artifact: result.artifact || null, // the image as an artifact (#5284); null with artifact_error saying why
            });
        } catch (e) {
            console.error("Image uploaded but could not be attached:", e);
            showToast("Image uploaded but not attached. Try again.", true, 10000, { action: { label: "Retry", onClick: () => queueUpload(file, targetSession) } });
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

    try {
        return await uploadPromise;
    } catch { draft.state = 'failed'; return false;
    } finally {
        if (state.currentSession?.session_id === sid) renderAttachments(targetSession);
    }
}

export function retryDraft(draft, session) {
    const drafts = uploadDrafts.get(session.session_id) || [];
    const i = drafts.indexOf(draft); if (i < 0 || draft.state !== 'failed') return;
    drafts.splice(i, 1); URL.revokeObjectURL(draft.previewUrl); if (!drafts.length) uploadDrafts.delete(session.session_id);
    return queueUpload(draft.file, session);
}

