// A send to an agent whose name or type this page holds out of date (it was restarted or renamed since the list was read) never leaves
// the person with a bare 'session target mismatch' (#10813):
//   - the composer reads the list again and sends once more with what it now says: the message goes, no error shows;
//   - when the server still refuses, the words say what happened and what to do, the text is back in the box, and nothing says
//     'session target mismatch'.
// The agent and its routes are mocked in the page (agent_view_harness.js); the rest is the isolated test server. Drives Chrome over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

// Sends to /api/sessions/live/<name>/send, recorded as window.__sends: the name in the path. 'tm-old' is refused as the server refuses a
// name that is not the stored one (400, code session_target_mismatch); 'tm-new' is accepted; 'tm-stuck' is always refused.
const STUB = `(() => {
    const prev = window.fetch;
    window.__sends = [];
    const json = (b, status) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    window.fetch = (url, opts = {}) => {
        const m = /\\/api\\/sessions\\/live\\/([^/]+)\\/send$/.exec(String(url));
        if (m && (opts.method || 'GET').toUpperCase() === 'POST') {
            const name = decodeURIComponent(m[1]);
            window.__sends.push(name);
            if (name === 'tm-new') return Promise.resolve(json({ status: 'sent' }, 200));
            return Promise.resolve(json({ error: 'session target mismatch', code: 'session_target_mismatch' }, 400));
        }
        if (/\\/api\\/sessions\\/live(\\?|$)/.test(String(url)) && (opts.method || 'GET').toUpperCase() === 'GET') { // the list the page reads again: what the mock holds now
            return Promise.resolve(json(Object.values(window.__m.agents).map(a => window.__m.entry(a)), 200));
        }
        return prev(url, opts);
    };
})()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const type = text => ev(`(() => { const i = document.getElementById('command-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const send = () => ev(`window.sendCommand(); true`);
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); window.__m.add('tm-old', 'A', 2, { sleeping: false, session_id: 'tm-old-id' }); true`);
        await select('tm-old');
        await waitFor(`!!document.getElementById('command-input')`, 'the composer');

        console.log('the page holds the old name: the list is read again and the send goes once more with the new one');
        await ev(`window.__m.add('tm-new', 'A', 2, { sleeping: false, session_id: 'tm-old-id' }); true`); // what the list now says
        await type('hello after restart');
        await send();
        await waitFor(`window.__sends.length >= 2`, 'the second send', 8000);
        assert.deepEqual(await ev(`window.__sends`), ['tm-old', 'tm-new'], 'refused once with the old name, then sent with the one the list now says');
        assert.equal(await ev(`!!document.querySelector('#composer-error:not([hidden]) .composer-error-text')`), false, 'no error under the composer');

        console.log('the server still refuses: plain words, the text is back, never the bare refusal');
        await ev(`window.__sends.length = 0; window.__m.add('tm-stuck', 'A', 2, { sleeping: false, session_id: 'tm-old-id' }); true`);
        await type('this one stays');
        await send();
        await waitFor(`!!document.querySelector('#composer-error .composer-error-text') && document.querySelector('#composer-error .composer-error-text').textContent.trim() !== ''`, 'the composer error', 8000);
        const text = await ev(`document.querySelector('#composer-error .composer-error-text').textContent.trim()`);
        assert.match(text, /restarted or renamed/i, 'it says what happened: ' + text);
        assert.match(text, /reload/i, 'and what to do: ' + text);
        assert.doesNotMatch(text, /session target mismatch/i, 'never the bare refusal: ' + text);
        assert.equal(await ev(`document.getElementById('command-input').value`), 'this one stays', 'the text is back in the box');
        const sends = await ev(`window.__sends`);
        assert.equal(sends.length, 2, 'the held name, then once more with the list\'s, and no third try: ' + JSON.stringify(sends));
        assert.equal(sends[1], 'tm-stuck', 'the second try used what the list says');
        console.log('PASS a stale send target is retried once, then said in words');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
