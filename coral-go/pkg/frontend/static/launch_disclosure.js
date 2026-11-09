/* The launch-default disclosure is owned by the viewed computer. Only its owner
 * may acknowledge it; a dialog refusal starts nothing until that write succeeds. */
import { serverFetch, normServer, isCloud } from './server_base.js';
import { showToast } from './utils.js';
import { showConfirmModal } from './confirm_dialog.js';
import { announceNotice } from './notifications.js';
import { browserLocal } from './safe_storage.js';
let readGeneration = 0;
const HINT_KEY = 'coral-launch-notice'; // "p|3.3" or "d|4.6": this browser last saw the notice unseen, on a phone-sized or a wider screen, at that height in rem (theme_init.js reserves its row before first paint)
const hint = {
    // The height is kept in rem, not px, so a text size changed since (200% text, a bigger system font) reserves the notice's real size (#14835, UI Accessibility), and only for the notice CLOSED: an opened one is taller, and its
    // height would reserve more than the collapsed row every later load shows. Storage that is blocked just means no reserved row.
    set(banner) { if (banner.querySelector('details')?.open) return; const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; browserLocal.set(HINT_KEY, `${window.innerWidth <= 600 ? 'p' : 'd'}|${Math.max(0, Math.min(99, Math.round(banner.getBoundingClientRect().height / rem * 10) / 10))}`); },
    clear() { browserLocal.remove(HINT_KEY); },
    release() { document.getElementById('launch-notice-room')?.remove(); document.documentElement.removeAttribute('data-launch-notice'); }, // the notice fills the room, or there is none to fill
};
const headline = 'Agents default to auto mode.';
function disclosureSection(id, title, disclosure) {
    const section = document.createElement('details'); section.className = 'disclosure';
    const summary = document.createElement('summary');
    const summaryText = document.createElement('span'); summaryText.className = 'launch-disclosure-summary-text'; summaryText.textContent = title;
    summary.append(summaryText);
    summary.setAttribute('aria-expanded', 'false'); summary.setAttribute('aria-controls', id);
    const body = document.createElement('div'); body.id = id; body.hidden = true;
    const text = document.createElement('p'); text.textContent = disclosure.text; body.append(text);
    section.addEventListener('toggle', () => { body.hidden = !section.open; summary.setAttribute('aria-expanded', String(section.open)); });
    section.append(summary, body); return { section, body, text };
}
const valid = value => value && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 128 && typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 12000;
async function acknowledge(server, disclosure) {
    const response = await serverFetch(server, '/api/launch-disclosure/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: disclosure.id }) });
    const answer = await response.json().catch(() => null);
    if (!response.ok || answer?.id !== disclosure.id || answer.seen !== true) throw new Error('Could not record that you have read this. Nothing was launched. Try again.');
    if (normServer(server) === 'local') { readGeneration++; document.getElementById('launch-disclosure-banner')?.remove(); hint.clear(); hint.release(); }
}
export async function confirmLaunchDisclosure(server, disclosure) {
    if (!valid(disclosure) || disclosure.seen !== false) { showToast('The launch disclosure could not be read. Nothing was launched.', true); return false; }
    const accepted = await new Promise(resolve => showConfirmModal('Before starting with full permissions', disclosure.text, () => resolve(true), () => resolve(false), { danger: false, label: 'Continue launch', cancelLabel: 'Cancel' }));
    if (!accepted) return false;
    try { await acknowledge(server, disclosure); return true; }
    catch (error) { showToast(error.message, true); return false; }
}
export async function refreshLaunchDisclosure() {
    if (isCloud() || document.body.classList.contains('popout-mode')) { hint.release(); return; }
    const generation = ++readGeneration;
    try {
        const response = await serverFetch('local', '/api/launch-disclosure', { cache: 'no-store' });
        if (!response.ok) { hint.clear(); hint.release(); return; } // older servers and non-owners have no offer: nothing is reserved for it
        const disclosure = await response.json(); if (generation !== readGeneration) return; if (!valid(disclosure)) { hint.release(); return; } // an answer that is not a notice reserves nothing (the hint stays: the next read may be right)
        const mode = document.getElementById('settings-permission-mode');
        if (mode) {
            let line = document.getElementById('settings-launch-disclosure');
            if (!line) { const part = disclosureSection('settings-launch-disclosure-body', 'Permissions notice', disclosure); line = part.text; line.id = 'settings-launch-disclosure'; mode.closest('.sv-row')?.querySelector('.sv-text')?.append(part.section); }
            line.textContent = disclosure.text;
        }
        const previous = document.getElementById('launch-disclosure-banner');
        if (disclosure.seen === true) { previous?.remove(); hint.clear(); hint.release(); return; }
        if (disclosure.seen === false && previous?.dataset.disclosureId === disclosure.id) { hint.set(previous); return; } // already drawn (an earlier read): the hint is kept as it is
        if (disclosure.seen !== false) return;
        previous?.remove();
        const banner = document.createElement('div'); banner.id = 'launch-disclosure-banner'; banner.dataset.disclosureId = disclosure.id; banner.className = 'notice notice-info notice-bar notice-compact'; banner.setAttribute('role', 'note');
        const { section, body } = disclosureSection('launch-disclosure-body', headline, disclosure);
        const summary = section.querySelector('summary');
        const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'btn btn-small launch-disclosure-dismiss'; dismiss.textContent = 'Dismiss'; dismiss.setAttribute('aria-label', 'Dismiss, I have read this');
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-small'; button.textContent = "I've read this";
        const acknowledgeButtons = () => [...banner.querySelectorAll('button')];
        const acknowledgeFromNotice = async () => {
            const buttons = acknowledgeButtons(); buttons.forEach(control => { control.disabled = true; });
            try { await acknowledge('local', disclosure); }
            catch (error) { buttons.forEach(control => { control.disabled = false; }); showToast(error.message, true); }
        };
        button.addEventListener('click', () => { if (section.open) acknowledgeFromNotice(); });
        dismiss.addEventListener('click', event => {
            event.preventDefault(); event.stopPropagation();
            acknowledgeFromNotice();
        });
        summary.append(dismiss);
        body.append(button); banner.append(section);
        const after = document.getElementById('local-auth-banner') || document.querySelector('header.top-bar');
        if (after) after.after(banner); else document.body.prepend(banner);
        window.dispatchEvent(new Event('coral:launch-disclosure-shown'));
        hint.release(); hint.set(banner); // the notice now holds the room; the next load reserves it from the start
        announceNotice(headline);
    } catch { hint.release(); /* no unauthenticated or network failure is an acknowledgement, and nothing is left reserved for a notice that did not come */ }
}
