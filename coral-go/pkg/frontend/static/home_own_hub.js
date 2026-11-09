/* The home page's "Run your own hub" box can turn it on for this computer right there (#14976, the Operator: it was buried in Settings). It is a SHORTCUT to Settings > Run as a hub, not a second
 * implementation: the same route (GET/PUT /api/system/hub-mode, which answers only the dashboard on this computer, never Coral Hub, never an agent or another local user) and the same restart, through
 * hub_mode_setting.js. Turning it on asks first and says what it does; turning it off is one press. If the state cannot be read (an older server, another computer) the box is what it was: the explainer only. */
import { importOnce } from './import_once.js';

const root = () => document.getElementById('editions-home-own');
const q = sel => root()?.querySelector(sel);
const act = name => q(`[data-editions="${name}"]`);
let _st = null;

const CONFIRM = 'This Coral becomes a hub: a Computers tab where you add other computers and manage their agents. Whoever signs in to this Coral controls every computer you add. It uses this Coral\u2019s own address, port and sign-in, so who can reach it stays what Remote access in Settings > Network and Hub says; nothing new listens. It applies when Coral restarts. You can turn it off here or in Settings > Network and Hub.';

function draw(st, note = '') {
    _st = st;
    const state = document.getElementById('editions-home-own-state');
    if (!state || !root()) return;
    const on = !!(st && (st.saved || st.forced));
    let text = '';
    if (st) {
        if (st.forced) text = 'On: Coral was started with --hub.';
        else if (st.restart_required) text = (st.saved ? 'Saved: this Coral becomes a hub when it restarts.' : 'Saved: this Coral stops being a hub when it restarts.') + (st.can_restart ? '' : ' Quit Coral and start it again to apply.');
        else if (st.running) text = 'On: this Coral is a hub (the Computers tab).';
    }
    state.textContent = [note, text].filter(Boolean).join(' ');
    const show = (name, yes) => { const b = act(name); if (b) b.hidden = !yes; };
    show('enable-hub', !!st && !on);
    show('restart-hub', !!st && !st.forced && st.restart_required && st.can_restart);
    show('disable-hub', !!st && on && !st.forced);
    show('manage-hub', !!st && on);
}

/** Read the state into the box (called when the home section is shown). */
export async function syncOwnHub() {
    if (!root()) return;
    try { const m = await importOnce('./hub_mode_setting.js'); draw(await m.readHubMode()); } catch { draw(null); }
}

async function change(on, button) {
    button.disabled = true;
    try { const m = await importOnce('./hub_mode_setting.js'); draw(await m.saveHubMode(on)); }
    catch (e) { draw(_st, `Not saved: ${e.message}.`); }
    finally { button.disabled = false; }
}

document.addEventListener('click', async e => {
    const t = e.target && e.target.closest && e.target.closest('#editions-home-own [data-editions]');
    if (!t) return;
    const action = t.dataset.editions;
    if (action === 'enable-hub') {
        e.preventDefault(); e.stopPropagation();
        const { showConfirmModal } = await importOnce('./confirm_dialog.js');
        showConfirmModal('Run as a hub on this computer?', CONFIRM, () => change(true, t), null, { label: 'Enable on this computer', cancelLabel: 'Cancel', danger: false });
    } else if (action === 'disable-hub') { e.preventDefault(); e.stopPropagation(); change(false, t); }
    else if (action === 'restart-hub') {
        e.preventDefault(); e.stopPropagation(); t.disabled = true;
        try { const m = await importOnce('./hub_mode_setting.js'); await m.restartForHubMode(!!(_st && (_st.saved || _st.forced))); document.getElementById('editions-home-own-state').textContent = 'Restarting Coral\u2026'; }
        catch (err) { t.disabled = false; draw(_st, `Could not restart: ${err.message}.`); }
    } else if (action === 'manage-hub') { e.preventDefault(); e.stopPropagation(); window.showSettingsModal?.('network'); }
}, true);
