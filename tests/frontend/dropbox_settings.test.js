// Unit test for the Dropbox backup block of Settings > Storage and cleanup (#14609, stage 3b; jsdom, no browser):
//   node dropbox_settings.test.js
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');

(async () => {
    const dir = path.resolve(__dirname, '../../coral-go/pkg/frontend/static');
    const dom = new JSDOM(`<!doctype html><body>
      <section id="settings-dropbox">
        <div id="settings-dropbox-status"></div>
        <button id="settings-dropbox-connect" hidden></button>
        <button id="settings-dropbox-disconnect" hidden></button>
        <button id="settings-dropbox-switch" hidden></button>
        <button id="settings-dropbox-takeover" hidden></button>
        <div id="settings-dropbox-note"></div>
        <div id="settings-dropbox-backup" hidden>
          <div id="settings-dropbox-counts"></div>
          <div id="settings-dropbox-types"></div>
          <input id="settings-dropbox-age" type="number">
          <button id="settings-dropbox-filters-save"></button>
        </div>
      </section></body>`, { url: 'http://127.0.0.1:8420/' });
    for (const k of ['window', 'document']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });

    const calls = [];
    let answers = {};
    globalThis.fetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
        const a = answers[url] || { status: 200, body: {} };
        return { ok: a.status === 200, status: a.status, json: async () => a.body };
    };
    let opened = null;
    let popupBlocked = false;
    dom.window.open = (u) => { opened = u; return popupBlocked ? null : {}; };
    const m = await import(pathToFileURL(path.join(dir, 'dropbox_settings.js')).href);
    const $ = (id) => document.getElementById(id);
    const shown = (id) => !$(id).hidden;
    const status = (body) => { answers['/api/dropbox/status'] = { status: 200, body }; return m.loadDropbox(); };

    // Not in this build (no app key): a plain sentence, no buttons.
    await status({ app_key_set: false, connected: false, state: 'disconnected' });
    assert.match($('settings-dropbox-status').textContent, /isn't available in this build/);
    assert.ok(!shown('settings-dropbox-connect') && !shown('settings-dropbox-disconnect'));

    // Not connected: Connect.
    await status({ app_key_set: true, connected: false, state: 'disconnected' });
    assert.match($('settings-dropbox-status').textContent, /Not connected/);
    assert.ok(shown('settings-dropbox-connect') && !shown('settings-dropbox-disconnect'));
    assert.strictEqual($('settings-dropbox-connect').textContent, 'Connect Dropbox…');

    // Access lost (a re-key, or Dropbox refused it): plain words, Reconnect.
    await status({ app_key_set: true, connected: false, state: 'reconnect' });
    assert.match($('settings-dropbox-status').textContent, /lost access to your Dropbox\. Your files are safe on this computer/);
    assert.strictEqual($('settings-dropbox-connect').textContent, 'Reconnect');

    // Connected: the account and Disconnect.
    await status({ app_key_set: true, connected: true, state: 'connected', account_id: 'dbid:AAA' });
    assert.match($('settings-dropbox-status').textContent, /Connected to Dropbox/);
    assert.ok(shown('settings-dropbox-disconnect') && !shown('settings-dropbox-connect') && !shown('settings-dropbox-takeover'));

    // A copy of the data folder: says so, offers Take over, and nothing else.
    await status({ app_key_set: true, connected: true, state: 'connected', account_id: 'dbid:AAA', looks_like_copy: true });
    assert.match($('settings-dropbox-status').textContent, /looks like a copy/);
    assert.match($('settings-dropbox-status').textContent, /records this computer as the one that backs up/, 'Take over says what it does');
    assert.match($('settings-dropbox-status').textContent, /If the original is still in use, leave it paused/, 'and when not to');
    assert.ok(shown('settings-dropbox-takeover') && !shown('settings-dropbox-disconnect'));

    // A sign-in to another account waits for the confirm.
    await status({ app_key_set: true, connected: false, state: 'disconnected', switch_pending: { from: 'dbid:AAA', to: 'dbid:BBB' } });
    assert.match($('settings-dropbox-status').textContent, /different Dropbox account/);
    assert.match($('settings-dropbox-status').textContent, /dbid:BBB/, 'the new account');
    assert.match($('settings-dropbox-status').textContent, /dbid:AAA/, 'and the one before');
    assert.ok(shown('settings-dropbox-switch'));

    // Connect: a JSON POST, then Dropbox's page opens.
    await status({ app_key_set: true, connected: false, state: 'disconnected' });
    answers['/api/dropbox/connect'] = { status: 200, body: { authorize_url: 'https://www.dropbox.com/oauth2/authorize?x=1' } };
    await m.connectDropbox();
    const post = calls.find(c => c.url === '/api/dropbox/connect');
    assert.strictEqual(post.method, 'POST');
    assert.strictEqual(post.headers['Content-Type'], 'application/json');
    assert.strictEqual(opened, 'https://www.dropbox.com/oauth2/authorize?x=1');
    assert.match($('settings-dropbox-status').textContent, /Waiting for you to click Allow/);
    m.stopDropboxPoll();

    // Connect from a dashboard opened at localhost: the server says where to open Coral; the note shows it as a link.
    opened = null;
    // The server's real error envelope (writeError): error is the sentence, code is the code.
    answers['/api/dropbox/connect'] = { status: 409, body: { error: 'Open Coral at http://127.0.0.1:8420 to connect Dropbox', code: 'open_on_127' } };
    await m.connectDropbox();
    assert.strictEqual(opened, null);
    assert.match($('settings-dropbox-note').textContent, /Open Coral at http:\/\/127\.0\.0\.1:8420/);
    assert.strictEqual($('settings-dropbox-note').querySelector('a').getAttribute('href'), 'http://127.0.0.1:8420/');

    // Another error code with its sentence: the known code's words are shown, never the raw code.
    answers['/api/dropbox/connect'] = { status: 409, body: { error: 'Another Dropbox sign-in is already waiting; finish or wait five minutes', code: 'signin_busy' } };
    await m.connectDropbox();
    assert.match($('settings-dropbox-note').textContent, /already waiting/);
    assert.ok(!/signin_busy/.test($('settings-dropbox-note').textContent));

    // Disconnect that could not end the sign-in at Dropbox: tells the person to remove Coral there (Security's note 6).
    answers['/api/dropbox/disconnect'] = { status: 200, body: { connected: false, revoked: false } };
    answers['/api/dropbox/status'] = { status: 200, body: { app_key_set: true, connected: false, state: 'disconnected' } };
    await m.disconnectDropbox();
    assert.match($('settings-dropbox-note').textContent, /Connected apps/);
    answers['/api/dropbox/disconnect'] = { status: 200, body: { connected: false, revoked: true } };
    await m.disconnectDropbox();
    assert.ok(!/Connected apps/.test($('settings-dropbox-note').textContent), 'a revoked sign-in needs no Connected apps note');

    // UI Reviewer's MUSTs on #14654.
    // (1) Settings opened while a sign-in already waits: it keeps reading the status, without a new Connect.
    m.stopDropboxPoll();
    await status({ app_key_set: true, connected: false, state: 'disconnected', signin_pending: true });
    assert.strictEqual($('settings-dropbox').dataset.polling, '1', 'a pending sign-in is followed when Settings opens');
    assert.match($('settings-dropbox-status').textContent, /Waiting for you to click Allow/);
    // (2) It expires (no longer pending, not connected): the person is told, with Connect to try again.
    await status({ app_key_set: true, connected: false, state: 'disconnected' });
    assert.match($('settings-dropbox-note').textContent, /timed out/);
    assert.ok(shown('settings-dropbox-connect'), 'a retry');
    m.stopDropboxPoll();
    // (3) The browser blocks the new tab: a visible link opens Dropbox instead.
    popupBlocked = true;
    answers['/api/dropbox/connect'] = { status: 200, body: { authorize_url: 'https://www.dropbox.com/oauth2/authorize?y=2' } };
    await m.connectDropbox();
    const link = $('settings-dropbox-note').querySelector('a');
    assert.ok(link, 'a link to open Dropbox');
    assert.strictEqual(link.getAttribute('href'), 'https://www.dropbox.com/oauth2/authorize?y=2');
    assert.strictEqual(link.getAttribute('target'), '_blank');
    assert.match(link.getAttribute('rel') || '', /noopener/);
    assert.match($('settings-dropbox-note').textContent, /blocked/);
    m.stopDropboxPoll();
    popupBlocked = false;

    // Stage 4c (#14693): the backup's counts, its filters and a full Dropbox.
    const connected = { app_key_set: true, connected: true, state: 'connected', account_id: 'dbid:AAA',
        backup: { backed_up: 12, pending: 3, conflict: 1, skipped: 0, failed: 0, last_sync: '2026-11-08T12:00:00Z' },
        filters: { types: ['md', 'png'], max_age_days: 1 } };
    await status(connected);
    assert.ok(shown('settings-dropbox-backup'), 'the backup part shows once connected');
    const counts = $('settings-dropbox-counts').textContent;
    assert.match(counts, /12 files backed up/);
    assert.match(counts, /3 waiting/);
    assert.match(counts, /1 conflict/);
    assert.ok(!/skipped|failed/.test(counts), 'zero counts are left out');
    const boxes = [...$('settings-dropbox-types').querySelectorAll('input[type=checkbox]')];
    assert.ok(boxes.length >= 10, 'one box per type of the closed list');
    assert.deepStrictEqual(boxes.filter(b => b.checked).map(b => b.value).sort(), ['md', 'png']);
    assert.strictEqual($('settings-dropbox-age').value, '1');

    // Save: a JSON PUT of the ticked types and the age.
    boxes.find(b => b.value === 'pdf').checked = true;
    $('settings-dropbox-age').value = '7';
    answers['/api/dropbox/filters'] = { status: 200, body: { types: ['md', 'pdf', 'png'], max_age_days: 7 } };
    await m.saveDropboxFilters();
    const put = calls.filter(c => c.url === '/api/dropbox/filters').pop();
    assert.strictEqual(put.method, 'PUT');
    const sent = JSON.parse(put.body);
    assert.deepStrictEqual({ ...sent, types: [...sent.types].sort() }, { types: ['md', 'pdf', 'png'], max_age_days: 7 }, 'the ticked types (any order) and the age');
    assert.match($('settings-dropbox-note').textContent, /Saved/);
    assert.match($('settings-dropbox-note').textContent, /never deletes/i, 'narrowing is said to keep what is already in Dropbox');

    // A refused save shows the server's sentence.
    answers['/api/dropbox/filters'] = { status: 400, body: { error: 'max_age_days is 0 (no limit) to 3650' } };
    $('settings-dropbox-age').value = '99999';
    await m.saveDropboxFilters();
    assert.match($('settings-dropbox-note').textContent, /0 \(no limit\) to 3650/);

    // No filter: every type and every age.
    await status({ ...connected, filters: { types: [], max_age_days: 0 } });
    assert.ok([...$('settings-dropbox-types').querySelectorAll('input')].every(b => !b.checked));
    assert.match($('settings-dropbox-backup').textContent, /every type/i);

    // A full Dropbox: the backup has paused, nothing deleted, one next step.
    await status({ ...connected, state: 'quota_full' });
    assert.match($('settings-dropbox-status').textContent, /Your Dropbox is full, so the backup has paused\. Nothing has been deleted/);
    const more = $('settings-dropbox-note').querySelector('a');
    assert.ok(more && /dropbox\.com/.test(more.getAttribute('href')), 'Get more Dropbox space');

    // Not connected: the backup part is hidden.
    await status({ app_key_set: true, connected: false, state: 'disconnected' });
    assert.ok(!shown('settings-dropbox-backup'));

    // A refused status read says why, by the server's error code (Security's SHOULD on 2ed958673), never with buttons.
    const refused = async (status, body) => { answers['/api/dropbox/status'] = { status, body }; await m.loadDropbox(); return $('settings-dropbox-status').textContent; };
    // Through Coral Hub (the tunnel refusal: 403 with no code), a dashboard that is not this computer's own (local_dashboard_required) and another
    // OS user (other_user): Dropbox is set up on the computer itself (hub census: explains).
    for (const [status, body] of [[403, { error: 'Cloud connector settings are only available on this computer' }], [403, { error: 'x', code: 'local_dashboard_required' }], [403, { error: 'x', code: 'other_user' }]]) {
        assert.match(await refused(status, body), /set up on the computer itself, not through Coral Hub/, JSON.stringify(body));
        assert.ok(!shown('settings-dropbox-connect') && !shown('settings-dropbox-disconnect'));
    }
    assert.match(await refused(404, { error: 'Dropbox backup is not available in this build', code: 'not_available' }), /isn't available in this build/);
    assert.ok(!shown('settings-dropbox-connect'));
    assert.match(await refused(500, { error: 'boom' }), /Couldn't read the Dropbox connection/);
    assert.match(await refused(404, { error: 'not found' }), /Couldn't read the Dropbox connection/, 'a 404 with no code is not the build');

    // Nothing from the server is put into the page as HTML.
    await status({ app_key_set: true, connected: true, state: 'connected', account_id: '<img src=x onerror=alert(1)>' });
    assert.strictEqual(document.querySelector('#settings-dropbox img'), null);

    console.log('dropbox_settings.test.js: ok');
})().catch(e => { console.error(e); process.exit(1); });
