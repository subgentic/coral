/* The launch-default disclosure is owned by the viewed computer. Only its owner
 * may acknowledge it; a dialog refusal starts nothing until that write succeeds. */
import { serverFetch, normServer, isCloud } from './server_base.js';
import { showToast } from './utils.js';
import { showConfirmModal } from './confirm_dialog.js';
import { announceNotice } from './notifications.js';
let readGeneration = 0;
const valid = value => value && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 128 && typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 12000;
async function acknowledge(server, disclosure) {
    const response = await serverFetch(server, '/api/launch-disclosure/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: disclosure.id }) });
    const answer = await response.json().catch(() => null);
    if (!response.ok || answer?.id !== disclosure.id || answer.seen !== true) throw new Error('Could not record that you have read this. Nothing was launched. Try again.');
    if (normServer(server) === 'local') { readGeneration++; document.getElementById('launch-disclosure-banner')?.remove(); }
}
export async function confirmLaunchDisclosure(server, disclosure) {
    if (!valid(disclosure) || disclosure.seen !== false) { showToast('The launch disclosure could not be read. Nothing was launched.', true); return false; }
    const accepted = await new Promise(resolve => showConfirmModal('Before starting with full permissions', disclosure.text, () => resolve(true), () => resolve(false), { danger: false, label: 'Continue launch', cancelLabel: 'Cancel' }));
    if (!accepted) return false;
    try { await acknowledge(server, disclosure); return true; }
    catch (error) { showToast(error.message, true); return false; }
}
export async function refreshLaunchDisclosure() {
    if (isCloud() || document.body.classList.contains('popout-mode')) return;
    const generation = ++readGeneration;
    try {
        const response = await serverFetch('local', '/api/launch-disclosure', { cache: 'no-store' });
        if (!response.ok) return; // older servers and non-owners have no offer
        const disclosure = await response.json(); if (generation !== readGeneration || !valid(disclosure)) return;
        const mode = document.getElementById('settings-permission-mode');
        if (mode) {
            let line = document.getElementById('settings-launch-disclosure');
            if (!line) { line = document.createElement('p'); line.id = 'settings-launch-disclosure'; line.className = 'sv-help'; mode.closest('.sv-row')?.querySelector('.sv-text')?.append(line); }
            line.textContent = disclosure.text;
        }
        const previous = document.getElementById('launch-disclosure-banner');
        if (disclosure.seen === true) { previous?.remove(); return; }
        if (disclosure.seen !== false || previous?.dataset.disclosureId === disclosure.id) return;
        previous?.remove();
        const banner = document.createElement('div'); banner.id = 'launch-disclosure-banner'; banner.dataset.disclosureId = disclosure.id; banner.className = 'notice notice-info notice-bar'; banner.setAttribute('role', 'note');
        const text = document.createElement('span'); text.className = 'alerts-offer-text'; text.textContent = disclosure.text;
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-small'; button.textContent = "I've read this";
        button.addEventListener('click', async () => { button.disabled = true; try { await acknowledge('local', disclosure); } catch (error) { button.disabled = false; showToast(error.message, true); } });
        banner.append(text, button);
        const after = document.getElementById('local-auth-banner') || document.querySelector('header.top-bar');
        if (after) after.after(banner); else document.body.prepend(banner);
        announceNotice(disclosure.text);
    } catch { /* no unauthenticated or network failure is an acknowledgement */ }
}
