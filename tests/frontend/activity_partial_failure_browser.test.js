// #21399: a failed computer must not turn Activity into an apparently empty record.
// The same scenes capture the unchanged base with ACTIVITY_EVIDENCE_ONLY=1.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const sceneShots = require('./helpers/scene_shots');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = sceneShots(Page, 'activity-partial');
    const evidenceOnly = process.env.ACTIVITY_EVIDENCE_ONLY === '1';
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [390, 1280]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(async () => {
                localStorage.removeItem('coral.inbox.tab'); localStorage.removeItem('coral-inbox-activity-filters');
                document.documentElement.setAttribute('data-theme', 'dark');
                const { state } = await import(${S} + 'state.js');
                state.hub = true; state.servers = [{ id: 'alpha', label: 'Alpha', status: 'online' }];
                state.settings = { ...state.settings, inbox_welcome: 'off' };
                window.__activityCase = 'empty'; window.__activityAsked = [];
                const real = window.fetch;
                window.fetch = (u, o) => {
                    const p = new URL(String(u), location.href).pathname;
                    const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
                    if (p === '/api/activity' || p === '/api/remote/alpha/api/activity') {
                        window.__activityAsked.push(p);
                        if ((p.includes('/remote/') && window.__activityCase !== 'recovered') || window.__activityCase === 'all-failed') return json({ error: 'unavailable' }, 502);
                        const actions = window.__activityCase === 'rows' ? [{ id: 1, at: '2026-11-25T12:00:00Z', action: 'approve', item_kind: 'file', item_id: 'a'.repeat(64), title: 'Release plan', team: 'team', source: 'local' }] : [];
                        return json({ actions, check: { intact: true, rows: actions.length } });
                    }
                    if (p.endsWith('/api/board/projects')) return json([]);
                    return real(u, o);
                };
                window.switchNavTab('hub-inbox');
                await (await import(${S} + 'inbox_sidebar.js')).openInboxGroup('activity');
                return true;
            })()`);
            await waitFor(`window.__activityAsked.length >= 2 && !/Reading the record/.test(document.querySelector('#group-table-view')?.textContent || '')`, 'both computer reads settled', 10000);
            await ev(framesJs(3));
            await shot(`${width}-empty`);
            if (!evidenceOnly) {
                const text = await ev(`document.querySelector('#group-table-view').innerText`);
                assert.match(text, /Activity from 1 computer \(Alpha\) could not be read\./);
                assert.doesNotMatch(text, /Nothing yet\./);
                assert.equal(await ev(`document.querySelector('#group-table-view .activity-check-partial')?.getAttribute('role')`), 'status');
            }
            const refresh = async scenario => {
                await ev(`(async () => { window.__activityCase = ${JSON.stringify(scenario)}; await (await import(${S} + 'inbox_activity.js')).refresh(); return true; })()`);
                await ev(framesJs(3));
            };
            await refresh('rows');
            await waitFor(`document.querySelector('#group-table-view .al-row')?.textContent.includes('Release plan')`, 'the answering computer retains its row', 10000);
            await shot(`${width}-rows`);
            if (!evidenceOnly) {
                assert.match(await ev(`document.querySelector('#group-table-view').innerText`), /Activity from 1 computer \(Alpha\) could not be read\./);
                const box = await ev(`(() => { const r = document.querySelector('.activity-check-partial').getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth }; })()`);
                assert.ok(box.left >= 0 && box.right <= box.width + 1, JSON.stringify(box));
                await refresh('all-failed');
                assert.match(await ev(`document.querySelector('#group-table-view').innerText`), /The record could not be read\./);
                assert.doesNotMatch(await ev(`document.querySelector('#group-table-view').innerText`), /Nothing yet\./);
                await refresh('recovered');
                assert.match(await ev(`document.querySelector('#group-table-view').innerText`), /Nothing yet\./);
                assert.equal(await ev(`document.querySelector('#group-table-view .activity-check-partial') === null`), true);
            }
        }
        console.log('Activity partial failure: empty, rows, all failed and recovery passed at 390 and 1280.');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
