/* Saved-instruction editor; loaded only when the menu action is used. */
import { importOnce } from './import_once.js';
import { state } from './state.js';
import { serverForSession, serverFetch, sessionServer } from './server_base.js';
import { showToast } from './utils.js';
export async function editInstructions(name, agentType, sessionId, opener) {
    const server = serverForSession(name, sessionId);
    const current = state.liveSessions.find(s => s.session_id === sessionId && sessionServer(s) === server);
    const label = (current && current.display_name) || name;
    let info;
    try {
        const response = await serverFetch(server, `/api/sessions/live/${encodeURIComponent(name)}/info?session_id=${encodeURIComponent(sessionId)}`);
        if (!response.ok) throw new Error('Could not load the instructions. Try again.');
        info = await response.json();
        if (info.error) throw new Error(info.error);
    } catch (error) { showToast(error.message || 'Could not load the instructions. Try again.', true); return; }
    const { openInstructionsDialog } = await importOnce('./agent_instructions_dialog.js');
    openInstructionsDialog(label, {
        current: info.prompt || '',
        server, images: info.images?.instructions || [],
        opener,
        onSave: async (text, pictures) => {
            const resp = await serverFetch(server, `/api/sessions/live/${encodeURIComponent(name)}/instructions`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: sessionId, instructions: text, ...pictures }),
            });
            const result = await resp.json().catch(() => ({}));
            if (!resp.ok || result.error) return { ok: false, error: result.error || result.message || `Could not save the instructions (${resp.status}).` };
            if (current) { current.prompt = text; current.images = result.images || {}; }
            if (result.pictures_not_saved) showToast(result.pictures_warning || 'Pictures not saved. Attach them again.', true);
            if (!result.pictures_not_saved) showToast(text ? `Saved. ${label} uses these instructions the next time it restarts.` : `Cleared. ${label} starts without its own instructions the next time it restarts.`);
            return { ok: true };
        },
    });
}
