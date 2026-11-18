// #19630 (Hub beta, #19626 audit step 5): a button that calls a route the Hub never serves is not drawn on a Hub session. The Knowledge tab of a team is the page driven here: on a local dashboard
// "Add note" is beside "Distill knowledge" and an agent's note has Edit (POST and PUT .../knowledge are never in the tunnel); on the Hub's page (the local server's own with the Hub's boot flag and a Hub sign-in
// answered, as team_presets_hub_browser does it) neither is drawn, and Distill knowledge (a Launch route the Hub has) stays. The knowledge read is stubbed in the page. Isolated dev server; drives Chrome over CDP.
const assert = require('node:assert/strict');
const { safePaused } = require('./helpers/paused');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-dead-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Fetch, Network } = client;
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const stub = () => ev(`(() => { const bundle = { exists: true, team_name: '${TEAM}', created_at: '2026-11-14T05:00:00Z', index: '# Index\\n\\nThe team.', agents: [{ name: 'Backend Dev', content: 'Backend knowledge text.' }] };
        const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (/\\/api\\/teams\\/detail\\/[^/]+\\/knowledge$/.test(url.pathname) && String((o && o.method) || 'GET').toUpperCase() === 'GET') return Promise.resolve(new Response(JSON.stringify(bundle), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            return R(u, o); }; return true; })()`);
    const open = async (hub) => {
        await Emulation.setDeviceMetricsOverride({ width: 1600, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); if (!hub) await coralReady(); await installTP(ev); // the Hub page does not signal __coralReady (team_presets_hub_browser does not wait for it)
        await seed(ev, TEAM); await stub();
        await openTeam(ev, waitFor, TEAM).catch(() => {});
        await goTab(ev, settle, 'Knowledge');
        await waitFor(`!!document.querySelector('.team-knowledge-body .team-distill')`, 'the Knowledge tab', 10000);
    };
    const bar = () => ev(`[...document.querySelectorAll('.team-knowledge-body .team-toolbar-row button')].filter(b => !b.hidden && b.checkVisibility({ checkVisibilityCSS: true })).map(b => b.textContent)`);
    const openEntry = async () => {
        await ev(`(() => { const r = [...document.querySelectorAll('.team-knowledge-body tr[data-key]')].find(x => /Backend Dev/.test(x.textContent)); r.click(); return true; })()`);
        await waitFor(`/Backend Dev/.test(document.querySelector('#detail-pane .detail-title')?.textContent || '') && /Backend knowledge text/.test(document.querySelector('#detail-pane')?.innerText || '')`, 'the entry pane with its text', 8000); // a pane with no action has no bar at all
        return ev(`[...document.querySelectorAll('#detail-pane .detail-foot button')].map(b => b.textContent)`);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await S.run('local: Add note and Edit are there (so the Hub check below is not dead)', async () => {
            await open();
            assert.deepEqual(await bar(), ['Add note', 'Distill knowledge']);
            assert.ok((await openEntry()).includes('Edit'), 'an agent note has Edit');
        });
        await S.run('Hub: no Add note and no Edit; Distill knowledge stays', async () => {
            await Network.enable(); await Network.setBypassServiceWorker({ bypass: true });
            await Fetch.enable({ patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }, { urlPattern: '*/auth/session', requestStage: 'Request' }] });
            safePaused(client, async e => {
                if (e.request.url.endsWith('/auth/session')) return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ authenticated: true, email: 'qa@example.com', csrf: 'qa-csrf' })).toString('base64') });
                if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
                const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
                const html = (base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body).replace(/"mode":\s*"local"/, '"mode":"cloud"');
                return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: (e.responseHeaders || []).filter(h => !/^content-length$/i.test(h.name)), body: Buffer.from(html).toString('base64') });
            });
            await open(true);
            assert.equal(await ev(`JSON.parse(document.getElementById('coral-boot').textContent).mode`), 'cloud', 'the page believes it is on the Hub');
            assert.deepEqual(await bar(), ['Distill knowledge']);
            assert.ok(!(await openEntry()).includes('Edit'), 'no Edit on a note through the Hub');
        });
        await removeBoards(ev, [TEAM]); S.finish();
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
