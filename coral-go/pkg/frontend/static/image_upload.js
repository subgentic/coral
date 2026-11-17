/* Upload transport loads only when a picture is sent. */
import { showToast } from './utils.js';
import { serverFetch, sessionServer } from './server_base.js';
import { parseUploadReply, uploadStatusFailure, uploadCodeFailure, UPLOAD_UNFINISHED } from './image_attach.js';
import { responseErrorText } from './server_status.js';

export async function postImage(file, targetSession, retry) {
    const sid = targetSession?.session_id;
    if (!sid) return null;
    const formData = new FormData();
    formData.append("file", file);
    formData.append("session_id", sid); // the agent this image is for: its artifact copy goes on that agent's record (#5284)

    // A failed upload says so in a sentence, with Retry where trying again can work (#6088: through Coral Hub an upload can be cut short and answered with an EMPTY 200).
    const failed = (text, canRetry) => showToast(text, true, 10000, canRetry ? { action: { label: "Retry", onClick: retry } } : {});
    // The request and its answer: only what goes wrong HERE is "Upload didn't finish". What happens after the answer (the strip, the toasts) has its own line in the callers: one catch used to say the upload had not
    // finished when the file had gone up and the page failed to show it (#8735), and told nobody which error it was.
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
        return null;
    }
    if (!resp.ok) {
        const said = await resp.clone().json().catch(() => null); // the hub's proxy names the limit it hit in "code" (#6190); it wins over the status
        const known = uploadCodeFailure(said && said.code) || uploadStatusFailure(resp.status);
        if (known) failed(known.text, known.retry);
        else showToast(`Image not uploaded: ${await responseErrorText(resp, sessionServer(targetSession), `HTTP ${resp.status}`)}`, true);
        return null;
    }
    const result = parseUploadReply(text);
    if (!result) { console.error("Upload answered with no usable reply:", resp.status, String(text).slice(0, 200)); failed(UPLOAD_UNFINISHED, true); return null; }
    if (result.error) {
        showToast(result.error, true);
        return null;
    }
    return result;
}

