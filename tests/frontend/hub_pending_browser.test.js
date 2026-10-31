// (#11463 F2, coral-hub's first-time-user walk) A computer approved on the Hub that has not connected yet: the home card, the empty agent list and the Computers page say what is going on (name as text, the three
// things to check, 'Never connected: start again' once it ran out), and the first-run card does not. A hub that has no pending route yet is the plain first run. Built on the first-run suite below.
// Coral Hub's first run (#4586, coral-hub's copy): an account whose machine list loaded and is empty gets "Connect your first computer" (install Coral on each, then Settings > Network and Hub > Connect to Coral Hub) with an Add a computer link (the hub's /machines/add, same tab, #6351)
// instead of launch cards that go nowhere, and the empty agent list says so too (it is the phone's Agents page); computers that are all offline get "Your computers are offline"; a usable
// machine with no agents gets "No agents yet"; a list that failed to load is never shown as a first run. A folder Browse says "Connect a computer first" instead of "Failed to load".
// A local Coral never shows any of it. Served as the hub would serve it (the boot flag says mode
// "cloud", as in hub_nav_browser) with the list of servers answered by the test.
//
// Expects CORAL_TEST_URL + CDP_PORT from the runner. CORAL_SCREENSHOT_DIR=<dir> saves screenshots.
const assert = require('node:assert/strict');
const { safePaused } = require('./helpers/paused');
const fs = require('node:fs');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Network, Fetch, Emulation } = client;
    const ev = async expression => { const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
    const { waitFor } = require('./helpers/wait').bind(ev);
const { settle } = require('./helpers/wait');
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the layout settles over frames after a viewport change; there is no completion event
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await settle(ev, 300); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }; // sleep-ok: the screenshot waits for the layout to settle
    let cloud = true, machines = [], listFails = false, enrollHit = 0, pending = [], pendingStatus = 200;
    try {
        await Promise.all([Page.enable(), Runtime.enable(), Network.enable()]);
        await Network.setCacheDisabled({ cacheDisabled: true });
        await Fetch.enable({ patterns: [{ urlPattern: `${BASE}/`, resourceType: 'Document', requestStage: 'Response' }, { urlPattern: `${BASE}/auth/session`, requestStage: 'Request' },
            { urlPattern: `${BASE}/api/servers*`, requestStage: 'Request' }, { urlPattern: `${BASE}/api/servers/pending*`, requestStage: 'Request' }, { urlPattern: `${BASE}/api/sessions/live*`, requestStage: 'Request' }, { urlPattern: `${BASE}/machines/add*`, requestStage: 'Request' }] });
        const json = (id, status, body) => Fetch.fulfillRequest({ requestId: id, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });
        safePaused(client, async e => {
            const u = e.request.url;
            if (u.endsWith('/auth/session')) return json(e.requestId, 200, { authenticated: true, email: 'tester@example.com', csrf: 'x' });
            if (/\/api\/servers\/pending(\?|$)/.test(u)) return pendingStatus === 200 ? json(e.requestId, 200, { pending }) : json(e.requestId, pendingStatus, { error: 'not here' });
            if (/\/api\/servers(\?|$)/.test(u)) return json(e.requestId, 200, { servers: machines.map(m => ({ id: m.id, label: m.label, online: m.status === 'online', created_at: '2026-10-01T00:00:00Z', last_seen: '2026-10-18T00:00:00Z' })) });
            if (/\/api\/sessions\/live(\?|$)/.test(u)) return listFails ? json(e.requestId, 500, { error: 'boom' }) : json(e.requestId, 200, cloud ? { sessions: [], servers: machines } : []);
            if (/\/machines\/add(\?|$)/.test(u)) { enrollHit++; return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from('<!doctype html><title>add</title>').toString('base64') }); }
            if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
            const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
            let html = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
            if (cloud) html = html.replace('"mode":"local"', '"mode":"cloud"');
            const headers = (e.responseHeaders || []).filter(h => !/^content-length$/i.test(h.name));
            await Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: headers, body: Buffer.from(html).toString('base64') });
        });
        const open = async (w, h) => {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: w < 700 ? 2 : 1, mobile: w < 700 });
            await Emulation.setTouchEmulationEnabled({ enabled: w < 700 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await settle(ev, 2500); // sleep-ok: the page and its first list of servers arrive from requests; there is no completion event for them
            assert.equal(await ev(`document.body.classList.contains('cloud-mode')`), cloud, 'the page is served as the hub or as a local Coral');
        };
        const shown = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; })()`;
        const HOSTILE = 'home<img src=x onerror="window.__pwned=1"> box';
        const iso = mins => new Date(Date.now() + mins * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
        for (const [w, h] of [[1280, 756], [390, 756]]) {
            const tag = `${w}:`;
            console.log(`${tag} a waiting computer: the home card and the empty list say so, the name is text, the checks are there, "Connect your first computer" is not`);
            pending = [{ label: HOSTILE, state: 'waiting', expires_at: iso(7), requested_at: iso(-3) }]; pendingStatus = 200;
            await open(w, h);
            await waitFor(`document.body.classList.contains('hub-machine-waiting')`, 'the waiting state', { timeout: 8000 });
            const list = `((document.getElementById('live-sessions-list') && document.getElementById('live-sessions-list').innerText) || (document.getElementById('mobile-agent-list') && document.getElementById('mobile-agent-list').innerText) || '').replace(/\\s+/g, ' ').trim()`;
            await waitFor(`/Waiting for/.test(${list})`, 'the empty list to say so', { timeout: 8000 });
            const wait = await ev(`({ list: ${list}, pwned: !!window.__pwned, imgs: document.querySelectorAll('#live-sessions-list img, .welcome-waiting img, #mobile-agent-list img').length, home: (document.querySelector('.welcome-waiting') || { textContent: 'NO .welcome-waiting' }).textContent, shownWaiting: (${shown('.welcome-waiting')}), shownFirst: (${shown('.welcome-first-run')}) })`);
            assert.ok(wait.list.includes('Waiting for ' + HOSTILE + ' to connect (expires '), 'the list names the computer, as text: ' + wait.list);
            assert.ok(/Coral is running/.test(wait.list) && /reach this hub/.test(wait.list) && /time left/.test(wait.list), 'the three checks: ' + wait.list);
            assert.ok(!/Connect your first computer/.test(wait.list), 'not the first-run line: ' + wait.list);
            assert.equal(wait.pwned, false, 'the name did not run');
            assert.equal(wait.imgs, 0, 'the name is text, not an element');
            if (w > 700) { // the phone has no home card: its Agents page is the list
                assert.ok(wait.home.includes('Waiting for ' + HOSTILE + ' to connect (expires '), 'the home card: ' + wait.home); assert.equal(wait.shownWaiting, true, 'the home card is the waiting one'); assert.equal(wait.shownFirst, false, 'and not "Connect your first computer"'); await shot('hub-waiting-' + w); }

            console.log(`${tag} expired and never connected: "Never connected: start again" with Add a computer`);
            pending = [{ label: 'vps-1', state: 'expired', expires_at: iso(-20), requested_at: iso(-30) }];
            await open(w, h);
            await waitFor(`/Never connected: start again \\(vps-1\\)/.test(${list})`, 'the never-connected line', { timeout: 8000 });
            assert.equal(await ev(`!!document.querySelector('#live-sessions-list a.btn[href="/machines/add"], #mobile-agent-list a.btn[href="/machines/add"]')`), true, 'Add a computer');
            assert.equal(await ev(`document.body.classList.contains('hub-machine-waiting')`), false);
            await shot('hub-never-connected-' + w);

            console.log(`${tag} a hub that has no pending list yet is the plain first run`);
            pendingStatus = 404;
            await open(w, h);
            await waitFor(`/Connect your first computer/.test(${list}) || /No computers connected yet/.test(${list})`, 'the plain first run', { timeout: 8000 });
            assert.equal(await ev(`document.body.classList.contains('hub-machine-waiting') || /Waiting for|Never connected/.test(${list})`), false);
            pendingStatus = 200;

            console.log(`${tag} the Computers page lists it too, with the three checks`);
            pending = [{ label: HOSTILE, state: 'waiting', expires_at: iso(7), requested_at: iso(-3) }];
            await open(w, h);
            await ev(`window.switchNavTab('servers'); true`);
            await waitFor(`!!document.getElementById('cs-pending')`, 'the pending block on the Computers page', { timeout: 10000 });
            const cs = await ev(`({ text: document.getElementById('cs-pending').innerText.replace(/\\s+/g, ' '), imgs: document.querySelectorAll('#cs-pending img').length, pwned: !!window.__pwned, wide: document.documentElement.scrollWidth - document.documentElement.clientWidth })`);
            assert.ok(cs.text.includes('Waiting for ' + HOSTILE + ' to connect (expires '), cs.text);
            assert.ok(/Coral is running/.test(cs.text) && /reach this hub/.test(cs.text) && /time left/.test(cs.text), cs.text);
            assert.equal(cs.imgs, 0); assert.equal(cs.pwned, false); assert.ok(cs.wide <= 0, 'no sideways scroll: ' + cs.wide);
            await shot('hub-pending-computers-' + w);
        }
        console.log('   ✓');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
