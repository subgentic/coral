// The team page's tab strip on a phone (#8149): the strip scrolls sideways, and the selected tab is scrolled into view when it is chosen; the counts arrive after that and widen the tabs before it, so
// a selected tab far along the strip ended half out of view ("Ar", cut at the edge). It is brought back into view when a count changes. 390 px, real seeded team, the counts' reads stubbed wide.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-tabs-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
        await seed(ev, TEAM);
        await ev(`(() => { const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (/\\/tasks$/.test(url.pathname) && url.searchParams.get('limit') === '1') return Promise.resolve(new Response(JSON.stringify({ tasks: [], total_open: 12345 }), { status: 200, headers: { 'content-type': 'application/json' } }));
            return R(u, o); }; return true; })()`);
        // six tasks that finished with 19 artifacts each: the Artifacts tab's count (three digits) arrives when its list loads, after the tab was scrolled into view
        const made = await ev(`(async () => { const out = []; const j = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ s: r.status, t: await r.json().catch(() => ({})) }));
            for (let k = 0; k < 6; k++) {
                const t = await j('/api/board/${TEAM}/tasks', { title: 'Many files ' + k, body: 'x', priority: 'low', created_by: 'Operator', subscriber_id: 'Operator', assigned_to: 'Operator' });
                const c = await j('/api/board/${TEAM}/tasks/claim', { subscriber_id: 'Operator', task_id: t.t.id });
                const d = await j('/api/board/${TEAM}/tasks/' + t.t.id + '/complete', { subscriber_id: 'Operator', message: 'done', artifacts: Array.from({ length: 19 }, (_, i) => ({ name: 'notes-' + k + '-' + i + '.md', media_type: 'text/markdown', content: 'line ' + i })) });
                out.push(t.s, c.s, d.s);
            } return out; })()`);
        assert.ok(made.every(x => x < 300), 'the task with 123 artifacts was made: ' + JSON.stringify(made));
        await openTeam(ev, waitFor, TEAM); await settle(700);
        // the last tabs: a count on each tab before them widens the strip after the scroll
        for (const name of ['Artifacts', 'Knowledge', 'Settings']) {
            await ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === ${JSON.stringify(name)}); t.click(); return true; })()`);
            await settle(900);
            const r = await ev(`(() => { const strip = document.getElementById('team-tabs'), sel = strip.querySelector('[aria-selected="true"]'); const a = strip.getBoundingClientRect(), b = sel.getBoundingClientRect(); return { name: sel.textContent.trim(), left: Math.round(b.left - a.left), right: Math.round(a.right - b.right), strip: Math.round(a.width) }; })()`);
            if (name === 'Artifacts') assert.match(r.name, /114|1\d\d/, 'the stubbed list gave the tab its count: ' + JSON.stringify(r));
            assert.ok(r.left >= -1 && r.right >= -1, `${name}: the selected tab is wholly inside the strip: ` + JSON.stringify(r));
        }
        console.log('PASS the selected team tab stays wholly in view on a phone after the counts arrive');
    } finally { await removeBoards(ev, [TEAM]).catch(() => { }); await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
