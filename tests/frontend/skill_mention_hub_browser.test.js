// The $ menu on a Hub-served dashboard (#12766, QA's SHOULD 4): skills stay on the computer, so "$" there opens one row that says so and asks no route: no search, nothing to attach. The page is the local server's own
// with the Hub's boot flag and a Hub sign-in answered (as cloud_automations_redirect_browser does it). A local dashboard, in the same run, lists the skills (so the check that none is asked on the Hub is not dead).
const assert = require('node:assert/strict');
const { safePaused } = require('./helpers/paused');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

const SKILLS = [{ id: 'a'.repeat(32), name: 'abstract-review', version: 1, description: 'Review a change' }];
const STUB = `(() => { window.__skillAsks = []; const R = window.fetch; const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
    window.fetch = (u, o) => { const url = new URL(String(u), location.href); if (/skills/.test(url.pathname)) window.__skillAsks.push([(o && o.method) || 'GET', url.pathname]);
        if (url.pathname === '/api/skills/search') return json({ skills: ${JSON.stringify(SKILLS)} });
        return R(u, o); }; })();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Fetch, Network, Input } = client;
    const menu = () => ev(`(() => { const d = document.querySelector('.skill-mention-dropdown'); if (!d || getComputedStyle(d).display === 'none') return null; return [...d.querySelectorAll('.skill-mention-item')].map(n => n.textContent.trim().replace(/\\s+/g, ' ')); })()`);
    const open = async url => {
        await Page.navigate({ url }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); window.__m.add('hub-a', 'A', 3, { sleeping: false, session_id: 'hub-a-id' }); window.selectLiveSession('hub-a', 'claude', 'hub-a-id', 'local'); true`);
        await waitFor(`!!document.getElementById('command-input') && !document.getElementById('command-input').disabled`, 'the composer', 10000);
        await ev(`document.getElementById('command-input').focus(); true`); await Input.insertText({ text: '$' });
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        // the control: a local dashboard lists the skill
        await open(process.env.CORAL_TEST_URL + '/');
        await waitFor(`!!document.querySelector('.skill-mention-item')`, 'the local menu', 6000);
        assert.deepEqual(await menu(), ['abstract-review Review a change'], 'local: the approved skill is listed');
        assert.ok((await ev(`window.__skillAsks`)).some(x => x[1] === '/api/skills/search'), 'local: the search route is asked');
        // the Hub
        await Network.enable(); await Network.setBypassServiceWorker({ bypass: true });
        await Fetch.enable({ patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }, { urlPattern: '*/auth/session', requestStage: 'Request' }] });
        safePaused(client, async e => {
            if (e.request.url.endsWith('/auth/session')) return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ authenticated: true, email: 'qa@example.com', csrf: 'qa-csrf' })).toString('base64') });
            if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
            const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
            const html = (base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body).replace(/"mode":\s*"local"/, '"mode":"cloud"');
            return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: (e.responseHeaders || []).filter(h => !/^content-length$/i.test(h.name)), body: Buffer.from(html).toString('base64') });
        });
        await open(process.env.CORAL_TEST_URL + '/');
        await waitFor(`!!document.getElementById('coral-boot') && JSON.parse(document.getElementById('coral-boot').textContent).mode === 'cloud'`, 'the Hub\'s boot flag', 10000);
        await waitFor(`!!document.querySelector('.skill-mention-item')`, 'the Hub\'s menu', 6000);
        const rows = await menu();
        assert.equal(rows.length, 1, 'one row: ' + JSON.stringify(rows));
        assert.match(rows[0], /^Skills stay on the computer/, 'the row says skills stay on the computer');
        // pressing Enter on it does nothing: no attach, the text stays
        await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await new Promise(r => setTimeout(r, 400)); // sleep-ok: nothing is the expected result; no event to wait for
        assert.equal(await ev(`document.getElementById('command-input').value`), '$', 'Enter on the note changes nothing');
        assert.deepEqual(await ev(`window.__skillAsks`), [], 'no skill route is asked on the Hub: ' + JSON.stringify(await ev(`window.__skillAsks`)));
        console.log('PASS the $ menu on the Hub: one note, no route asked');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
