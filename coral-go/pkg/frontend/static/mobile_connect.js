/* Mobile connection flow: saved preference is not proof of effective access. */
import { state } from './state.js';
import { importOnce } from './import_once.js';
const { ENABLE_LABEL, USE_HUB_LABEL, DISABLED_WORDS, OPEN_ON_PHONE, SAME_NETWORK, SETUP_CODE_WHERE, NO_SETUP_CODE, SHOW_CODE, HIDE_CODE, CODE_SHOW_MS, setupCodeHint } = await importOnce('./mobile_words.js'); // this file is loaded lazily: a module it needs is loaded through importOnce, so a failure can be retried

let generation = 0;
let controller = null;
let opener = null;
let saving = false;

const byId = id => document.getElementById(id);
const current = gen => gen === generation && byId('mobile-connect-modal')?.style.display !== 'none';

let codeTimer = 0;
function clearConnection() {
    clearTimeout(codeTimer); codeTimer = 0;
    byId('mobile-connect-setup')?.replaceChildren(); // a shown setup code never outlives the connection it belongs to
    byId('mobile-connect-details').hidden = true;
    byId('mobile-connect-qr').replaceChildren();
    byId('mobile-connect-api-key').replaceChildren();
    byId('mobile-connect-url').textContent = '';
}

function button(label, action, primary = false) {
    const node = document.createElement('button');
    node.type = 'button'; node.className = primary ? 'btn btn-primary' : 'btn';
    node.textContent = label; node.addEventListener('click', action);
    return node;
}

function renderState(message, actions = [], error = false) {
    clearConnection();
    const status = byId('mobile-connect-status');
    status.textContent = message;
    status.setAttribute('role', error ? 'alert' : 'status');
    const controls = byId('mobile-connect-actions');
    const content = byId('mobile-connect-modal').querySelector('.modal-content');
    // The dialog's own box holds the focus until it has an action (opening it, a state with none): the first action takes it.
    const hadFocus = controls.contains(document.activeElement) || document.activeElement === content;
    controls.replaceChildren(...actions);
    if (hadFocus) (actions[0] || content).focus();
}

function failure(message) {
    renderState(message, [button('Retry', checkAccess, true), button('Cancel', hideMobileConnectModal)], true);
}

export function hideMobileConnectModal() {
    ++generation; controller?.abort(); controller = null; saving = false;
    const modal = byId('mobile-connect-modal');
    if (modal) { modal.style.display = 'none'; clearConnection(); }
    if (opener?.isConnected) opener.focus();
}

