// The Servers page on a phone (#10763, coral-hub's UI/UX note): the row's expand control, the access selectors and the side gutters. Setup from servers_table_browser.
// Servers tab (#3070): the Cloud Hub's machines (and a self-hosted hub's remotes) are a top-level tab, not a
// dialog. Pins: when the tab shows, the nav button's aria-current, the region and focus, each row's one lower-only
// 'Hub access' control (Follow this computer / Limit to Interact / Limit to View: PATCH {access_mode}, no Raise, no Launch dialog), Revoke
// contrast, deep links (#servers, #servers/<id>, the agent list's server chip), no overflow at 375 px with the
// actions stacked, and the enroll page's Servers note.
//
// Drives Chrome over CDP (chrome-remote-interface) through agent_view_harness.js; run_cdp_suites.mjs
// finds CDP suites by that name.
const assert = require('node:assert/strict');
const { safePaused } = require('./helpers/paused');
const { themeJs } = require('./helpers/theme');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');

const BASE = require('./test_base').BASE;
const { framesJs } = require('./helpers/wait');

const SERVERS = [
    { id: 'm1', label: 'Box One', online: true, access_mode: 'view', local_mode: 'launch', last_seen: '2026-10-13T00:00:00Z' },
    { id: 'm2', label: 'box two', online: true, access_mode: 'follow', local_mode: 'view', last_seen: '2026-10-13T00:00:00Z' },
    { id: 'm3', label: 'Box Three', online: false, access_mode: 'follow', local_mode: 'launch', last_seen: '2026-10-12T00:00:00Z' },
    { id: 'm4', label: 'Box Four', online: true, access_mode: 'interact', effective_mode: 'view', limited_by: 'machine', last_seen: '2026-10-13T00:00:00Z' },
];
const SESSIONS = [{ session_id: 'a1', name: 'waiter', agent_type: 'claude', server: 'm1', waiting_for_input: true }, { session_id: 'a2', name: 'busy', agent_type: 'claude', server: 'm1', waiting_for_input: false }]; // one agent of Box One waits for its person (the Needs you column)
const LIVE = [
    { id: 'm1', label: 'Box One', status: 'online', coral_version: '1.4.10', agents: 7, update: 'required', latest_coral: '1.5.0' },
    { id: 'm2', label: 'box two', status: 'online', version: '1.4.9', agents: 1, update: 'available', latest_coral: '1.5.0' },
    { id: 'm3', label: 'Box Three', status: 'offline', coral_version: '1.5.0', agents: 0, update: 'current' },
    { id: 'm4', label: 'Box Four', status: 'online', agents: 12, update: 'unknown' },
];
const DOWNLOAD = 'https://coralhub.dev/coral.html#download';

