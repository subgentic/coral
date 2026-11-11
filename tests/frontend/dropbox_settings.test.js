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
        <button id="settings-dropbox-delete" hidden></button>
        <div id="settings-dropbox-delete-confirm" hidden></div>
        <p id="settings-dropbox-delete-rule" hidden></p>
        <div id="settings-dropbox-removals" hidden></div>
        <div id="settings-dropbox-shares" hidden></div>
        <button id="settings-dropbox-switch" hidden></button>
        <button id="settings-dropbox-takeover" hidden></button>
        <button id="settings-dropbox-recheck" hidden></button>
        <div id="settings-dropbox-note"></div>
        <div id="settings-dropbox-backup" hidden>
          <div id="settings-dropbox-counts"></div>
          <input type="checkbox" id="settings-dropbox-autosync"><button id="settings-dropbox-autosync-resume" hidden></button><p id="settings-dropbox-autosync-note"></p>
          <ul id="settings-dropbox-edits" hidden></ul>
          <input id="settings-dropbox-offload-for" type="number"><button id="settings-dropbox-offload-save"></button><div id="settings-dropbox-offload-confirm" hidden></div><p id="settings-dropbox-offload-kept"></p>
          <div id="settings-dropbox-types"></div>
          <input id="settings-dropbox-age" type="number">
          <button id="settings-dropbox-filters-save"></button>
          <input id="settings-dropbox-keep-for" type="number">
          <button id="settings-dropbox-retention-save"></button>
          <button id="settings-dropbox-retention-on" hidden></button>
          <button id="settings-dropbox-retention-cancel" hidden></button>
        </div>
      </section></body>`, { url: 'http://127.0.0.1:8420/' });
    for (const k of ['window', 'document', 'navigator']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }); // navigator: the jsdom agent, so the module's stylesheet is not awaited

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
    assert.match($('settings-dropbox-status').textContent, /Add your Dropbox app key to connect/);
    assert.ok(shown('settings-dropbox-key') && $('settings-dropbox-key-input'), 'no key: the key field is offered');
    assert.ok(!shown('settings-dropbox-connect') && !shown('settings-dropbox-disconnect'));

    // Signed in with the key an earlier build shipped, none in this build (#15641): paused, said once, with Disconnect and no Connect.
    await status({ app_key_set: false, connected: true, state: 'connected', account_id: 'dbid:AAA', paused_no_key: true });
    assert.match($('settings-dropbox-status').textContent, /Dropbox now uses your own app key: add it and connect again/);
    assert.ok(shown('settings-dropbox-disconnect') && !shown('settings-dropbox-connect'));
    assert.match($('settings-dropbox-note').textContent, /Disconnect without the key cannot end Coral.s sign-in at Dropbox/, 'Security INFO on #15641: Disconnect with no key cannot revoke');
    assert.ok(shown('settings-dropbox-key'), 'paused: the key field is offered');

    // The app key (#15638): a saved key fills the field; a key of the wrong shape is refused in the page, with no request.
    await status({ app_key_set: true, connected: false, state: 'disconnected', app_key: 'abcd1234efgh567' });
    assert.strictEqual($('settings-dropbox-key-input').value, 'abcd1234efgh567', 'the saved key fills the field');
    assert.ok(shown('settings-dropbox-connect'), 'a key is saved: Connect is offered');
    let keyBefore = calls.length;
    $('settings-dropbox-key-input').value = 'not a key!';
    await m.saveAppKey();
    assert.strictEqual(calls.length, keyBefore, 'a malformed key sends nothing');
    assert.match($('settings-dropbox-key-note').textContent, /does not look like a Dropbox app key/);

    // A good key from a state with none: one PUT with the key, then the status is read again.
    await status({ app_key_set: false, connected: false, state: 'disconnected' });
    answers['/api/dropbox/app-key'] = { status: 200, body: { saved: true, disconnected: false } };
    answers['/api/dropbox/status'] = { status: 200, body: { app_key_set: true, connected: false, state: 'disconnected', app_key: 'zyxw9876vuts543' } };
    $('settings-dropbox-key-input').value = '  zyxw9876vuts543 ';
    keyBefore = calls.length;
    await m.saveAppKey();
    const keyPut = calls.slice(keyBefore).find(c => c.url === '/api/dropbox/app-key');
    assert.ok(keyPut && keyPut.method === 'PUT', 'the key goes to PUT /api/dropbox/app-key');
    assert.deepStrictEqual(JSON.parse(keyPut.body), { app_key: 'zyxw9876vuts543' }, 'trimmed, and no confirm the first time');
    assert.ok(shown('settings-dropbox-connect'), 'saved: Connect is offered');
    assert.match($('settings-dropbox-key-note').textContent, /Key saved/);

    // Changing the key while connected: the server asks first; nothing changes until the person confirms, then the old account is disconnected.
    await status({ app_key_set: true, connected: true, state: 'connected', account_id: 'dbid:AAA', app_key: 'zyxw9876vuts543' });
    answers['/api/dropbox/app-key'] = { status: 409, body: { code: 'confirm_disconnect', error: 'Changing the app key disconnects dbid:AAA: connect again with the new key.' } };
    $('settings-dropbox-key-input').value = 'newkey1234567890';
    await m.saveAppKey();
    assert.ok(shown('settings-dropbox-key-confirm'), 'the confirm is shown');
    assert.match($('settings-dropbox-key-confirm-text').textContent, /disconnects dbid:AAA/);
    answers['/api/dropbox/app-key'] = { status: 200, body: { saved: true, disconnected: true } };
    answers['/api/dropbox/status'] = { status: 200, body: { app_key_set: true, connected: false, state: 'disconnected', app_key: 'newkey1234567890' } };
    keyBefore = calls.length;
    await m.saveAppKey(true);
    const keyPut2 = calls.slice(keyBefore).find(c => c.url === '/api/dropbox/app-key');
    assert.deepStrictEqual(JSON.parse(keyPut2.body), { app_key: 'newkey1234567890', confirm: true }, 'the confirmed change');
    assert.match($('settings-dropbox-key-note').textContent, /old account is disconnected/);
    assert.ok(!shown('settings-dropbox-key-confirm'));

    // A key from the environment: no field, one sentence.
    await status({ app_key_set: true, connected: false, state: 'disconnected', app_key_from_env: true });
    assert.ok(!$('settings-dropbox-key-input').offsetParent && $('settings-dropbox-key-input').hidden, 'the field is hidden');
    assert.match($('settings-dropbox-key-note').textContent, /CORAL_DROPBOX_APP_KEY/);


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
    assert.match($('settings-dropbox-note').textContent, /If the Dropbox tab didn't open, open it here:/);
    m.stopDropboxPoll();
    popupBlocked = false;
    // With noopener a browser answers null even when the tab opened (#14736): the words are true either way, never "blocked".
    await m.connectDropbox();
    assert.doesNotMatch($('settings-dropbox-note').textContent, /blocked/);
    assert.ok($('settings-dropbox-note').querySelector('a'), 'the link is there in both cases');
    // Once the sign-in finishes, the link is gone (the Operator saw it stay under "Connected").
    await status({ app_key_set: true, connected: true, state: 'connected', account_id: 'dbid:AAA' });
    assert.strictEqual($('settings-dropbox-note').textContent, '', 'no stale sign-in link once connected');
    m.stopDropboxPoll();

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
    await status({ ...connected, backup: { ...connected.backup, private: 2 } });
    assert.match($('settings-dropbox-counts').textContent, /2 private, kept off Dropbox/, 'private items are counted when there are any');
    await status(connected);
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
    // UI Reviewer's MUST 1 on #14693: the summary and the controls follow the saved answer, with no reload.
    assert.match($('settings-dropbox-counts').textContent, /Backing up \.md, \.pdf, \.png from the last 7 days\./);
    answers['/api/dropbox/filters'] = { status: 200, body: { types: ['md'], max_age_days: 0 } }; // the server's answer, not what was ticked
    await m.saveDropboxFilters();
    assert.match($('settings-dropbox-counts').textContent, /Backing up \.md\./);
    assert.deepStrictEqual([...$('settings-dropbox-types').querySelectorAll('input:checked')].map(b => b.value), ['md'], 'the boxes follow the answer');
    assert.strictEqual($('settings-dropbox-age').value, '0');
    // An edit made while the save is on its way is kept (the summary still follows the answer).
    let release;
    const realFetch0 = globalThis.fetch;
    globalThis.fetch = (url, opts) => url === '/api/dropbox/filters'
        ? new Promise(res => { release = () => res({ ok: true, status: 200, json: async () => ({ types: ['md'], max_age_days: 0 }) }); })
        : realFetch0(url, opts);
    const saving = m.saveDropboxFilters();
    $('settings-dropbox-types').querySelector('input[value=png]').checked = true; // ticked after Save was pressed
    $('settings-dropbox-age').value = '3';
    release();
    await saving;
    globalThis.fetch = realFetch0;
    assert.match($('settings-dropbox-counts').textContent, /Backing up \.md\./, 'the summary says what was saved');
    assert.deepStrictEqual([...$('settings-dropbox-types').querySelectorAll('input:checked')].map(b => b.value).sort(), ['md', 'png'], 'the newer tick is kept');
    assert.strictEqual($('settings-dropbox-age').value, '3', 'the newer age is kept');

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
    // Check again: one next step after freeing space, which reads the status again (the worker resumes on its next pass).
    assert.ok(shown('settings-dropbox-recheck'), 'a Check again button');
    answers['/api/dropbox/check'] = { status: 404, body: { code: 'not_available' } };
    $('settings-dropbox-recheck').click();
    await new Promise(r => setTimeout(r, 0));
    assert.ok(calls.some(c => c.url === '/api/dropbox/check' && c.method === 'POST'), 'Check again asks the worker for a pass');
    assert.match($('settings-dropbox-note').textContent, /Couldn't check/, 'a refused check says so');
    answers['/api/dropbox/check'] = { status: 200, body: { checking: true } };
    $('settings-dropbox-recheck').click();
    await new Promise(r => setTimeout(r, 0));
    assert.match($('settings-dropbox-status').textContent, /Checking your Dropbox space/);

    // UI Reviewer's MUST 2 on #14693: connected, then a refused or failed read hides the backup controls, the stale counts and every button.
    const stale = () => {
        assert.ok(!shown('settings-dropbox-backup'), 'the backup part, with the types, the age and Save, is hidden');
        assert.ok($('settings-dropbox-filters-save').closest('#settings-dropbox-backup'), 'Save lives in the backup part');
        assert.strictEqual($('settings-dropbox-counts').textContent, '', 'no stale counts');
        for (const id of ['settings-dropbox-disconnect', 'settings-dropbox-recheck', 'settings-dropbox-connect']) assert.ok(!shown(id), id);
    };
    for (const [code, body] of [[403, { error: 'x', code: 'local_dashboard_required' }], [404, { error: 'x', code: 'not_available' }], [500, {}]]) {
        await status({ ...connected, state: 'quota_full', backup: { backed_up: 3 } });
        assert.ok(shown('settings-dropbox-backup') && shown('settings-dropbox-recheck'));
        answers['/api/dropbox/status'] = { status: code, body };
        await m.loadDropbox();
        stale();
    }
    await status({ ...connected, backup: { backed_up: 3 } });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new TypeError('network down'); };
    await m.loadDropbox();
    globalThis.fetch = realFetch;
    stale();
    assert.match($('settings-dropbox-status').textContent, /Couldn't read the Dropbox connection/);

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

    // Edits made in Dropbox (#14714): held, never applied here.
    await status({ ...connected, edits: { open: 2, waiting: 5 } });
    assert.match($('settings-dropbox-counts').textContent, /2 files were edited in Dropbox: Coral holds the edits for you and has not changed them here\. 5 more edits wait in Dropbox until you decide some\./);
    await status({ ...connected, edits: { open: 0, waiting: 0 } });
    assert.doesNotMatch($('settings-dropbox-counts').textContent, /edited in Dropbox/);

    // The held edits (#14714 piece 2): Coral's name, size and type, the unseen note, Dropbox's own view, and the two decisions.
    const doc = 'a'.repeat(32);
    await status({ ...connected, edits: { open: 1, waiting: 0, items: [{ doc_id: doc, name: '<img src=x onerror=alert(1)>report.md', size: 2048, media_type: 'text/markdown', next_version: 3, dropbox_url: 'https://www.dropbox.com/home/Apps/coralhub/v1/aaa/' + doc + '/v1-12345678.md' }] } });
    const list = $('settings-dropbox-edits');
    assert.ok(!list.hidden);
    assert.strictEqual(list.querySelectorAll('li').length, 1);
    assert.strictEqual(list.querySelector('img'), null, 'a name is text, never markup');
    assert.match(list.textContent, /<img src=x onerror=alert\(1\)>report\.md was edited in Dropbox \(2 KB, text\/markdown\)\./);
    assert.match(list.textContent, /Coral has not shown you what changed\./);
    const look = list.querySelector('a');
    assert.strictEqual(look.getAttribute('target'), '_blank');
    assert.strictEqual(look.getAttribute('rel'), 'noopener noreferrer');
    assert.ok(look.getAttribute('href').startsWith('https://www.dropbox.com/'));
    const [useBtn, keepBtn] = list.querySelectorAll('button');
    assert.strictEqual(useBtn.textContent, 'Use it as version 3', 'names the version it will make');
    assert.strictEqual(keepBtn.textContent, 'Keep it separate');
    answers['/api/dropbox/edits/' + doc + '/promote'] = { status: 200, body: { decision: 'promoted', version: 3 } };
    useBtn.click();
    await new Promise(r => setTimeout(r, 0));
    assert.ok(calls.some(c => c.url === '/api/dropbox/edits/' + doc + '/promote' && c.method === 'POST'));
    assert.match($('settings-dropbox-note').textContent, /the edit is version 3 now/);
    answers['/api/dropbox/edits/' + doc + '/separate'] = { status: 409, body: { code: 'not_pending' } };
    await m.decideEdit(doc, 'separate', 'report.md');
    assert.match($('settings-dropbox-note').textContent, /already decided/);
    const sentBefore = calls.length;
    await m.decideEdit('../x', 'promote', 'x');
    await m.decideEdit(doc, 'delete', 'x');
    assert.strictEqual(calls.length, sentBefore, 'nothing sent for a bad id or action');
    await status({ ...connected, edits: { open: 0, waiting: 0, items: [] } });
    assert.ok($('settings-dropbox-edits').hidden, 'none held: the list is hidden');

    // Retention (#14703): the counts, the window and the dry run before Turn on.
    await status({ ...connected, backup: { backed_up: 4, retained_out: 3, gone: 1, edited: 2 }, filters: { types: [], max_age_days: 0 }, retention: { days: 0 } });
    const line = () => $('settings-dropbox-counts').textContent;
    assert.match(line(), /3 removed from Dropbox by retention \(still on this computer\)/);
    assert.match(line(), /1 no longer at its place in Dropbox/, 'never "removed by Coral"');
    assert.match(line(), /2 edited in Dropbox, kept there/);
    assert.doesNotMatch(line(), /Keeping files in Dropbox/, 'off: no retention sentence');
    assert.strictEqual($('settings-dropbox-keep-for').value, '0');
    await status({ ...connected, filters: { types: [], max_age_days: 10 }, retention: { days: 3, waiting_for_files: true } });
    assert.match(line(), /from the last 3 days, the retention window\./, 'the smaller window is the one uploads use');
    assert.match(line(), /Keeping files in Dropbox for 3 days\. Retention starts once at least 2 artifacts are backed up\./);
    assert.strictEqual($('settings-dropbox-keep-for').value, '3');

    await status({ ...connected, retention: { days: 0 } });
    const retentionCalls = () => calls.filter(c => c.url === '/api/dropbox/retention').map(c => JSON.parse(c.body));
    const before = retentionCalls().length;
    answers['/api/dropbox/retention'] = { status: 200, body: { dry_run: true, days: 7, due: 4, bytes: 2048, held: 6 } };
    $('settings-dropbox-keep-for').value = '7';
    await m.saveRetention();
    assert.deepStrictEqual(retentionCalls().slice(before), [{ days: 7 }], 'first a dry run, nothing confirmed');
    assert.match($('settings-dropbox-note').textContent, /Keeping files for 7 days: 4 files \(2 KB\) would be deleted from Dropbox now, and 6 more on later passes\. Turn on, or Cancel\./, 'the count names the days it is for');
    assert.ok(shown('settings-dropbox-retention-on') && shown('settings-dropbox-retention-cancel'));
    // Cancel: nothing saved, the field back to what is saved.
    $('settings-dropbox-retention-cancel').click();
    assert.ok(!shown('settings-dropbox-retention-on'));
    assert.match($('settings-dropbox-note').textContent, /Nothing changed/);
    assert.strictEqual($('settings-dropbox-keep-for').value, '0');
    assert.strictEqual(document.activeElement, $('settings-dropbox-keep-for'), 'focus goes back to the field when the buttons go (SHOULD)');
    assert.strictEqual(retentionCalls().length, before + 1);
    // Turn on: saved with the count the person saw.
    $('settings-dropbox-keep-for').value = '7';
    await m.saveRetention();
    answers['/api/dropbox/retention'] = { status: 200, body: { days: 7 } };
    await m.confirmRetention();
    assert.deepStrictEqual(retentionCalls().pop(), { days: 7, confirm: true, seen_count: 4, seen_bytes: 2048 });
    assert.ok(!shown('settings-dropbox-retention-on'));
    assert.match($('settings-dropbox-note').textContent, /Retention is on/);
    // Off: no dry run.
    $('settings-dropbox-keep-for').value = '0';
    await m.saveRetention();
    assert.deepStrictEqual(retentionCalls().pop(), { days: 0 });
    assert.match($('settings-dropbox-note').textContent, /Retention is off/);
    // A refused read while the count waits takes Turn on away.
    answers['/api/dropbox/retention'] = { status: 200, body: { dry_run: true, days: 2, due: 0, bytes: 0, held: 0 } };
    await status({ ...connected, retention: { days: 0 } });
    $('settings-dropbox-keep-for').value = '2';
    await m.saveRetention();
    assert.match($('settings-dropbox-note').textContent, /Keeping files for 2 days: nothing would be deleted from Dropbox now/);
    answers['/api/dropbox/status'] = { status: 403, body: { error: 'x', code: 'other_user' } };
    await m.loadDropbox();
    assert.ok(!shown('settings-dropbox-retention-on') && !shown('settings-dropbox-retention-cancel'));
    await m.confirmRetention();
    assert.strictEqual(retentionCalls().pop().confirm, undefined, 'the stale count can no longer be confirmed');

    // UI Reviewer's MUSTs on #14703. (2) Only a whole number 0 to 3650 is sent: anything else sends nothing and shows no Turn on.
    await status({ ...connected, retention: { days: 0 } });
    answers['/api/dropbox/retention'] = { status: 200, body: { dry_run: true, days: 1, due: 9, bytes: 1, held: 0 } };
    for (const bad of ['1.9', '-1', 'abc', '', '4000', '1e3', '7.0', '0x10', '3651']) {
        const n0 = retentionCalls().length;
        $('settings-dropbox-keep-for').value = bad;
        await m.saveRetention();
        assert.strictEqual(retentionCalls().length, n0, `nothing sent for ${JSON.stringify(bad)}`);
        assert.ok(!shown('settings-dropbox-retention-on'));
        assert.match($('settings-dropbox-note').textContent, /whole number of days, 0 \(off\) to 3650/);
    }

    // (1) The confirm is bound to the days the field shows. Edited after the count (with or without an input event): Turn on goes, and a
    // confirm sends nothing.
    answers['/api/dropbox/retention'] = { status: 200, body: { dry_run: true, days: 7, due: 4, bytes: 10, held: 0 } };
    $('settings-dropbox-keep-for').value = '7';
    await m.saveRetention();
    assert.ok(shown('settings-dropbox-retention-on'));
    $('settings-dropbox-keep-for').value = '30';
    $('settings-dropbox-keep-for').dispatchEvent(new dom.window.Event('input'));
    assert.ok(!shown('settings-dropbox-retention-on'), 'a changed field takes Turn on away');
    let n1 = retentionCalls().length;
    await m.confirmRetention();
    assert.strictEqual(retentionCalls().length, n1, 'nothing confirmed for the old count');
    $('settings-dropbox-keep-for').value = '7';
    await m.saveRetention();
    $('settings-dropbox-keep-for').value = '30'; // no input event (a script, an autofill)
    n1 = retentionCalls().length;
    await m.confirmRetention();
    assert.strictEqual(retentionCalls().length, n1, 'the field no longer says 7: nothing confirmed');
    assert.ok(!shown('settings-dropbox-retention-on'));

    // A dry-run answer for other days than were asked (a stale or mixed-up reply) is not shown as a count to confirm.
    answers['/api/dropbox/retention'] = { status: 200, body: { dry_run: true, days: 1, due: 99, bytes: 1, held: 0 } };
    $('settings-dropbox-keep-for').value = '7';
    await m.saveRetention();
    assert.ok(!shown('settings-dropbox-retention-on'), 'a count for 1 day never offers Turn on for 7');

    // Out-of-order dry-run answers: the count asked for 7 arrives after the one for 30, and is ignored.
    const realFetch2 = globalThis.fetch;
    const waiting = [];
    globalThis.fetch = (url, opts = {}) => {
        if (url !== '/api/dropbox/retention') return realFetch2(url, opts);
        calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
        const days = JSON.parse(opts.body).days;
        return new Promise(res => waiting.push({ days, go: () => res({ ok: true, status: 200, json: async () => ({ dry_run: true, days, due: days, bytes: days * 1024, held: 0 }) }) }));
    };
    $('settings-dropbox-keep-for').value = '7';
    const first = m.saveRetention();
    $('settings-dropbox-keep-for').value = '30';
    $('settings-dropbox-keep-for').dispatchEvent(new dom.window.Event('input'));
    const second = m.saveRetention();
    await new Promise(r => setTimeout(r, 0));
    assert.deepStrictEqual(waiting.map(w => w.days), [7, 30]);
    waiting[1].go();
    await second;
    waiting[0].go(); // the late answer for 7
    await first;
    globalThis.fetch = realFetch2;
    assert.match($('settings-dropbox-note').textContent, /Keeping files for 30 days: 30 files/, 'the note is for the days shown');
    answers['/api/dropbox/retention'] = { status: 200, body: { days: 30 } };
    await m.confirmRetention();
    assert.deepStrictEqual(retentionCalls().pop(), { days: 30, confirm: true, seen_count: 30, seen_bytes: 30 * 1024 }, 'what is confirmed is what was shown');

    // Disconnect and delete the backup (#14814): the server says what to type; the sign-in goes only when the delete finished.
    await status({ ...connected });
    assert.ok(shown('settings-dropbox-delete'), 'offered beside Disconnect');
    answers['/api/dropbox/disconnect'] = { status: 409, body: { code: 'confirm_delete_backup', files: 12, foreign: 2, others: ['a3f2'], unknown: 0 } };
    await m.deleteBackupStart();
    const dc = $('settings-dropbox-delete-confirm');
    assert.ok(!dc.hidden);
    assert.match(dc.textContent, /deletes the Dropbox backup \(12 files\) for every Coral that uses it, then disconnects\. 2 of them did not come from this computer\. Other Corals keep files only in Dropbox \(…a3f2\): they lose them\./);
    assert.match(dc.textContent, /To go on, type: delete 2 a3f2/);
    assert.strictEqual(dc.getAttribute('role'), 'group');
    assert.ok(dc.getAttribute('aria-label'), 'a named group');
    const typedIn = document.getElementById('settings-dropbox-delete-typed');
    assert.strictEqual(document.getElementById(typedIn.getAttribute('aria-describedby')).textContent, dc.querySelector('p').textContent, 'the field is described by what is deleted and the words to type');
    let sentDel = calls.filter(c => c.url === '/api/dropbox/disconnect').pop();
    assert.deepStrictEqual(JSON.parse(sentDel.body), { delete_backup: true }, 'the first ask types nothing');
    answers['/api/dropbox/disconnect'] = { status: 202, body: { deleting: true } };
    await m.deleteBackupConfirm('delete 2 a3f2');
    sentDel = calls.filter(c => c.url === '/api/dropbox/disconnect').pop();
    assert.deepStrictEqual(JSON.parse(sentDel.body), { delete_backup: true, typed: ['delete', '2', 'a3f2'] });
    assert.match($('settings-dropbox-note').textContent, /still deleting the backup\. You are still connected/);
    answers['/api/dropbox/disconnect'] = { status: 200, body: { connected: false, revoked: true } };
    answers['/api/dropbox/status'] = { status: 200, body: { app_key_set: true, connected: false, state: 'disconnected' } };
    await m.deleteBackupConfirm('delete 2 a3f2');
    assert.match($('settings-dropbox-note').textContent, /The Dropbox backup was deleted and Coral disconnected/);
    assert.ok($('settings-dropbox-delete-confirm').hidden);
    assert.strictEqual($('settings-dropbox-delete-confirm').querySelector('img'), null);

    // Nothing from the server is put into the page as HTML.
    await status({ app_key_set: true, connected: true, state: 'connected', account_id: '<img src=x onerror=alert(1)>' });
    assert.strictEqual(document.querySelector('#settings-dropbox img'), null);

    // Removals after a delete here (#14814 reworked): the rule is said once connected; what waits, what is held and what Coral would not remove
    // on its own are listed with the Operator's own controls; nothing from the server is put in as HTML.
    const tick = () => new Promise(r => setTimeout(r, 0));
    const hexA = 'a'.repeat(64), hexB = 'b'.repeat(64), hexC = 'c'.repeat(64), hexD = 'd'.repeat(64), hexE = 'e'.repeat(64);
    answers['/api/dropbox/removals'] = { status: 200, body: { removals: [
        { digest: hexA, name: 'plan.md', state: 'held', due_at: '2026-11-10T12:00:00Z' },
        { digest: hexB, name: '<img src=x onerror=alert(1)>.md', state: 'kept', reason: 'others_offloaded', others: ['c0de'], unknown: 0 },
        { digest: hexC, name: 'notes.md', state: 'edited', edited: [{ path: '/v1/ccc/x/v1-cccccccc.md', rev: 'r2' }] },
        { digest: hexD, name: 'q.md', state: 'kept', reason: 'markers_unreadable' },
        { digest: hexE, name: 'w.md', state: 'waiting', due_at: '2026-11-10T12:00:00Z' },
    ] } };
    await status({ app_key_set: true, connected: true, state: 'connected', account_id: 'dbid:AAA', backup: { backed_up: 3 }, filters: { types: [], max_age_days: 0 }, retention: { days: 0 } });
    await tick(); await tick();
    const rm = $('settings-dropbox-removals');
    assert.ok(shown('settings-dropbox-delete-rule'), 'the rule is said once connected');
    assert.ok(!rm.hidden);
    assert.match(rm.textContent, /1 deleted file will be removed from Dropbox from/);
    assert.match(rm.textContent, /1 deleted file waits for your OK before leaving Dropbox: many files were deleted at once/);
    assert.match(rm.textContent, /Another Coral keeps it only in Dropbox \(…c0de\)/);
    assert.match(rm.textContent, /edited in Dropbox after Coral backed it up/);
    assert.match(rm.textContent, /could not check whether another Coral keeps it/);
    assert.strictEqual(rm.querySelector('img'), null, 'a name is text, never HTML');
    const rmBtn = t => Array.from(rm.querySelectorAll('button')).find(x => x.textContent === t);
    const rmBtns = t => Array.from(rm.querySelectorAll('button')).filter(x => x.textContent === t);
    const field = rm.querySelector('input');
    assert.ok(field && field.getAttribute('aria-label') && field.getAttribute('aria-describedby'), 'the typed field is labelled and described');
    assert.ok(document.getElementById(field.getAttribute('aria-describedby')).textContent.includes('Type the last 4 characters'));
    // The held ones: Remove them / Keep them in Dropbox.
    answers['/api/dropbox/removals/confirm'] = { status: 200, body: { confirmed: 1 } };
    rmBtn('Remove them after 24 hours').click(); await tick(); await tick();
    let c = calls.filter(x => x.url === '/api/dropbox/removals/confirm').pop();
    assert.deepStrictEqual(JSON.parse(c.body), { confirm: true });
    // The typed confirm, trimmed.
    answers[`/api/dropbox/remove/${hexB}`] = { status: 200, body: { removed: 2 } };
    rm.querySelector('input').value = ' c0de '; // the list was drawn again after the confirm
    rmBtn('Remove from Dropbox').click(); await tick(); await tick();
    c = calls.filter(x => x.url === `/api/dropbox/remove/${hexB}`).pop();
    assert.deepStrictEqual(JSON.parse(c.body), { confirm: true, typed: ['c0de'] });
    assert.match($('settings-dropbox-note').textContent, /was removed from Dropbox/);
    // Remove anyway at the rev shown.
    answers[`/api/dropbox/remove/${hexC}`] = { status: 200, body: { removed: 1 } };
    rmBtn('Remove anyway').click(); await tick(); await tick();
    c = calls.filter(x => x.url === `/api/dropbox/remove/${hexC}`).pop();
    assert.deepStrictEqual(JSON.parse(c.body), { confirm: true, anyway: { '/v1/ccc/x/v1-cccccccc.md': 'r2' } });
    // Keep it in Dropbox: one file; Keep them: the waiting ones.
    answers['/api/dropbox/removals/cancel'] = { status: 200, body: { kept: 1 } };
    rmBtns('Keep it in Dropbox')[0].click(); await tick(); await tick();
    c = calls.filter(x => x.url === '/api/dropbox/removals/cancel').pop();
    assert.deepStrictEqual(JSON.parse(c.body), { digest: hexB });
    rmBtns('Keep them in Dropbox').pop().click(); await tick(); await tick();
    c = calls.filter(x => x.url === '/api/dropbox/removals/cancel').pop();
    assert.ok(['held', 'waiting'].includes(JSON.parse(c.body).state));
    // Auto-sync of edits made in Dropbox (#14714): the switch, why it is paused, and Resume.
    await status({ app_key_set: true, connected: true, state: 'connected', account_id: 'dbid:AAA', backup: {}, filters: { types: [], max_age_days: 0 }, retention: { days: 0 }, autosync: { on: true, paused: 'breaker' } });
    assert.ok($('settings-dropbox-autosync').checked);
    assert.match($('settings-dropbox-autosync-note').textContent, /paused: too many arrived in an hour/);
    assert.ok(shown('settings-dropbox-autosync-resume'), 'Resume is offered');
    answers['/api/dropbox/autosync'] = { status: 200, body: { on: true, paused: '' } };
    $('settings-dropbox-autosync-resume').click(); await tick(); await tick();
    let sync = calls.filter(x => x.url === '/api/dropbox/autosync').pop();
    assert.strictEqual(sync.method, 'PUT');
    assert.deepStrictEqual(JSON.parse(sync.body), { on: true });
    assert.ok(!shown('settings-dropbox-autosync-resume'), 'resumed');
    answers['/api/dropbox/autosync'] = { status: 200, body: { on: false, paused: '' } };
    $('settings-dropbox-autosync').checked = false;
    $('settings-dropbox-autosync').dispatchEvent(new dom.window.Event('change')); await tick(); await tick();
    sync = calls.filter(x => x.url === '/api/dropbox/autosync').pop();
    assert.deepStrictEqual(JSON.parse(sync.body), { on: false });
    assert.match($('settings-dropbox-autosync-note').textContent, /wait here for you to decide/);

    // Free up space (#14845): the dry run, both sentences before Turn on, the kept count, and off.
    await status({ app_key_set: true, connected: true, state: 'connected', account_id: 'dbid:AAA', backup: {}, filters: { types: [], max_age_days: 0 }, retention: { days: 0 }, offload: { days: 0, kept: 3, kept_bytes: 3072 } });
    assert.match($('settings-dropbox-offload-kept').textContent, /3 files are \(.*\) kept only in Dropbox: they are coming back/);
    answers['/api/dropbox/offload'] = { status: 200, body: { dry_run: true, days: 90, count: 4, bytes: 4096, risk: 'RISK SENTENCE', warning: 'WARNING SENTENCE' } };
    $('settings-dropbox-offload-for').value = '90';
    await m.saveOffload();
    const ob = $('settings-dropbox-offload-confirm');
    assert.ok(!ob.hidden);
    assert.match(ob.textContent, /may free about 4 files .* older than 90 days/);
    assert.match(ob.textContent, /RISK SENTENCE/); assert.match(ob.textContent, /WARNING SENTENCE/);
    const onBtn = Array.from(ob.querySelectorAll('button')).find(b => b.textContent === 'Turn on');
    assert.ok(onBtn.disabled, 'Turn on waits for both sentences');
    $('settings-dropbox-offload-risk').checked = true; $('settings-dropbox-offload-risk').dispatchEvent(new dom.window.Event('change'));
    assert.ok(onBtn.disabled, 'one is not enough');
    $('settings-dropbox-offload-warning').checked = true; $('settings-dropbox-offload-warning').dispatchEvent(new dom.window.Event('change'));
    assert.ok(!onBtn.disabled);
    answers['/api/dropbox/offload'] = { status: 200, body: { days: 90 } };
    onBtn.click(); await tick(); await tick();
    const offSent = calls.filter(x => x.url === '/api/dropbox/offload').pop();
    assert.deepStrictEqual(JSON.parse(offSent.body), { days: 90, confirm: true, risk_ok: true, warning_ok: true, seen_count: 4, seen_bytes: 4096 });
    assert.match($('settings-dropbox-note').textContent, /Free up space is on/);
    $('settings-dropbox-offload-for').value = '10';
    await m.saveOffload();
    assert.match($('settings-dropbox-note').textContent, /0 \(off\) or 30 to 3650/, 'a value out of range sends nothing');
    // UI Accessibility's 3 to 5 on cee349ca6 (#14886): the rows' buttons say which file; a list action gives the keyboard back to the list; Resume
    // gives it to the switch.
    answers['/api/dropbox/removals'] = { status: 200, body: { removals: [{ digest: 'c'.repeat(64), name: 'notes.md', state: 'edited', edited: [{ path: '/v1/x', rev: 'r2' }] }, { digest: 'f'.repeat(64), name: 'plan.md', state: 'kept', reason: 'markers_unreadable' }] } };
    await m.loadRemovals();
    const rmb = $('settings-dropbox-removals');
    const rmLabels = Array.from(rmb.querySelectorAll('button')).map(x => x.getAttribute('aria-label'));
    assert.ok(rmLabels.includes('Remove anyway: notes.md') && rmLabels.includes('Keep it in Dropbox: notes.md') && rmLabels.includes('Try again: plan.md'), JSON.stringify(rmLabels));
    answers['/api/dropbox/removals/cancel'] = { status: 200, body: { kept: 1 } };
    Array.from(rmb.querySelectorAll('button')).find(x => x.getAttribute('aria-label') === 'Keep it in Dropbox: notes.md').click(); await tick(); await tick(); await tick();
    assert.ok(document.activeElement && (rmb.contains(document.activeElement) || document.activeElement.id === 'settings-dropbox-note'), 'the keyboard is back on the list or the status line, not the page');
    answers['/api/dropbox/autosync'] = { status: 200, body: { on: true, paused: '' } };
    $('settings-dropbox-autosync-resume').hidden = false;
    $('settings-dropbox-autosync-resume').click(); await tick(); await tick(); await tick();
    assert.strictEqual(document.activeElement && document.activeElement.id, 'settings-dropbox-autosync', 'Resume hides itself: the keyboard is on the switch');

    // Not connected: nothing about removals.
    await status({ app_key_set: true, connected: false, state: 'disconnected' });
    assert.ok(rm.hidden && !shown('settings-dropbox-delete-rule'));

    // Share via Dropbox (#14944): Settings lists the shared copies with Stop sharing and Stop all; Disconnect and Switch while files are shared say
    // how many and offer Stop all first, or leaving them shared (a second request with leave_shared).
    answers['/api/dropbox/shares'] = { status: 200, body: { connected: true, shares: [
        { id: 7, name: 'release-plan.md', audience: 'public', state: 'live', expires_at: '2026-12-09T10:00:00Z' },
        { id: 8, name: '<b>notes</b>.md', audience: 'people', people: 2, state: 'stopping' }] } };
    await status({ app_key_set: true, connected: true, state: 'connected', account_id: 'dbid:A' });
    await m.loadShares();
    const sh = $('settings-dropbox-shares');
    assert.ok(!sh.hidden, 'the shares are listed');
    assert.match(sh.textContent, /Shared through Dropbox \(2\)/);
    assert.match(sh.textContent, /release-plan\.md.*Shared with anyone with the link, until/);
    assert.match(sh.textContent, /Shared with 2 people\. Stopping did not finish: its link may still work\./);
    assert.ok(!sh.querySelector('b'), 'a name is text, never markup');
    assert.ok(!/https?:/.test(sh.textContent), 'no link is listed in Settings');
    const stopBtns = [...sh.querySelectorAll('button')].filter(b => b.textContent === 'Stop sharing');
    assert.strictEqual(stopBtns[0].getAttribute('aria-label'), 'Stop sharing release-plan.md');
    answers['/api/dropbox/share/stop/7'] = { status: 200, body: { stopped: 1 } };
    stopBtns[0].click(); await tick(); await tick(); await tick();
    assert.ok(calls.some(x => x.url === '/api/dropbox/share/stop/7' && x.method === 'POST'));
    assert.match($('settings-dropbox-note').textContent, /release-plan\.md is no longer shared/);

    answers['/api/dropbox/disconnect'] = { status: 409, body: { code: 'still_shared', count: 2, error: '2 files are still shared through Dropbox. Stop sharing them first, or leave them shared: after you disconnect, Coral can no longer stop sharing them, but you can in Dropbox' } };
    await m.disconnectDropbox();
    const box = $('settings-dropbox-delete-confirm');
    assert.ok(!box.hidden);
    assert.match(box.textContent, /2 files are still shared/);
    const labels = [...box.querySelectorAll('button')].map(b => b.textContent);
    assert.deepStrictEqual(labels, ['Stop all, then disconnect', 'Leave them shared and disconnect', 'Cancel']);
    answers['/api/dropbox/disconnect'] = { status: 200, body: { connected: false, revoked: true } };
    box.querySelectorAll('button')[1].click(); await tick(); await tick(); await tick();
    const last = calls.filter(x => x.url === '/api/dropbox/disconnect').pop();
    assert.deepStrictEqual(JSON.parse(last.body), { leave_shared: true }, 'leaving them shared is a second, explicit request');
    assert.ok(box.hidden);

    // Stop all, then disconnect: Stop all first, then the plain disconnect again.
    answers['/api/dropbox/disconnect'] = { status: 409, body: { code: 'still_shared', count: 1, error: '1 file is still shared through Dropbox.' } };
    await m.disconnectDropbox();
    answers['/api/dropbox/shares/stop-all'] = { status: 200, body: { stopped: 1 } };
    answers['/api/dropbox/disconnect'] = { status: 200, body: { connected: false, revoked: true } };
    const callsBefore = calls.length;
    $('settings-dropbox-delete-confirm').querySelector('button').click();
    for (let i = 0; i < 6; i++) await tick();
    const after = calls.slice(callsBefore).map(x => x.url + ' ' + (x.body || ''));
    const iStop = after.findIndex(u => u.startsWith('/api/dropbox/shares/stop-all {"confirm":true}'));
    const iDisc = after.findIndex(u => u.startsWith('/api/dropbox/disconnect {}'));
    assert.ok(iStop >= 0 && iDisc > iStop, 'Stop all, then the disconnect without leave_shared: ' + JSON.stringify(after));

    console.log('dropbox_settings.test.js: ok');
})().catch(e => { console.error(e); process.exit(1); });
