/* The launch-default disclosure is owned by the viewed computer. Only its owner
 * may acknowledge it; a dialog refusal starts nothing until that write succeeds. */
import { serverFetch, normServer, isCloud, sessionServer } from './server_base.js';
import { showToast } from './utils.js';
import { showConfirmModal, hideConfirmModal } from './confirm_dialog.js';
import { announceNotice } from './notifications.js';
import { browserLocal } from './safe_storage.js';
import { attachDialogFocus } from './dialog_focus.js';
import { isPhoneLayout } from './phone_layout.js';
import { state } from './state.js';
import { importOnce } from './import_once.js';
import { liveListReady } from './initial_load.js';
let readGeneration = 0;
const hasLocalAgent = () => (state.liveSessions || []).some(session => sessionServer(session) === 'local');
let bannerEligible = hasLocalAgent();
window.addEventListener('coral:live-list-rendered', () => {
    if (hasLocalAgent() !== bannerEligible) refreshLaunchDisclosure();
});
const HINT_KEY = 'coral-launch-notice'; // "p|57" or "d|73": this browser last saw the notice unseen, on a phone-sized or a wider screen, at that height (theme_init.js reserves its row before first paint)
const hint = {
    set(px) { browserLocal.set(HINT_KEY, `${window.innerWidth <= 600 ? 'p' : 'd'}|${Math.max(0, Math.min(999, Math.round(px)))}`); }, // storage that is blocked just means no reserved row
    clear() { browserLocal.remove(HINT_KEY); },
    release() { document.getElementById('launch-notice-room')?.remove(); document.documentElement.removeAttribute('data-launch-notice'); }, // the notice fills the room, or there is none to fill
};
/** The notice says agents default to auto mode, so it is only true while the saved default is Auto (unset is Auto too, settings_diff's FIELD_DEFAULT): with another default saved it is hidden, and comes back when the default does (#16367). */
const defaultIsAuto = () => { const m = state.settings?.default_permission_mode; return !m || m === 'auto'; };
const headline = 'Auto mode';
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
    if (normServer(server) === 'local') { readGeneration++; document.getElementById('launch-disclosure-banner')?.remove(); shown = null; hint.clear(); hint.release(); }
}
export async function confirmLaunchDisclosure(server, disclosure, payload = null) {
    if (!valid(disclosure) || disclosure.seen !== false) { showToast('The launch disclosure could not be read. Nothing was launched.', true); return false; }
    // The members whose mode is their own are named (#16500); the two modules load now, not at start.
    const hasOwn = payload && (payload.permission_mode || (payload.agents || []).some(a => a && a.permission_mode));
    const { launchModeNotice } = await importOnce('./launch_disclosure_modes.js');
    const customs = hasOwn ? await importOnce('./custom_modes.js') : null;
    const { title, note } = launchModeNotice(payload, value => value === 'default' ? 'Default' : (customs?.customModeById(value)?.name || 'its own mode'));
    let link = null; // where the default is changed, as a link in the dialog (#18765): it closes the question as a Cancel (nothing launches) and opens Settings on Defaults
    const accepted = await new Promise(resolve => {
        showConfirmModal(title, note ? `${disclosure.text} ${note}` : disclosure.text, () => resolve(true), () => resolve(false), { danger: false, label: 'Continue launch', cancelLabel: 'Cancel' });
        attachDialogFocus(document.getElementById('confirm-modal'));
        document.getElementById('confirm-modal-yes').focus();
        link = document.createElement('a'); link.id = 'confirm-modal-link'; link.href = '#'; link.textContent = 'Open Settings > Defaults';
        link.addEventListener('click', event => { event.preventDefault(); hideConfirmModal(); window.showSettingsModal?.('agents'); });
        document.getElementById('confirm-modal-message')?.after(link);
    });
    link?.remove();
    if (!accepted) return false;
    try { await acknowledge(server, disclosure); return true; }
    catch (error) { showToast(error.message, true); return false; }
}

