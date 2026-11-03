// A goal's title is never clipped at the right edge of a phone (#12634, coral-hub's beta pass: a goal page's title ran off the screen: "... ds th"): a long title wraps, however long its words, in the Inbox's goal page and the team page's, at 390 and
// 320 px (and with the text at 200%). The title's box is inside the screen, no part of its text is cut (scrollWidth is its width), and the page does not scroll sideways. Real goal on a real board of the isolated dev server (removed again).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const board = 'goal-title-' + Date.now().toString(36);
    const TITLES = ['Make the Orchestrator-to-Reviewer-handoff-reconciliation-and-reporting-of-every-blocked-pipeline-step visible to the operator before the release', 'Averyveryveryverylongsingleword'.repeat(4) + ' and then some words after it'];
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({status:r.status,body:await r.json()}))`);
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await load('/');
        assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: board })).status, 200);
        const ids = [];
        for (const title of TITLES) {
            const created = await api('POST', `/api/board/${board}/goals`, { subscriber_id: 'Operator', title, outcome: 'Read in full', done_when: 'Nothing is cut' });
            assert.equal(created.status, 201); ids.push(created.body.id);
            assert.equal((await api('PATCH', `/api/board/${board}/goals/${created.body.id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
        }
        for (const [width, zoom] of [[390, ''], [320, ''], [390, '32px']]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            for (const id of ids) for (const [mount, url] of [['#inbox-page', `/inbox/goals/${board}/${id}`], ['#team-panel-goals', `/team/${board}/goals/${id}`]]) {
                const at = `${width} px${zoom ? ', 200% text' : ''}, ${mount}, goal ${ids.indexOf(id) + 1}: `;
                await load(url);
                if (zoom) await ev(`document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
                await waitFor(`!!document.querySelector('${mount} #goals-detail-title')`, at + 'the goal page', 15000);
                await ev(`new Promise(r => setTimeout(r, 300))`); // sleep-ok: the page settles after the zoom
                const p = await ev(`(() => { const t = document.querySelector('${mount} #goals-detail-title'), r = t.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), cut: t.scrollWidth - t.clientWidth, sideways: document.documentElement.scrollWidth - innerWidth, vw: innerWidth, lines: Math.round(r.height / parseFloat(getComputedStyle(t).lineHeight || 20)) }; })()`);
                if (p.left < 0 || p.right > p.vw + 0.5) problems.push(at + 'the title is outside the screen: ' + JSON.stringify(p));
                if (p.cut > 1) problems.push(at + 'part of the title is cut: ' + JSON.stringify(p));
                if (p.sideways > 0) problems.push(at + 'the page scrolls sideways: ' + JSON.stringify(p));
            }
        }
    } finally { await removeBoards(ev, [board]).catch(() => {}); await client.close(); }
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    console.log('goal_title_phone_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
