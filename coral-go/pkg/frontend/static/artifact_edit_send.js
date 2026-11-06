/* The saved file's own team/computer stays fixed for the lifetime of its picker. */
import { importOnce } from './import_once.js';
import { el } from './dom_el.js';
import { loadStyles } from './lazy_styles.js';
import { state } from './state.js';
import { visibleName } from './artifact_names.js';
import { isPhoneLayout } from './phone_layout.js';
import { pushOverlay, popOverlay } from './overlay_history.js';
const API = await importOnce('./artifact_edit_send_api.js');
const picker = await importOnce('./artifact_comment_send.js');
const { refreshTeamAvailability } = await importOnce('./team_availability.js');
await loadStyles('artifact_edit_send.css');
export function openEditSend({ context, filename, onSent = () => {}, onThread = () => {}, onClose = () => {} }) {
    let dead = false, busy = false, agents = null, capability = null, results = null, error = '', empty = '', commentId = null, overlay = 0;
    const picked = new Set(), asked = new Map(), abort = new AbortController();
    const dialog = el('dialog', 'modal-content dlg-form artifact-edit-send-dialog'); dialog.setAttribute('aria-labelledby', 'artifact-edit-send-title');
    const title = el('h2', null, 'Send your edit to an agent'); title.id = 'artifact-edit-send-title';
    const name = el('p', 'aes-name', visibleName(filename) || 'Saved document'), versions = el('p', 'aes-versions', 'Checking the saved versions…');
    const status = el('p', 'aes-status', 'Saving does not send anything. Choose recipients, then press Send.'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const host = el('div', 'aes-picker'), thread = el('button', 'btn aes-thread', 'View thread'); thread.type = 'button'; thread.hidden = true;
    dialog.append(title, name, versions, status, host, thread);
    const say = text => { status.textContent = text; };
    function close({ popped = false } = {}) {
        if (dead) return true;
        if (busy) { say('Sending is in progress. Wait for its result before closing.'); if (popped) overlay = pushOverlay(close); return false; }
        dead = true; abort.abort(); if (overlay) { const id = overlay; overlay = 0; if (!popped) popOverlay(id); }
        dialog.close(); dialog.remove(); onClose(); return true;
    }
    function draw(role) {
        if (dead) return;
        host.replaceChildren(picker.buildSendBlock({ id: `edit-${context.hex}`, board: context.key, title: 'Choose agents for this saved edit', note: 'They receive the compared versions and your edit’s diff, and can reply in its thread.', agents, empty, picked, asked, results, busy, error,
            onToggle: value => { if (picked.has(value)) picked.delete(value); else if (picked.size < picker.MAX_AGENTS) picked.add(value); draw(value); },
            onCancel: () => close(), onSend: send,
        }));
        if (role) [...host.querySelectorAll('input')].find(i => i.value === role)?.focus();
        thread.hidden = !commentId;
    }
    async function send() {
        if (dead || busy || !capability || !picked.size) return;
        busy = true; error = ''; draw(); say('Sending your saved edit…');
        try {
            const reply = await API.sendSavedEdit(context, [...picked]); if (dead) return;
            commentId = reply.commentId || commentId;
            results = reply.results.length ? reply.results : null;
            error = reply.ok ? '' : (reply.error || 'The send did not complete. Check each recipient’s result.');
            const count = reply.results.filter(r => r.state === 'sent').length, already = reply.results.filter(r => r.state === 'already_sent').length;
            if (count || already) { say(count ? `Sent to ${count} agent${count === 1 ? '' : 's'}.${reply.omitted ? ' The diff was too large; both version links were included.' : ' They can reply in this thread.'}` : 'These agents already have this edit. Nothing was sent again.'); onSent(reply); }
            else say(reply.ok ? 'No delivery was confirmed. Check the thread before trying again.' : 'Nothing new was confirmed. Check the recipient results.');
        } catch { error = 'The send result could not be confirmed. Reopen this picker to check the thread before trying again.'; say('Your saved document is unchanged.'); }
        finally { busy = false; if (!dead) { draw(); (thread.hidden ? host.querySelector('.ac-cancel') : thread)?.focus(); } }
    }
    thread.addEventListener('click', () => { const id = commentId; if (close() && id) onThread(id); });
    dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
    dialog.addEventListener('keydown', e => { if (e.key === 'Escape' || e.key === 'Tab') e.stopPropagation(); });
    dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
    draw(); document.body.append(dialog); dialog.showModal(); if (isPhoneLayout()) overlay = pushOverlay(close);
    title.tabIndex = -1; title.focus();
    (async () => {
        try {
            capability = await API.editSendCapability(context, { signal: abort.signal }); if (dead) return;
            if (!capability) { agents = []; error = 'This saved version cannot be sent from here.'; versions.textContent = ''; draw(); return; }
            versions.textContent = `Your edit: v${capability.base_version} → v${capability.version}`; commentId = Number.isSafeInteger(capability.thread_id) ? capability.thread_id : null;
            for (const role of capability.sent_to) asked.set(role.toLowerCase(), 'Already asked');
            const data = await refreshTeamAvailability(context.key, true); if (dead) return;
            agents = picker.pickableAgents(data?.agents); empty = picker.emptyWords(context.server === 'local' ? '' : ((state.servers || []).find(s => s.id === context.server)?.name || context.server), (data?.agents || []).length, agents.length); draw(); host.querySelector('input:not([aria-disabled="true"])')?.focus();
        } catch (e) { if (dead || e.name === 'AbortError') return; agents = 'error'; error = e.message || 'The recipients could not be read.'; draw(); }
    })();
    return { close, beforeLeave() { return !close(); }, get busy() { return busy; } };
}
