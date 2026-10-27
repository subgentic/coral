/* Team settings in a popout modal (#8853, Goal #72): Workflow, Health check, Messaging and Prompts (the settings_view of team_settings_page.js) open over whatever page is on screen, from the sidebar menu's
 * Team settings item and the team page's Settings button; the team page has no Settings tab. The dialog is the shared one (modal_chrome.js registerDialog): Escape, a click outside and the Close button ask
 * whether unsaved changes may go (the confirm dialog), Tab stays inside, focus returns to what opened it, and on a phone it fills the screen. One at a time: opening it again focuses the open one. */
import { importOnce } from './import_once.js';
import { keyLabel } from './server_base.js';
import { registerDialog, closeDialog } from './modal_chrome.js';

let open = null; // { team, modal }

/** Open the team's settings. Resolves true when the dialog is up (or was already for this team). */
export async function openTeamSettings(team) {
    const key = String(team || '');
    if (!key) return false;
    const { hasUnsavedTeamSettings, confirmTeamWorkspaceChange, showTeamWorkingMode } = await importOnce('./team_working_mode.js'); // a lazy module loads the others it needs through importOnce, so a failed load is retried
    if (open && open.modal.isConnected) {
        if (open.team === key) { open.modal.querySelector('.sv-nav button, button, [tabindex]')?.focus(); return true; }
        if (hasUnsavedTeamSettings() && !(await confirmTeamWorkspaceChange())) return false; // another team's settings while this one holds edits: ask first
        closeDialog(open.modal);
    }
    const modal = document.createElement('div');
    modal.className = 'modal team-settings-modal';
    modal.style.display = 'flex'; // display-ok: a script-built dialog is shown as the shared .modal flex box (modal_chrome.js hides it by display none, as every dialog)
    modal.innerHTML = `<div class="modal-content team-settings-dialog">
        <div class="modal-header"><h3></h3><button type="button" class="modal-close-btn" aria-label="Close team settings" title="Close"><span class="material-icons" aria-hidden="true">close</span></button></div>
        <div class="modal-body team-settings-dialog-body"><div class="team-settings-host" id="team-panel-settings"></div></div>
    </div>`;
    modal.querySelector('h3').textContent = `Team settings: ${keyLabel(key)}`;
    document.body.appendChild(modal);
    const close = registerDialog(modal, { beforeClose: async () => !hasUnsavedTeamSettings() || await confirmTeamWorkspaceChange(), onClose: () => { document.removeEventListener('keydown', keepIn, true); document.removeEventListener('keyup', keepIn, true); if (open && open.modal === modal) open = null; } });
    modal.querySelector('.modal-close-btn').addEventListener('click', () => close());
    // Tab stays inside: the page-wide trap (modal_chrome.js) wraps at the first and last stop it computes, but the browser can still walk past the dialog (a disclosure's summary at the end, a roving-tabindex tab the pointer
    // chose). After a Tab key, if focus is outside the dialog (and no other dialog, the unsaved question, is the one asked), it goes back to the dialog's first stop, or its last with Shift.
    const stopsOf = () => [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], summary, [tabindex]')].filter(el => el.tabIndex >= 0 && el.getClientRects().length > 0);
    let backwards = false;
    const keepIn = (e) => {
        if (e.key !== 'Tab') return;
        if (e.type === 'keydown') { backwards = e.shiftKey; return; }
        if (!modal.isConnected || modal.contains(document.activeElement)) return;
        const other = document.activeElement && document.activeElement.closest && document.activeElement.closest('.modal');
        if (other && other !== modal) return; // the unsaved question is above this dialog
        const stops = stopsOf();
        if (stops.length) stops[backwards ? stops.length - 1 : 0].focus();
    };
    document.addEventListener('keydown', keepIn, true); document.addEventListener('keyup', keepIn, true);
    open = { team: key, modal };
    try {
        await showTeamWorkingMode(key, { page: modal.querySelector('.team-settings-host'), closeDialog: () => close() });
    } catch (e) {
        console.error('team settings', e);
        modal.querySelector('.team-settings-host').textContent = 'Team settings could not be shown. Close this and try again.';
    }
    modal.querySelector('.sv-nav button, .team-settings-host button, .team-settings-host [tabindex]')?.focus();
    return true;
}
