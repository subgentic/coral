/* Settings opens on a short list, Basics, and the rest is one click away behind Advanced (#10114, Desktop tester #10113: a newcomer needs about 8 of roughly 60 settings in week one). Nothing is removed: every row is
 * still in its pane, hidden by CSS until Advanced is on, and a group opened by name (a link, a missing CLI) turns Advanced on first. A row is Basic when its key is in BASIC; a pane with no Basic row is
 * Advanced-only: its tab and its place in the section list are drawn only with Advanced on. The choice is remembered in this browser. No imports from modals.js (settings_nav.js imports this). */
import { browserLocal } from './safe_storage.js';
import { storeKey } from './local_store.js';

const KEY = 'coral-settings-advanced';

/** The rows a newcomer needs, by the key the field is drawn with (settings_fields.js): Theme, the update notice, the default permission mode and the default models, notifications, the phone's remote access and setup code,
 *  the password, and usage analytics. A heading is Basic when the rows under it are. */
export const BASIC = new Set([
    'theme', 'check_updates',
    'agents_defaults', 'permission_mode', 'default_models', 'default_model_claude', 'default_model_codex', 'default_model_agy', 'default_model_pi', 'default_models_notice',
    'notify_needs_input', 'desktop_notify',
    'remote_access', 'net_setup_title', 'live_net-group-setup',
    'security_access_title', 'live_settings-security', 'security_data_title', 'telemetry_enabled',
]);
/** Panes that are Basic as a whole (they have no key list: the Updates pane draws itself). */
const BASIC_PANES = new Set(['updates']);

const modalEl = () => document.getElementById('settings-modal');
let on = false;
try { on = browserLocal.get(storeKey(KEY)) === '1'; } catch { /* a person who cannot store it starts on Basics */ }

export const advancedOn = () => on;

/** Whether a pane has nothing Basic to show: its tab is drawn with Advanced only. */
export const advancedOnly = pane => pane.dataset.advancedOnly === '1';

/** Tag each row and fold with its level, and each pane with whether it is Advanced-only. Safe to call again as rows are drawn. */
export function tagLevels(root = modalEl()) {
    if (!root) return;
    for (const pane of root.querySelectorAll('.settings-pane')) {
        const rows = [...pane.querySelectorAll('[data-key]')];
        if (BASIC_PANES.has(pane.dataset.group)) { delete pane.dataset.advancedOnly; continue; }
        if (!rows.length) continue; // not drawn yet
        let basic = 0, advanced = 0;
        for (const r of rows) {
            if (BASIC.has(r.dataset.key)) { delete r.dataset.level; basic++; } else { r.dataset.level = 'advanced'; advanced++; }
        }
        for (const fold of pane.querySelectorAll('details.sv-fold')) { // a fold of rows is Advanced when none of its rows is Basic
            if ([...fold.querySelectorAll('[data-key]')].every(r => r.dataset.level === 'advanced')) fold.dataset.level = 'advanced'; else delete fold.dataset.level;
        }
        if (basic) delete pane.dataset.advancedOnly; else pane.dataset.advancedOnly = '1';
        if (advanced) pane.setAttribute('data-has-advanced', '1'); else pane.removeAttribute('data-has-advanced');
    }
}

/** Turn Advanced on or off; the modal, the section list and every pane follow (onChange runs after, to redraw the tabs). */
export function setAdvanced(next, onChange) {
    on = !!next;
    try { browserLocal.set(storeKey(KEY), on ? '1' : '0'); } catch { /* not remembered */ }
    modalEl()?.toggleAttribute('data-advanced', on);
    for (const b of document.querySelectorAll('[data-settings-advanced-toggle]')) { b.setAttribute('aria-expanded', String(on)); const w = b.querySelector('.settings-advanced-word'); if (w) w.textContent = on ? 'Fewer settings' : 'Advanced'; }
    onChange?.();
}

/** The buttons: one under the section list, and one at the foot of each pane that has rows hidden by Basics. */
export function buildAdvancedToggles(modal, onChange) {
    const nav = modal.querySelector('.settings-nav');
    const make = cls => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = cls; b.setAttribute('data-settings-advanced-toggle', ''); b.setAttribute('aria-expanded', String(on));
        b.innerHTML = '<span class="material-icons" aria-hidden="true">tune</span><span class="settings-advanced-word"></span>';
        b.querySelector('.settings-advanced-word').textContent = on ? 'Fewer settings' : 'Advanced';
        b.addEventListener('click', () => setAdvanced(!on, onChange));
        return b;
    };
    if (nav && !nav.querySelector('.settings-advanced-toggle')) nav.append(make('settings-advanced-toggle btn btn-quiet'));
    for (const pane of modal.querySelectorAll('.settings-pane')) {
        if (!pane.querySelector('.settings-advanced-more')) { const b = make('settings-advanced-more btn btn-quiet'); pane.append(b); }
    }
    modal.toggleAttribute('data-advanced', on);
}

/** A missing CLI is said where its path is set: Advanced on and the CLI paths fold open (a person told to install a CLI is not left looking for the row). */
export function openCliPathsIfMissing(modal, onChange) {
    const fold = [...modal.querySelectorAll('details.sv-fold')].find(f => f.querySelector('[data-key^="cli_path_"]'));
    if (!fold || !fold.querySelector('[data-blocks-launch]')) return false;
    if (!on) setAdvanced(true, onChange);
    fold.open = true;
    return true;
}