async function privacy(signal) {
    const response = await fetch('/api/system/privacy', { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not check mobile access (${response.status}).`);
    const status = await response.json();
    if (typeof status.remote_access_enabled !== 'boolean' || typeof status.remote_access_effective !== 'boolean') {
        throw new Error('Could not verify the running mobile access state.');
    }
    return status;
}

function rememberStatus(status) {
    state.privacyStatus = status;
    state.settings = { ...state.settings, remote_access_enabled: status.remote_access_enabled };
    const checkbox = byId('settings-remote-access-enabled');
    if (checkbox) checkbox.checked = status.remote_access_enabled;
}

async function renderAccess(status, gen, signal) {
    if (!current(gen)) return;
    rememberStatus(status);
    if (!status.remote_access_enabled && status.remote_access_effective) {
        renderState('Mobile access is disabled in settings. Restart Coral to finish disabling access on the running server.',
            [button('Check again', checkAccess, true), button('Close', hideMobileConnectModal)]);
        return;
    }
    if (!status.remote_access_effective) {
        if (status.remote_access_enabled) {
            renderState('Mobile access is enabled in settings but is not running yet. Restart Coral to apply the change, then check again.',
                [button('Check again', checkAccess, true), button('Close', hideMobileConnectModal)]);
        } else {
            renderState(DISABLED_WORDS,
                [button(ENABLE_LABEL, enableMobileAccess, true), button(USE_HUB_LABEL, useCoralHub), button('Cancel', hideMobileConnectModal)]);
        }
        return;
    }

    renderState('Loading mobile connection…', [button('Cancel', hideMobileConnectModal)]);
    const [networkResponse, keyResponse] = await Promise.all([
        fetch('/api/system/network-info', { signal }),
        fetch('/api/system/api-key', { signal }),
    ]);
    // Without a sign-in the server refuses the key (and the details): say how to see them, with no QR and no key shown.
    if ([networkResponse, keyResponse].some(r => r.status === 401 || r.status === 403)) {
        renderState('Sign in to see the API key (run: coral open)', [button('Close', hideMobileConnectModal)]);
        return;
    }
    if (!networkResponse.ok || !keyResponse.ok) throw new Error('Could not load the mobile connection details.');
    const [network, key] = await Promise.all([networkResponse.json(), keyResponse.json()]);
    if (!current(gen)) return;
    if (network.remote_access_effective === false) throw new Error('Mobile access is not running. Check again after restarting Coral.');
    let baseUrl = window.location.origin;
    const address = network.primary || network.ips?.[0];
    // With native TLS, other devices must use https (#3355).
    const scheme = network.scheme === 'https' ? 'https' : 'http';
    if (address) baseUrl = `${scheme}://${address}:${network.port || window.location.port || '8420'}`;
    byId('mobile-connect-status').textContent = '';
    byId('mobile-connect-actions').replaceChildren();
    byId('mobile-connect-url').textContent = baseUrl;
    const image = document.createElement('img');
    image.alt = 'QR code for mobile connection';
    image.style.cssText = 'width:180px;height:180px;border-radius:8px;background:#fff;padding:8px';
    image.addEventListener('error', () => {
        if (current(gen)) failure('Could not load the mobile QR code.');
    });
    image.src = `/api/system/qr?url=${encodeURIComponent(baseUrl)}`;
    byId('mobile-connect-qr').append(image);
    const keyDisplay = byId('mobile-connect-api-key');
    keyDisplay.style.display = key.key ? '' : 'none';
    if (key.key) {
        const label = document.createElement('strong'); label.textContent = 'API Key: ';
        const code = document.createElement('code'); code.textContent = key.key; code.style.userSelect = 'all';
        const copy = button('Copy', async () => {
            try { await navigator.clipboard.writeText(key.key); copy.textContent = 'Copied!'; }
            catch { copy.textContent = 'Select key to copy'; }
        });
        copy.classList.add('btn-small'); copy.style.marginLeft = '6px';
        keyDisplay.append(label, code, copy);
        const hint = document.createElement('div');
        hint.className = 'text-secondary-sm'; hint.textContent = 'Use this key to connect securely from your phone.';
        keyDisplay.append(hint);
    }
    byId('mobile-connect-open').textContent = OPEN_ON_PHONE;
    byId('mobile-connect-network').textContent = SAME_NETWORK;
    byId('mobile-connect-details').hidden = false;
    renderSetupCode(gen, signal); // after the details are up: the QR and the address first, the code when it arrives
}

/** "Use Coral Hub instead": the dialog closes and Settings opens on Network and Hub, where the Hub link is made. It changes nothing by itself. */
function useCoralHub() {
    hideMobileConnectModal();
    window.showSettingsModal?.('network');
}

/** The setup code, in the one panel (#10149): where a phone types it, and the code itself behind a button (not on the screen until asked, read aloud letter by letter, gone after a minute, as in Settings).
 *  The route answers only a dashboard signed in on this computer, and only while there is a code (no password yet); otherwise the panel says the phone signs in with the password. */
async function renderSetupCode(gen, signal) {
    const box = byId('mobile-connect-setup');
    if (!box) return;
    let code = '', expires = 0;
    try {
        const r = await fetch('/api/auth/setup-code/show', { signal, cache: 'no-store' });
        if (r.ok) { const d = await r.json(); if (d && typeof d.code === 'string' && d.code) { code = d.code; expires = d.expires_in; } }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    if (!current(gen)) return;
    const line = text => { const p = document.createElement('p'); p.className = 'text-secondary-sm'; p.textContent = text; return p; };
    if (!code) { box.replaceChildren(line(NO_SETUP_CODE)); return; }
    const { spellCode } = await importOnce('./cloud_words.js');
    if (!current(gen)) return;
    const title = document.createElement('strong'); title.textContent = 'Setup code';
    const reveal = button(SHOW_CODE, () => (shown.hidden ? show() : hide()));
    reveal.classList.add('btn-small'); reveal.setAttribute('aria-expanded', 'false');
    const shown = document.createElement('div'); shown.hidden = true;
    const codeEl = document.createElement('code'); codeEl.className = 'mobile-connect-code'; codeEl.style.userSelect = 'all';
    const spoken = document.createElement('span'); spoken.className = 'sr-only';
    const hint = line(SETUP_CODE_WHERE);
    shown.append(codeEl, spoken);
    const hide = () => {
        clearTimeout(codeTimer); codeTimer = 0;
        codeEl.textContent = ''; spoken.textContent = ''; shown.hidden = true;
        reveal.textContent = SHOW_CODE; reveal.setAttribute('aria-expanded', 'false'); hint.textContent = SETUP_CODE_WHERE;
    };
    const show = () => {
        codeEl.textContent = code; spoken.textContent = `Setup code: ${spellCode(code)}`; shown.hidden = false;
        reveal.textContent = HIDE_CODE; reveal.setAttribute('aria-expanded', 'true'); hint.textContent = `${SETUP_CODE_WHERE} ${setupCodeHint(expires)}`;
        clearTimeout(codeTimer); codeTimer = setTimeout(hide, CODE_SHOW_MS); // timeout-ok: the code leaves the screen by itself
    };
    box.replaceChildren(title, ' ', reveal, shown, hint);
}

async function checkAccess() {
    controller?.abort(); controller = new AbortController();
    const signal = controller.signal;
    const gen = ++generation;
    renderState('Checking mobile access…', [button('Cancel', hideMobileConnectModal)]);
    try { await renderAccess(await privacy(signal), gen, signal); }
    catch (error) { if (current(gen) && error.name !== 'AbortError') failure(error.message); }
}

async function enableMobileAccess() {
    if (saving) return;
    saving = true;
    controller?.abort(); controller = new AbortController();
    const signal = controller.signal;
    const gen = ++generation;
    renderState('Enabling mobile access…');
    try {
        const response = await fetch('/api/settings', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ remote_access_enabled: true }), signal,
        });
        if (!response.ok) throw new Error(`Could not enable mobile access (${response.status}).`);
        // Re-read actual runtime state; saving a preference does not activate it.
        await renderAccess(await privacy(signal), gen, signal);
    } catch (error) {
        if (current(gen) && error.name !== 'AbortError') failure(error.message);
    } finally { if (gen === generation) saving = false; }
}

export async function showMobileConnectModal() {
    const modal = byId('mobile-connect-modal');
    if (!modal) return;
    if (modal.style.display === 'none') opener = document.activeElement;
    modal.style.display = 'flex'; saving = false;
    (modal.querySelector('#mobile-connect-actions button') || modal.querySelector('.modal-content'))?.focus();
    await checkAccess();
}
