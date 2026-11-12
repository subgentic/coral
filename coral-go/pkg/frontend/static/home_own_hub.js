/* The "Run your own hub" box on Home is one control: it opens the panel (editions.js, the explainer) and the panel holds the switch (#15061, the Operator: no buttons on the home screen). This module draws
 * the box's small "On" and the panel's switch from the real state. It is a SHORTCUT to Settings > Run as a hub, not a second implementation: the same route (GET/PUT /api/system/hub-mode, which answers
 * only the dashboard on this computer, never Coral Hub, never an agent or another local user) and the same restart, through hub_mode_setting.js. Turning it on asks first and says what it does; turning it
 * off is one press. If the state cannot be read (an older server, another computer) the switch is off and disabled, and the panel says so. */
import { importOnce } from './import_once.js';
import { loadStyles } from './lazy_styles.js';

const CONFIRM = 'This Coral becomes a hub: a Computers tab where you add other computers and manage their agents. Whoever signs in to this Coral controls every computer you add. It uses this Coral\u2019s own address, port and sign-in, so who can reach it stays what Remote access in Settings > Network and Hub says; nothing new listens. It applies when Coral restarts. You can turn it off here or in Settings > Network and Hub.';

let _st = null;
const on = st => !!(st && (st.saved || st.forced));
const plain = e => String((e && e.message) || e).replace(/[.\s]+$/, ''); // a message that ends with a full stop is not given a second one
const panel = () => document.getElementById('editions-own-slot');
const q = sel => panel()?.querySelector(sel);

function sentence(st) {
    if (!st) return 'Not available on this Coral.'; // an older server, or another computer: the route answers nothing here
    if (st.forced) return 'On: Coral was started with --hub.';
    if (st.restart_required) return (st.saved ? 'Saved: this Coral becomes a hub when it restarts.' : 'Saved: this Coral stops being a hub when it restarts.') + (st.can_restart ? '' : ' Quit Coral and start it again to apply.');
    return st.running ? 'On: this Coral is a hub (the Computers tab).' : 'Off. Turning it on asks first.';
}

function draw(st, note = '') {
    _st = st;
    const title = document.getElementById('editions-home-own-title'), chip = document.getElementById('editions-home-own-state'); // the box says On when it is (the chip is there only then)
    if (title && on(st) && !chip) { const c = document.createElement('span'); c.className = 'chip'; c.id = 'editions-home-own-state'; c.textContent = 'On'; title.append(' ', c); }
    else if (chip && !on(st)) { chip.previousSibling?.remove?.(); chip.remove(); }
    const sw = q('input.own-hub-switch'); if (!sw) return;
    sw.checked = on(st); sw.disabled = !st || !!st.forced; // forced: started with --hub, only a restart without it changes that
    q('.own-hub-state').textContent = [note, sentence(st)].filter(Boolean).join(' ');
    q('[data-own="restart"]').hidden = !(st && !st.forced && st.restart_required && st.can_restart);
    q('[data-own="manage"]').hidden = !on(st);
}

/** Read the state into the box's "On" (called when the home section is shown). */
export async function syncOwnHub() {
    try { const m = await importOnce('./hub_mode_setting.js'); draw(await m.readHubMode()); } catch { draw(null); }
}

async function apply(want) {
    const sw = q('input.own-hub-switch'); sw.disabled = true;
    try { const m = await importOnce('./hub_mode_setting.js'); draw(await m.saveHubMode(want)); }
    catch (e) { draw(_st, `Not saved: ${plain(e)}.`); }
    finally { sw.focus(); }
}

async function toggled(sw) {
    const want = sw.checked; sw.disabled = true;
    try { const m = await importOnce('./hub_mode_setting.js'); _st = await m.readHubMode(); } catch { _st = null; } // the route's own answer, never a stale page
    if (!_st || on(_st) === want) { draw(_st); sw.focus(); return; }
    if (!want) { await apply(false); return; }
    const { showConfirmModal } = await importOnce('./confirm_dialog.js');
    showConfirmModal('Run as a hub on this computer?', CONFIRM, () => apply(true), () => { draw(_st); sw.focus(); }, { label: 'Enable on this computer', cancelLabel: 'Cancel', danger: false });
}

/** Draws the switch into the panel's slot and reads the state into it (editions.js opens the panel). */
export async function mountOwnHubPanel() {
    const slot = panel(); if (!slot) return;
    await loadStyles('home_own_hub.css');
    slot.innerHTML = `<div class="own-hub-row"><label class="own-hub-text" for="own-hub-switch"><strong>Run a hub on this computer</strong> <span class="own-hub-state" role="status" aria-live="polite">Checking\u2026</span></label><span class="check-hit"><input class="switch own-hub-switch" type="checkbox" id="own-hub-switch" disabled></span></div>
        <div class="own-hub-actions"><button type="button" class="btn" data-own="restart" hidden>Restart Coral</button><button type="button" class="btn" data-own="manage" hidden>Manage in Settings</button></div>`;
    q('input.own-hub-switch').addEventListener('change', e => toggled(e.target));
    q('[data-own="manage"]').addEventListener('click', () => { document.getElementById('editions-modal')?.querySelector('[data-editions="done-own"]')?.click(); window.showSettingsModal?.('network'); });
    q('[data-own="restart"]').addEventListener('click', async e => {
        const b = e.currentTarget; b.disabled = true;
        try { const m = await importOnce('./hub_mode_setting.js'); await m.restartForHubMode(on(_st)); q('.own-hub-state').textContent = 'Restarting Coral\u2026'; }
        catch (err) { b.disabled = false; draw(_st, `Could not restart: ${plain(err)}.`); }
    });
    await syncOwnHub();
}
