// The Share dialog through Coral Hub (#16109; jsdom, no browser): with no Dropbox connected here, the dialog says "Through Coral Hub" and only opens the Hub's page (the address the
// server built from this computer's enrolment, checked again here); a held file waits for a local "Upload anyway"; nothing from the Hub is put in as HTML; with a local Dropbox the dialog
// says "Through your Dropbox on this computer". Run: node dropbox_share_hub.test.js
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

(async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1:8420/' });
    for (const k of ['window', 'document', 'location', 'navigator', 'localStorage', 'sessionStorage', 'HTMLElement', 'Node']) {
        Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
    }
    dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
    const calls = [];
    let answers = {};
    globalThis.fetch = async (url, opts = {}) => {
        const u = new URL(String(url), 'http://127.0.0.1:8420').pathname;
        calls.push({ url: u, method: opts.method || 'GET', body: opts.body });
        const a = answers[u] || { status: 404, body: {} };
        return { ok: a.status === 200, status: a.status, json: async () => a.body };
    };
    const opened = [];
    dom.window.open = (...a) => { opened.push(a); return {}; };
    const m = await import(pathToFileURL(path.resolve(__dirname, '../../coral-go/pkg/frontend/static/dropbox_share.js')).href);
    const hex = 'b'.repeat(64);
    const page = `https://hub.example.test/dropbox/share/srv_1/${hex}`;
    const text = () => document.getElementById('dropbox-share-dialog').textContent;
    const btns = () => [...document.querySelectorAll('#dropbox-share-dialog button')];
    const find = (re) => btns().find(b => re.test(b.textContent));
    const open = async (body) => { answers['/api/dropbox/share/' + hex] = { status: 200, body }; calls.length = 0; opened.length = 0; await m.openShareDialog({ hex, filename: 'plan.md' }); };

    // Hub offered, a plain file: the line, the Hub's page for Share and Stop sharing, no upload, no call to the Hub.
    await open({ connected: false, hub: { offered: true, url: page, flagged: false } });
    assert.match(text(), /Through Coral Hub/);
    assert.match(text(), /its page is the record/);
    assert.match(text(), /Coral Hub deletes the file from Dropbox/, 'Stop sharing says the Hub deletes the file');
    assert.ok(!find(/Upload anyway/), 'a plain file has no Upload anyway');
    find(/Share on Coral Hub/).click();
    assert.deepEqual(opened, [[page, '_blank', 'noopener,noreferrer']]);
    find(/Stop sharing/).click();
    assert.equal(opened.length, 2);
    assert.deepEqual(calls.map(c => c.method + ' ' + c.url), ['GET /api/dropbox/share/' + hex], 'only the local read: no Coral-to-Hub call, no upload');

    // A held file: Upload anyway is a local POST, said plainly, and opens nothing by itself.
    await open({ connected: false, hub: { offered: true, url: page, flagged: true } });
    assert.match(text(), /looks like it holds a secret/);
    answers['/api/dropbox/upload-anyway/' + hex] = { status: 200, body: {} };
    find(/Upload anyway/).click();
    await new Promise(r => setTimeout(r, 20));
    assert.ok(calls.some(c => c.method === 'POST' && c.url === '/api/dropbox/upload-anyway/' + hex), 'a local POST');
    assert.match(text(), /Allowed for 10 minutes, for one send/);
    assert.equal(opened.length, 0);
    answers['/api/dropbox/upload-anyway/' + hex] = { status: 409, body: { error: '<img src=x onerror=alert(1)>' } };
    find(/Upload anyway/).click();
    await new Promise(r => setTimeout(r, 20));
    assert.match(text(), /Not changed: Coral could not save it/);
    assert.ok(!document.querySelector('#dropbox-share-dialog img'), 'nothing from a reply is put in as HTML');

    // An address that is not the Hub's page is never offered or opened.
    for (const bad of ['javascript:alert(1)', 'http://hub.example.test/dropbox/share/srv_1/' + hex, `https://u:p@hub.example.test/dropbox/share/srv_1/${hex}`,
        `https://hub.example.test/other/srv_1/${hex}`, `https://hub.example.test/dropbox/share/srv_1/${hex}?x=1`, `https://hub.example.test/dropbox/share/srv_1/${'B'.repeat(64)}`, '', null]) {
        await open({ connected: false, hub: { offered: true, url: bad, flagged: false } });
        assert.ok(!find(/Share on Coral Hub/), 'not offered: ' + bad);
        assert.match(text(), /Connect Dropbox in Settings/);
    }
    await open({ connected: false, hub: { offered: true, url: 'http://127.0.0.1:8421/dropbox/share/srv_1/' + hex, flagged: false } });
    assert.ok(find(/Share on Coral Hub/), 'a loopback development Hub may be http');

    // Not offered, tagged internal, or no hub field: the old sentence, or the internal one.
    await open({ connected: false, hub: { offered: false } });
    assert.match(text(), /Connect Dropbox in Settings/);
    await open({ connected: false, hub: { offered: false, blocked: 'internal' } });
    assert.match(text(), /tagged internal is never sent through Coral Hub/);
    await open({ connected: false });
    assert.match(text(), /Connect Dropbox in Settings/);
    assert.ok(!find(/Share on Coral Hub/));

    // A local Dropbox wins: its dialog says so, and a Hub view in the reply is ignored.
    await open({ connected: true, name: 'plan.md', size: 3, version: 1, can_expire: true, team: '', secret: false, folder: '/Coral', shares: [], hub: { offered: true, url: page, flagged: false } });
    assert.match(text(), /Through your Dropbox on this computer/);
    assert.ok(!find(/Share on Coral Hub/));
    console.log('dropbox_share_hub.test.js: ok');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
