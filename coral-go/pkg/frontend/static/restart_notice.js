// Restart-only bookkeeping stays off the startup path (#17021).
import { state, sessionKey, saveSessionDraft } from './state.js';
import { showToast } from './utils.js';

// One progress card tracks the requests still in flight; completion removes its own entry (#17021).
const pendingRestarts = new Map();
let restartProgress = null;
export function restartNotice(token, who) {
    if (who === undefined) { if (!pendingRestarts.delete(token)) return; }
    else pendingRestarts.set(token, who);
    restartProgress?.querySelector('.toast-close')?.click();
    restartProgress = null;
    if (!pendingRestarts.size) return;
    const names = [...pendingRestarts.values()];
    restartProgress = showToast(names.length === 1 ? `Restarting ${names[0]}` : `Restarting ${names.length} agents`, false, undefined, { group: { key: 'restarting', text: n => `Restarting ${n} agents` } });
}

/** The words typed to the agent being replaced are not for its replacement (#10297): the box and the saved draft are emptied before the new session takes the old one's place. */
export function forgetDraft(session, oldId, newId) {
    for (const id of [oldId, newId]) { // the feed may already have moved the page's session to the new id: the draft is under whichever it had
        const key = id && sessionKey({ ...session, session_id: id });
        if (key) saveSessionDraft(key, '');
    }
    const input = document.getElementById('command-input');
    if (input && state.currentSession === session) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
}

