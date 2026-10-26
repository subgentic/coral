/* The Settings dialog's "Trust Coral's hooks in Codex" row (moved out of settings_dialog.js, #8374; no behaviour change). */
import { showToast } from './utils.js';

// "Trust Coral's hooks in Codex" (#153): written only by its own route on this computer (never PUT /api/settings, never
// through Coral Hub), so it is saved as soon as it changes and is not part of the Save payload. The line under it says
// whether Coral trusts its hooks now, and why not (a tools folder this user can change, a platform other than Windows).
export async function loadCodexTrustHooks() {
    const box = document.getElementById('settings-codex-trust-hooks');
    if (!box) return;
    let status = document.getElementById('settings-codex-trust-hooks-status');
    if (!status) {
        status = document.createElement('span');
        status.id = 'settings-codex-trust-hooks-status';
        status.className = 'toggle-desc';
        document.getElementById('settings-codex-trust-hooks-desc')?.after(status);
    }
    const show = (s) => {
        box.checked = !!s.trust;
        status.textContent = s.trusted ? "Now: new Codex agents start with Coral's hooks trusted."
            : (s.trust && s.why ? `Now: Codex will ask (${s.why}).` : '');
    };
    try {
        const r = await fetch('/api/system/codex-trust-hooks');
        if (r.ok) show(await r.json());
    } catch { /* the box stays as drawn */ }
    if (box.dataset.wired) return;
    box.dataset.wired = '1';
    box.addEventListener('change', async () => {
        try {
            const r = await fetch('/api/system/codex-trust-hooks', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trust: box.checked }),
            });
            if (!r.ok) throw new Error(String(r.status));
            show(await r.json());
        } catch {
            box.checked = !box.checked;
            showToast("Couldn't change whether Coral trusts its hooks in Codex", 'error');
        }
    });
}
