// An artifact's place in the Dropbox backup, in its own view (Dropbox stage 6a, #14814): drawn only when the backup holds it or removed it; Remove
// asks first and sends the confirm (no Mark private and remove: the Operator); another Coral's marker asks for the typed last 4; a file edited in Dropbox offers Remove
// anyway at the rev the server named; a removed artifact offers Send to Dropbox again; nothing from the server is put in as HTML. Run: node artifact_dropbox.test.js
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

(async () => {
    const dom = new JSDOM('<!doctype html><body><div id="details"></div></body>', { url: 'http://127.0.0.1:8420/' });
    for (const k of ['window', 'document', 'location', 'navigator', 'localStorage', 'sessionStorage', 'HTMLElement', 'Node']) {
        Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
    }
    const calls = [];
    let answers = {};
    globalThis.fetch = async (url, opts = {}) => {
        const u = new URL(String(url), 'http://127.0.0.1:8420').pathname;
        calls.push({ url: u, method: opts.method || 'GET', body: opts.body });
        const a = answers[u] || { status: 404, body: {} };
        return { ok: a.status === 200, status: a.status, json: async () => a.body };
    };
    const m = await import(pathToFileURL(path.resolve(__dirname, '../../coral-go/pkg/frontend/static/artifact_dropbox.js')).href);
    const hex = 'a'.repeat(64);
    const mk = () => {
        const host = document.getElementById('details');
        host.textContent = '';
        let shown = null;
        const details = { onShown: fn => { shown = fn; }, remove: b => b.remove() };
        const block = m.dropboxBlock(hex, 'local', details);
        host.append(block);
        return { block, show: () => shown() };
    };
    const tick = () => new Promise(r => setTimeout(r, 0));

    // Not connected, or never backed up: nothing is drawn.
    answers[`/api/dropbox/artifact/${hex}`] = { status: 200, body: { connected: false } };
    let b = mk(); await b.show();
    assert.ok(!b.block.isConnected, 'not connected: the block is taken out');
    answers[`/api/dropbox/artifact/${hex}`] = { status: 200, body: { connected: true, in_dropbox: 0, removed: false } };
    b = mk(); await b.show();
    assert.ok(!b.block.isConnected, 'never backed up: nothing to say');
    answers[`/api/dropbox/artifact/${hex}`] = { status: 403, body: {} };
    b = mk(); await b.show();
    assert.ok(!b.block.isConnected, 'refused (through Coral Hub): nothing drawn');

    // In Dropbox: the two actions.
    answers[`/api/dropbox/artifact/${hex}`] = { status: 200, body: { connected: true, in_dropbox: 2, removed: false } };
    b = mk(); await b.show();
    assert.match(b.block.textContent, /In Dropbox \(2 files, with its details\)/);
    const btn = t => Array.from(b.block.querySelectorAll('button')).find(x => x.textContent === t);
    assert.ok(btn('Remove from Dropbox…'));
    assert.ok(!Array.from(b.block.querySelectorAll('button')).some(x => /private/i.test(x.textContent)), 'no Mark private and remove (the Operator: as few controls as possible)');

    // Remove: the confirm says it is for every Coral and stays out until sent again; another Coral's marker asks for the typed last 4.
    btn('Remove from Dropbox…').click();
    assert.match(b.block.textContent, /for every Coral that uses this backup.*stays out of the backup until you send it again/);
    assert.strictEqual(document.activeElement && document.activeElement.textContent, 'Cancel', 'the confirm opens on Cancel: one stray Enter never removes the file for every Coral');
    answers[`/api/dropbox/remove/${hex}`] = { status: 409, body: { code: 'others_offloaded', others: ['a3f2'], unknown: 0 } };
    btn('Remove from Dropbox').click(); await tick(); await tick();
    assert.match(b.block.textContent, /Another Coral keeps this file only in Dropbox \(…a3f2\)/);
    const input = b.block.querySelector('input');
    assert.ok(input, 'a typed confirm');
    const group = b.block.querySelector('[role=group]');
    assert.ok(group && group.getAttribute('aria-label'), 'the confirm is a named group (UI Accessibility MUST 2)');
    const described = (input.getAttribute('aria-describedby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
    assert.match(described, /for every Coral that uses this backup/, 'the field is described by what is removed');
    assert.match(described, /Type the last 4 characters/, 'and by what to type');
    assert.match(b.block.textContent, /type the characters shown to go on/, 'the status line says the server asks for more');
    input.value = '  a3f2 ';
    answers[`/api/dropbox/remove/${hex}`] = { status: 200, body: { removed: 1, edited: [{ path: `/v1/aaa/${'b'.repeat(32)}/v1-aaaaaaaa.md`, rev: 'r9' }] } };
    btn('Remove from Dropbox').click(); await tick(); await tick();
    let sent = calls.filter(c => c.url === `/api/dropbox/remove/${hex}`).pop();
    assert.deepStrictEqual(JSON.parse(sent.body), { confirm: true, typed: ['a3f2'] }, 'the typed characters, trimmed');
    // A file edited in Dropbox: Remove anyway at the rev the server named.
    assert.match(b.block.textContent, /1 file was edited in Dropbox and kept/);
    answers[`/api/dropbox/remove/${hex}`] = { status: 200, body: { removed: 1 } };
    answers[`/api/dropbox/artifact/${hex}`] = { status: 200, body: { connected: true, in_dropbox: 0, removed: true } };
    btn('Remove anyway').click(); await tick(); await tick(); await tick();
    sent = calls.filter(c => c.url === `/api/dropbox/remove/${hex}`).pop();
    assert.deepStrictEqual(JSON.parse(sent.body).anyway, { [`/v1/aaa/${'b'.repeat(32)}/v1-aaaaaaaa.md`]: 'r9' });
    assert.match(b.block.textContent, /Removed from Dropbox\./);
    // Removed: Send to Dropbox again.
    assert.match(b.block.textContent, /stays out of the backup until you send it again/);
    answers[`/api/dropbox/resend/${hex}`] = { status: 200, body: { queued: true } };
    answers[`/api/dropbox/artifact/${hex}`] = { status: 200, body: { connected: true, in_dropbox: 2, removed: false } };
    btn('Send to Dropbox again').click(); await tick(); await tick(); await tick();
    assert.ok(calls.some(c => c.url === `/api/dropbox/resend/${hex}` && c.method === 'POST'));
    assert.match(b.block.textContent, /It will be backed up again\./);

    // Cancel changes nothing, and gives the keyboard back to the button that opened the confirm.
    btn('Remove from Dropbox…').focus();
    btn('Remove from Dropbox…').click();
    const before = calls.length;
    btn('Cancel').click();
    assert.strictEqual(calls.length, before);
    assert.match(b.block.textContent, /Nothing changed\./);
    assert.strictEqual(document.activeElement && document.activeElement.textContent, 'Remove from Dropbox…', 'the keyboard is back on its trigger');
    assert.strictEqual(b.block.querySelector('img'), null);
    console.log('artifact_dropbox.test.js: ok');
})().catch(e => { console.error(e); process.exit(1); });