// Where the notice sits (#16460): the global strip under the top bar, except on a phone's Inbox, where it is in the pane, under the pane's own heading (after .inbox-folder-toolbar) and above the list.
// It is ONE element moved in and out: the pane is rebuilt on every redraw (which drops what is in it), so a watcher puts it back, and a tab or a rotation moves it to the strip or the pane.
let shown = null, watching = false;
export function placeNotice() {
    const banner = shown;
    if (!banner) return;
    const inbox = isPhoneLayout() && document.body.getAttribute('data-nav-tab') === 'hub-inbox';
    const bar = inbox ? document.querySelector('#group-table-view > .inbox-folder-toolbar') : null;
    if (bar) { if (bar.nextElementSibling !== banner) bar.after(banner); return; }
    if (inbox && banner.parentElement?.id === 'group-table-view') return; // the pane is between redraws: it stays where it is until the heading is back
    const after = document.getElementById('local-auth-banner') || document.querySelector('header.top-bar');
    if (after) { if (after.nextElementSibling !== banner) after.after(banner); } else if (banner.parentElement !== document.body) document.body.prepend(banner);
}
function watchPlace() {
    if (watching) return; watching = true;
    const again = () => placeNotice();
    new MutationObserver(again).observe(document.body, { attributes: true, attributeFilter: ['data-nav-tab'] });
    const view = document.getElementById('group-table-view'); if (view) new MutationObserver(again).observe(view, { childList: true });
    window.matchMedia?.('(max-width: 767px)').addEventListener?.('change', again);
}
/** A saved default changes the banner's eligibility. Hiding it needs no read; returning to Auto reads only while a local agent can show it. Settings' separate disclosure text still uses the normal refresh. */
export function refreshDefaultNotice() {
    if (defaultIsAuto() && hasLocalAgent()) return refreshLaunchDisclosure();
    bannerEligible = hasLocalAgent(); readGeneration++;
    document.getElementById('launch-disclosure-banner')?.remove(); shown = null; hint.clear(); hint.release();
}
export async function refreshLaunchDisclosure() {
    if (isCloud() || document.body.classList.contains('popout-mode')) { hint.release(); return; }
    bannerEligible = hasLocalAgent();
    const generation = ++readGeneration;
    try {
        const response = await serverFetch('local', '/api/launch-disclosure', { cache: 'no-store' });
        if (!response.ok) { hint.clear(); hint.release(); return; } // older servers and non-owners have no offer: nothing is reserved for it
        const disclosure = await response.json(); if (generation !== readGeneration) return; if (!valid(disclosure)) { hint.release(); return; }
        const mode = document.getElementById('settings-permission-mode');
        if (mode) {
            let line = document.getElementById('settings-launch-disclosure');
            if (!line) { const part = disclosureSection('settings-launch-disclosure-body', 'Permissions notice', disclosure); line = part.text; line.id = 'settings-launch-disclosure'; mode.closest('.sv-row')?.querySelector('.sv-text')?.append(part.section); }
            line.textContent = disclosure.text;
        }
        if (!defaultIsAuto()) { document.getElementById('launch-disclosure-banner')?.remove(); shown = null; hint.clear(); hint.release(); return; } // the default is not Auto: nothing here is true to say; the launch-time confirm (409) is the server's and stays
        if (!hasLocalAgent()) { await liveListReady; if (generation !== readGeneration) return; } // the page's first list may not have landed yet: no agent in it is not 'no agent', and giving the reserved row back (and the hint) now would move the page when the notice comes a moment later
        const previous = document.getElementById('launch-disclosure-banner');
        if (!hasLocalAgent() || disclosure.seen === true) { previous?.remove(); shown = null; hint.clear(); hint.release(); return; }
        if (disclosure.seen === false && previous?.dataset.disclosureId === disclosure.id) { hint.set(previous.getBoundingClientRect().height); return; } // already drawn (an earlier read): the hint is kept as it is
        if (disclosure.seen !== false) return;
        previous?.remove(); shown = null;
        const banner = document.createElement('div'); banner.id = 'launch-disclosure-banner'; banner.dataset.disclosureId = disclosure.id; banner.className = 'notice notice-info notice-bar notice-compact'; banner.setAttribute('role', 'note');
        const { section, body } = disclosureSection('launch-disclosure-body', headline, disclosure);
        const summary = section.querySelector('summary');
        // the same quiet x as the alerts offer (#16367)
        const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'btn btn-quiet btn-icon btn-small launch-disclosure-dismiss'; dismiss.textContent = '\u00d7'; dismiss.title = 'Dismiss'; dismiss.setAttribute('aria-label', 'Dismiss, I have read this');
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
        shown = banner; placeNotice();
        window.dispatchEvent(new Event('coral:launch-disclosure-shown'));
        watchPlace(); hint.release(); hint.set(banner.getBoundingClientRect().height); // the notice now holds the room; the next load reserves it from the start
        announceNotice(headline);
    } catch { hint.release(); /* no unauthenticated or network failure is an acknowledgement; the room that was reserved for it is given back */ }
}
