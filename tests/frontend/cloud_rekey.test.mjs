// #3698: Settings > Coral Hub and remote access offers to replace a refused secret key, says what that discards,
// asks first, and only then posts {"confirm": true}. jsdom, no browser: node cloud_rekey.test.mjs
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
const domErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => domErrors.push(error));

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '../../coral-go/pkg/frontend/static');
const dom = new JSDOM(`<!doctype html><body>
  <div id="panel">
    <div data-cloud="status"></div>
    <button data-cloud="connect" hidden></button><button data-cloud="disconnect" hidden></button>
    <div data-cloud="rekey-row" hidden><div data-cloud="rekey-text"></div><button data-cloud="rekey">Replace the secret key</button></div>
  </div>
  <div id="confirm-modal" style="display:none"><h3 id="confirm-modal-title"></h3><p id="confirm-modal-message"></p><button id="confirm-modal-yes">Yes</button></div>
</body>`, { url: 'http://127.0.0.1:8420/', virtualConsole });
for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'sessionStorage', 'getComputedStyle', 'Element', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'MutationObserver']) {
    Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
}

const refused = { state: 'refused', exposed: true, remote_server_keys: 2, hub_url: 'https://hub.example.com' };
let status = { state: 'idle', configured: true, hub_url: 'https://hub.example.com' };
const posts = [];
globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (method === 'POST' && url === '/api/cloud/rekey') {
        posts.push(JSON.parse(opts.body));
        status = { state: 'idle', configured: true, hub_url: 'https://hub.example.com' };
        return { ok: true, status: 200, json: async () => ({ ok: true, discarded_remote_server_keys: 2, discarded_hub_enrollment: true, status }) };
    }
    return { ok: true, status: 200, json: async () => status };
};

const m = await import(pathToFileURL(path.join(dir, 'cloud_connect.js')).href);
const tick = () => new Promise((r) => setTimeout(r, 20));
const part = (role) => document.querySelector(`[data-cloud="${role}"]`);

// The text says why and lists what is lost.
const text = m.rekeyText(refused);
assert.match(text, /Other accounts on this computer could read/);
assert.match(text, /https:\/\/hub\.example\.com/);
assert.match(text, /2 remote computers' API keys/);
assert.match(m.rekeyText({ state: 'refused', remote_server_keys: 1, message: 'bad file' }), /bad file.*1 remote computer's API key/s);
assert.match(m.rekeyText({ state: 'refused', remote_server_keys: 0 }), /nothing stored yet/);

// A usable key: no row.
const panel = m.mountCloudConnect(document.getElementById('panel'));
// The dashboard's confirm dialog, reduced to what this test needs (render.js pulls the whole app).
panel.confirm = async (title, message, onYes) => {
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-message').textContent = message;
    document.getElementById('confirm-modal-yes').onclick = onYes;
    document.getElementById('confirm-modal').style.display = 'flex';
};
await tick();
assert.strictEqual(part('rekey-row').hidden, true);

// A refused key: the row, with what is lost.
status = { ...status, secret_key: refused };
panel.load();
await tick();
assert.strictEqual(part('rekey-row').hidden, false);
assert.match(part('rekey-text').textContent, /2 remote computers' API keys/);

// The button asks first; nothing is sent until Yes.
part('rekey').click();
await tick();
assert.strictEqual(document.getElementById('confirm-modal').style.display, 'flex');
assert.match(document.getElementById('confirm-modal-message').textContent, /cannot be undone/);
assert.strictEqual(posts.length, 0);
document.getElementById('confirm-modal-yes').click();
await tick();
assert.deepStrictEqual(posts, [{ confirm: true }]);
assert.strictEqual(part('rekey-row').hidden, true, 'gone once replaced');
assert.match(part('status').textContent, /secret key was replaced/);
assert.deepStrictEqual(domErrors.map(error => error.message), [], 'DOM listeners must not throw during the confirmation flow');
// #21557: Settings uses the same owner-only refusal, even after its commands
// were placed in a closed Advanced fold by the off state.
const settingsRoot = document.createElement('div');
settingsRoot.id = 'settings-cloud';
settingsRoot.innerHTML = `<div data-cloud="status"></div>
 <button data-cloud="connect"></button><div data-cloud="mode-row"></div>
 <div class="cloud-advanced"><summary>Advanced</summary><div data-cloud="command-row" hidden><code data-cloud="command"></code><button data-cloud="copy">Copy</button></div></div>`;
document.body.append(settingsRoot);
m.initCloudConnect();
const settingsPanel = settingsRoot._cloudPanel;
globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ code: 'local_dashboard_required', error: 'old server text' }) });
await settingsPanel.load();
const sq = role => settingsRoot.querySelector(`[data-cloud="${role}"]`);
assert.match(sq('status').textContent, /On a server without a screen, run this on it \(for example over SSH, as the user Coral runs as\):/);
assert.strictEqual(sq('command').textContent, 'coral cloud connect');
assert.strictEqual(sq('command-row').hidden, false);
assert.strictEqual(settingsRoot.querySelector('.cloud-advanced'), null, 'the command is outside the closed fold');
assert.strictEqual(sq('connect').hidden, true);
assert.strictEqual(sq('mode-row').hidden, true);
settingsPanel.render({ state: 'idle', configured: true });
assert.strictEqual(sq('command-row').hidden, true, 'the SSH command leaves with the refusal');
assert.doesNotMatch(sq('status').textContent, /server without a screen/);
settingsPanel.stop();
panel.stop();
console.log('cloud_rekey and headless refusal: ok');
process.exit(0);
