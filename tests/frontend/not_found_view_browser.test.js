// Wrong addresses are not silent (walk 17 H3, M7, #15295): /team/<id>/goals/99, /team/<id>/tasks/99 and /team/<id>/artifacts/zzz, and an address that names nothing, each show ONE themed not-found view (inside the
// dashboard: its sidebar and theme) that names what was not found and has a button back to the right list, instead of the list or the start page with no word. A goal that exists still opens. Real server, a real team.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = 'nf-' + Date.now().toString(36);
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { coralReady } = require('./helpers/wait').bind(ev);
    const api = (path, body) => ev(`fetch(${JSON.stringify('/api/board/' + TEAM + path)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)}) }).then(r => r.json()).catch(() => null)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady('startup', 'liveList', 'liveListLoaded', 'settings');
            await api('/subscribe', { subscriber_id: 'Orchestrator', job_title: 'Orchestrator' });
            const goal = await api('/goals', { title: 'The one goal', outcome: 'Exists.', done_when: 'Always.', state: 'active', created_by: 'Orchestrator' });
            const gid = goal && (goal.id || (goal.goal && goal.goal.id));
            assert.ok(gid, at + 'a goal was made: ' + JSON.stringify(goal));
            const cases = [
                [`/team/${TEAM}/goals/99`, /That goal was not found: #99/, 'Back to Goals', /\/team\/.+\/goals$/],
                [`/team/${TEAM}/tasks/99`, /That task was not found: #99/, 'Back to Tasks', /\/team\/.+\/tasks$/],
                [`/team/${TEAM}/artifacts/zzz`, /That file was not found: zzz/, 'Back to Artifacts', /\/team\/.+\/artifacts$/],
            ];
            for (const [path, title, back, backPath] of cases) {
                await Page.navigate({ url: BASE + path }); await Page.loadEventFired(); await install();
                await waitFor(`!!document.querySelector('#not-found-view:not([hidden])')`, at + path + ': the not-found view', 15000);
                const view = await ev(`(() => { const v = document.getElementById('not-found-view'), cs = getComputedStyle(v); return { title: v.querySelector('.not-found-title').textContent, button: v.querySelector('.not-found-back').textContent, bg: cs.backgroundColor, text: cs.color, shown: v.getClientRects().length > 0, others: ['team-page-view', 'welcome-screen', 'group-table-view'].map(id => document.getElementById(id)).filter(e => e && getComputedStyle(e).display !== 'none').length, sidebar: !!document.querySelector('.sidebar, #sidebar') }; })()`);
                assert.match(view.title, title, at + path + ': it names what was not found: ' + JSON.stringify(view));
                assert.equal(view.button, back, at + path + ': and the way back');
                assert.ok(view.shown && view.others === 0, at + path + ': it is the one view on screen: ' + JSON.stringify(view));
                assert.ok(view.bg !== 'rgba(0, 0, 0, 0)' && view.bg !== view.text, at + path + ': it is themed, with its own background: ' + JSON.stringify(view));
                await ev(`document.querySelector('#not-found-view .not-found-back').click(); true`);
                await waitFor(`!document.querySelector('#not-found-view') || document.getElementById('not-found-view').hidden`, at + path + ': Back leaves it', 10000);
                assert.match(await ev(`location.pathname`), backPath, at + path + ': Back goes to the list');
            }
            // an address the server itself does not know gets its own page: themed, with the way around the dashboard
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady('startup');
            const bare = await ev(`fetch('/nowhere/at/all', { headers: { Accept: 'text/html' } }).then(r => r.text().then(t => ({ status: r.status, t })))`);
            assert.ok(bare.status === 404 && /prefers-color-scheme:dark/.test(bare.t) && /<nav /.test(bare.t) && /href="\/inbox"/.test(bare.t) && /Back to Agents/.test(bare.t) && !/nowhere/.test(bare.t), at + 'the bare page is themed, has a nav, and names nothing of the request');
            // a goal that is there still opens, with no not-found view
            await Page.navigate({ url: BASE + `/team/${TEAM}/goals/${gid}` }); await Page.loadEventFired(); await install();
            await waitFor(`/The one goal/.test(document.body.innerText)`, at + 'the real goal opens', 15000);
            assert.equal(await ev(`!!document.querySelector('#not-found-view:not([hidden])')`), false, at + 'no not-found view for a goal that exists');
        }
        console.log('PASS wrong addresses: goal, task, file and an unknown page each say what was not found with the way back; a real goal opens');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