const CLOUD_PRELOAD = `(() => {
    window.__qaServers = ${JSON.stringify(SERVERS)};
    window.__patches = []; window.__serverGets = 0;
    const inner = window.fetch;
    window.fetch = (url, opts = {}) => {
        const p = new URL(String(url), location.origin).pathname;
        const m = (opts.method || 'GET').toUpperCase();
        if (p === '/api/servers' && m === 'GET') {
            window.__serverGets++;
            return Promise.resolve(new Response(JSON.stringify({ servers: window.__qaServers }), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        const pm = p.match(/^\\/api\\/servers\\/([^/]+)$/);
        if (pm && m === 'PATCH') {
            const body = JSON.parse(opts.body || '{}');
            window.__patches.push({ id: decodeURIComponent(pm[1]), body });
            const row = window.__qaServers.find(s => s.id === decodeURIComponent(pm[1]));
            if (row && body.access_mode) row.access_mode = body.access_mode;
            return Promise.resolve(new Response(JSON.stringify(row || {}), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        if (pm && m === 'DELETE') { (window.__deletes = window.__deletes || []).push(decodeURIComponent(pm[1])); return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })); }
        return inner(url, opts);
    };
})();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const { Fetch, Network } = client;

    const cloudMode = async on => {
        await Fetch.disable();
        if (!on) return;
        await Fetch.enable({ patterns: [
            { urlPattern: `${BASE}/*`, resourceType: 'Document', requestStage: 'Response' }, // every dashboard page (#3532)
            { urlPattern: `${BASE}/auth/session`, requestStage: 'Request' },
        ] });
    };
    safePaused(client, async e => {
        if (e.request.url.endsWith('/auth/session')) {
            return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
                body: Buffer.from(JSON.stringify({ authenticated: true, email: 'qa@example.com', csrf: 'qa-csrf' })).toString('base64') });
        }
        if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
        const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
        const html = (base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body).replace('"mode":"local"', '"mode":"cloud"');
        const headers = (e.responseHeaders || []).filter(h => !/^content-(length|encoding)$/i.test(h.name));
        return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: headers, body: Buffer.from(html).toString('base64') });
    });
    const open = async (where = '') => { // a path ("servers/m2") or an old hash link ("#servers")
        // A fresh load every time: since #3529 the dashboard URL has no query, so going from
        // /#a to /#b is a same-document hash change that fires no load event. Each wait is
        // registered before its navigation, or about:blank's quick load could be missed.
        const blank = Page.loadEventFired();
        await Page.navigate({ url: 'about:blank' });
        await blank;
        const loaded = Page.loadEventFired();
        await Page.navigate({ url: BASE + '/' + where });
        await loaded;
        await install();
        await ev(`(() => { T.state.servers = ${JSON.stringify(LIVE)}; T.state.liveSessions = ${JSON.stringify(SESSIONS)}; return true; })()`);
    };
    const problems = [];
    try {
        await Promise.all([Page.enable(), Network.enable()]);
        await Network.setBypassServiceWorker({ bypass: true });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: CLOUD_PRELOAD });
        await cloudMode(true);
        for (const [w, h] of [[320, 640], [390, 844]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
            await open('servers');
            await waitFor(`document.querySelectorAll('#servers-view tr.cs-row').length === ${SERVERS.length}`, `${w}: rows`, 8000);
            const list = await ev(`(() => { const hs = sel => [...document.querySelectorAll(sel)].filter(b => b.getClientRects().length).map(b => Math.round(b.getBoundingClientRect().height)); const v = document.getElementById('servers-view'); const first = v.querySelector('.servers-tab'); const fr = first && first.getBoundingClientRect(); return { toggles: hs('#servers-view .cs-toggle'), selects: hs('#servers-view select'), gutterLeft: fr ? Math.round(fr.left) : null, gutterRight: fr ? Math.round(innerWidth - fr.right) : null, firstClass: first && first.className }; })()`);
            if (list.toggles.some(x => x < 44)) problems.push(`${w}: the row's expand control is ${Math.min(...list.toggles)} px tall (44 on a phone)`);
            if (list.selects.some(x => x < 44)) problems.push(`${w}: an access selector is ${Math.min(...list.selects)} px tall (44 on a phone)`);
            if (list.gutterLeft !== 16 || list.gutterRight < 16 || list.gutterRight > 20) // the right side may hold a thin scrollbar
                problems.push(`${w}: the Servers page gutters are ${list.gutterLeft} and ${list.gutterRight} px (16 like the rest), first block ${list.firstClass}`);
            await ev(`document.querySelector('#servers-view tr.cs-row .cs-name, #servers-view tr.cs-row').click(); true`).catch(() => {});
            await open('servers/m1');
            await waitFor(`!!document.querySelector('#servers-view section.cs-page')`, `${w}: the machine's page`, 8000);
            const page = await ev(`(() => { const hs = sel => [...document.querySelectorAll(sel)].filter(b => b.getClientRects().length).map(b => Math.round(b.getBoundingClientRect().height)); const s = document.querySelector('#servers-view section.cs-page'), r = s.getBoundingClientRect(); return { selects: hs('#servers-view section.cs-page select'), buttons: hs('#servers-view section.cs-page button'), left: Math.round(r.left), right: Math.round(innerWidth - r.right) }; })()`);
            if (page.selects.some(x => x < 44)) problems.push(`${w}: the machine page's access selector is ${Math.min(...page.selects)} px tall`);
            if (page.buttons.some(x => x < 44)) problems.push(`${w}: a button of the machine page is ${Math.min(...page.buttons)} px tall`);
            if (page.left !== 16 || page.right < 16 || page.right > 20) problems.push(`${w}: the machine page's gutters are ${page.left} and ${page.right} px (16)`);
        }
    } finally { await cloudMode(false).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'the Servers page on a phone:\n  ' + problems.join('\n  '));
    console.log('PASS the Servers page has 44 px targets and 16 px gutters on a phone');
})().catch(e => { console.error(e); process.exit(1); });
