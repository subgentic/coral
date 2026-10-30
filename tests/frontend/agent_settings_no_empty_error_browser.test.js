// An agent's page on the team's Agents tab (Review settings, its Save bar) shows no empty red-bordered box under the bar (#11219, the operator's screenshot): the "could not be read" alert was always in the page, empty, and
// drawn as a box (display: flex beats the hidden attribute it was meant to have). It is hidden with no text, and shown only with its sentence and Try again when the settings could not be read. Real board on the isolated dev server.
const assert = require('node:assert/strict');
const { safePaused } = require('./helpers/paused');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Fetch } = client;
    const B = 'ase-' + Date.now().toString(36);
    const api = (m, p, b) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${b ? JSON.stringify(JSON.stringify(b)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    // every visible box wider than 100 px with a red border and nothing in it
    const EMPTY_RED = `(() => { const out = []; for (const e of document.querySelectorAll('body *')) { if (!e.getClientRects().length) continue; const r = e.getBoundingClientRect(); if (r.width < 100 || r.height < 8) continue;
        const cs = getComputedStyle(e); if (!parseFloat(cs.borderTopWidth) || cs.borderTopStyle === 'none') continue; const m = cs.borderTopColor.match(/rgba?\\(([\\d.]+), ([\\d.]+), ([\\d.]+)/); if (!m || !(+m[1] > 150 && +m[2] < 120 && +m[3] < 120)) continue;
        if (!e.textContent.trim()) out.push((e.tagName + '.' + e.className).slice(0, 60)); } return out; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'orch-s' })).status < 300);
        let failReads = false; // the review settings read (GET /subscribers) answered 500
        await Fetch.enable({ patterns: [{ urlPattern: `*/api/board/${B}/subscribers`, requestStage: 'Request' }] });
        safePaused(client, e => (failReads && e.request.method === 'GET'
            ? Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 500, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{"error":"boom"}').toString('base64') })
            : Fetch.continueRequest({ requestId: e.requestId })));
        const openAgent = async () => {
            await Page.navigate({ url: BASE + `/team/${B}/agents` }); await Page.loadEventFired(); await install();
            await waitFor(`!!document.querySelector('[id^=team-panel]:not([hidden]) tbody tr .dt-primary, [id^=team-panel]:not([hidden]) tbody tr')`, 'the agent row', 15000);
            await ev(`(document.querySelector('[id^=team-panel]:not([hidden]) tbody tr .dt-primary') || document.querySelector('[id^=team-panel]:not([hidden]) tbody tr')).click(); true`);
            await waitFor(`/Review settings/.test(document.body.innerText) && !!document.querySelector('.sv-bar, [class*="sv-bar"]') || /No changes to save/.test(document.body.innerText)`, 'the agent page with its Save bar', 15000);
        };

        console.log('1. Settings read fine: the Save bar, and no empty red box under it');
        await openAgent();
        await waitFor(`/No changes to save\\./.test(document.body.innerText)`, 'the bar says no changes', 15000);
        assert.deepEqual(await ev(EMPTY_RED), [], 'no empty red-bordered box on the agent page');
        console.log('   ✓');

        console.log('2. The read fails: the box shows its sentence, with Try again');
        failReads = true;
        await openAgent();
        await waitFor(`!!document.querySelector('p.goals-failed') && !document.querySelector('p.goals-failed').hidden && document.querySelector('p.goals-failed').textContent.trim().length > 0`, 'the error sentence', 15000);
        assert.equal(await ev(`/could not be read/i.test(document.querySelector('p.goals-failed').textContent)`), true, 'it says what happened');
        assert.equal(await ev(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Try again' && b.getClientRects().length > 0)`), true, 'with Try again');
        console.log('   ✓');
        console.log('PASS agent settings: no empty red box; the read failure shows its sentence and Try again');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
