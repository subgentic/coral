// The Remote access status line in Settings (moved out of settings_core.js so the start path does not carry it, #21527).
import { settingBool } from './settings_core.js';

export function renderRemoteAccessStatus(status, loadError = false) {
    const el = document.getElementById('settings-remote-access-status');
    if (!el) return;
    if (loadError) {
        el.textContent = 'Could not read the running access state. The saved value was not changed.';
        el.dataset.state = 'error';
        return;
    }
    const saved = settingBool(status?.remote_access_enabled, false);
    const effective = settingBool(status?.remote_access_effective, false);
    const box = document.getElementById('settings-remote-access-enabled');
    if (box) box.dataset.saved = saved ? '1' : '0'; // what the server has: a switch that differs from it is waiting for Save (net note, #6579)
    document.dispatchEvent(new CustomEvent('coral-remote-access-status'));
    const restart = status?.remote_access_restart_required === true || saved !== effective;
    if (restart) {
        el.textContent = `Saved: ${saved ? 'on' : 'off'}. Running: ${effective ? 'on' : 'local only'}. Restart to apply.`;
    } else {
        el.textContent = ''; // the switch already says it; only a mismatch or a risk is worth a line
    }
    // Remote access without TLS is plain HTTP (#3355): say so wherever it is, or will be, on.
    if ((effective || saved) && status?.remote_access_tls !== true) {
        el.textContent = `${el.textContent} Not encrypted: the API key, login and terminal traffic cross the network as plain HTTP. Use Coral Hub, a TLS proxy, or --tls-cert and --tls-key.`.trim();
        el.dataset.unencrypted = 'true';
    } else {
        delete el.dataset.unencrypted;
        if (effective && status?.remote_access_tls === true) el.textContent = `${el.textContent} Encrypted (HTTPS).`.trim();
    }
    // A proxy in front of a Coral that says remote access is off (#21527): a warning, red when no password stands in front of it.
    if (status?.proxy_warning?.message) {
        el.textContent = `${el.textContent} ${status.proxy_warning.message}.${status.proxy_warning.red === true && status.proxy_warning.detail ? ` ${status.proxy_warning.detail}` : ''}`.trim();
        el.setAttribute('data-proxy', status.proxy_warning.red === true ? 'red' : 'warn');
    } else {
        el.removeAttribute('data-proxy');
    }
    // Hub-only (#21558): read-only here, and through Coral Hub; changed on this computer with `coral hub-only`.
    if (status?.hub_only === true) el.textContent = `${el.textContent} Hub-only is on: this Coral is reached through Coral Hub only. To change it, run on this computer: coral hub-only off`.trim();
    el.dataset.state = restart ? 'restart-required' : 'current';
}
