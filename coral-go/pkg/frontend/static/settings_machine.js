/* The Settings dialog's machine-only rows: the API key, the telemetry install ID and the database encryption choice (moved out of settings_dialog.js, #8374; no behaviour change). */
import { copyText } from './utils.js';
import { isCloud } from './server_base.js';
import { requestJson } from './api.js';

// ── Settings: API key (#3152) ─────────────────────────────────────────────
// Masked at full width with Show and Copy; a status message (not configured,
// not available) is shown as plain text with the controls off.

export function _setApiKey(input, key, message) {
    const show = document.getElementById('settings-api-key-show');
    const copy = document.getElementById('settings-api-key-copy');
    input.value = key || message;
    input.type = key ? 'password' : 'text';
    if (show) { show.hidden = !key; show.textContent = 'Show'; show.setAttribute('aria-pressed', 'false'); }
    if (copy) copy.disabled = !key;
}

export function _wireApiKeyControls(input) {
    if (input.dataset.wired) return;
    input.dataset.wired = '1';
    const show = document.getElementById('settings-api-key-show');
    const copy = document.getElementById('settings-api-key-copy');
    show?.addEventListener('click', () => {
        const reveal = input.type === 'password';
        input.type = reveal ? 'text' : 'password';
        show.textContent = reveal ? 'Hide' : 'Show';
        show.setAttribute('aria-pressed', String(reveal));
    });
    copy?.addEventListener('click', async () => {
        const ok = await copyText(input.value);
        copy.textContent = ok ? 'Copied!' : 'Copy failed';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    });
}

// The deletion-request ID is read only when Settings opens, even if analytics is off.
export async function loadTelemetryInstallID() {
    const input = document.getElementById('settings-telemetry-install-id');
    const copy = document.getElementById('settings-telemetry-install-copy');
    const status = document.getElementById('settings-telemetry-install-status');
    const hint = document.getElementById('settings-telemetry-install-hint'); // "Send it with a deletion request.": only when there is an ID to send (#7040)
    if (!input || !copy || isCloud()) return;
    input.textContent = 'Loading…';
    copy.disabled = true; copy.hidden = false;
    if (status) status.textContent = '';
    if (!copy.dataset.wired) {
        copy.dataset.wired = '1';
        copy.addEventListener('click', async () => {
            if (copy.disabled) return;
            const ok = await copyText(input.textContent);
            if (status) status.textContent = ok ? 'Install ID copied.' : 'Could not copy. Select the ID and copy it.';
        });
    }
    try {
        const data = await requestJson('GET', '/api/system/telemetry');
        const available = data.install_id_status === 'available' && typeof data.install_id === 'string' && data.install_id.length > 0;
        input.textContent = available ? data.install_id : data.install_id_status === 'missing' ? 'Not created yet' : 'Install ID unavailable.'; // not 'No install ID has been created.': that reads as an error, and nothing is wrong (#9955)
        copy.disabled = !available; copy.hidden = data.install_id_status === 'missing'; // nothing to copy: no Copy button either
        if (hint) hint.hidden = !available;
    } catch (_) {
        input.textContent = 'Install ID unavailable.';
        if (hint) hint.hidden = true;
    }
}


function renderDatabaseEncryptionStatus(status, loadError = false) {
    const select = document.getElementById('settings-database-encryption');
    const hint = document.getElementById('settings-database-encryption-status');
    if (!select || !hint) return;
    // A build without database encryption has nothing to choose: the row is not shown (UI audit #5589, finding 17),
    // and a save leaves the setting alone (the select is disabled).
    const unsupported = loadError || !status || status.encryption_compiled === false;
    select.dataset.unsupported = unsupported ? '1' : ''; // the field's visibleWhen reads it, so a redraw of the rows keeps the row hidden
    const row = select.closest('.sv-row');
    if (row) row.hidden = unsupported;
    if (loadError || !status) {
        select.disabled = true; select.dataset.locked = '1';
        hint.textContent = 'Database encryption settings are unavailable in this server build.';
        return;
    }
    const mode = status.saved_mode || status.effective_mode || 'disabled';
    select.value = mode;
    select.dataset.shown = mode; // what Save compares with, to tell a changed choice from none
    const locked = status.feature_available === false || status.encryption_compiled === false;
    select.disabled = locked;
    select.dataset.locked = locked ? '1' : ''; // the field's disabledWhen reads it: a redraw of the rows keeps the choice off
    const effective = status.effective_mode || 'disabled';
    const restart = status.restart_required === true;
    const surface = status.unlock_surface || 'unknown';
    const capability = status.encryption_compiled === false
        ? ' Experimental database encryption is not included in this standard build.'
        : status.feature_available === false ? ' Encryption is unavailable in this build.' : ' Database encryption is experimental.';
    hint.textContent = `Saved: ${mode}; running: ${effective}${restart ? '; restart required' : ''}. Unlock: ${surface}.${capability}`;
}

export async function loadDatabaseEncryptionStatus() {
    try {
        const status = await requestJson('GET', '/api/system/database-security');
        renderDatabaseEncryptionStatus(status);
        return status;
    } catch (_) {
        renderDatabaseEncryptionStatus(null, true);
        return null;
    }
}

// True when the database encryption choice differs from what the dialog showed.
export function databaseEncryptionChanged() {
    const select = document.getElementById('settings-database-encryption');
    return Boolean(select) && !select.disabled && select.dataset.shown !== undefined && select.value !== select.dataset.shown;
}

export async function saveDatabaseEncryptionSettings() {
    const select = document.getElementById('settings-database-encryption');
    if (!select || select.disabled) return true;
    const mode = select.value;
    const resp = await fetch('/api/system/database-security', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
    });
    if (!resp.ok) throw new Error(`database security save failed (${resp.status})`);
    const status = await resp.json();
    renderDatabaseEncryptionStatus(status);
    return true;
}




