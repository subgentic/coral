// The Queue table on a phone (#18732, UI/UX on #18719): at 390 px the resource's group line ("mac-heavy") sat on top of the first row. Its rows start below it, nothing overlaps, and it holds while the page scrolls.
// Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const sceneShots = require('./helpers/scene_shots');
const { coralReady } = require('./helpers/wait');
const { setTheme } = require('./helpers/contrast');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const shot = sceneShots(Page, 'queue-tab');
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { const iso = ms => new Date(Date.now() + ms).toISOString();
            const mk = (a, b, c) => ({ resources: [{ name: 'mac-heavy', slots: 1, machine: 'Mac', holders: [{ id: 1, agent: a, note: 'go test ./...', task: 7, project: 'p', granted_at: iso(-60000), lease_until: iso(1500000) }], queue: [{ id: 2, agent: b, note: 'node run_cdp_suites.mjs', place: 1, enqueued_at: iso(-120000) }, { id: 3, agent: c, note: '', place: 2, enqueued_at: iso(-30000) }] }, { name: 'spare', slots: 2, holders: [], queue: [] }] });
            window.__q = { local: mk('Frontend Dev', 'QA Engineer', 'Backend Dev'), 'box-2': mk('Remote Builder', 'Remote QA', 'Remote Docs') }; window.__reqs = [];
            const R = window.fetch.bind(window);
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), m = /^\\/api\\/remote\\/([^/]+)\\/api\\/resources$/.exec(url.pathname), id = m ? m[1] : (url.pathname === '/api/resources' ? 'local' : null);
                if (id && (!o.method || o.method === 'GET')) { window.__reqs.push(id); const a = window.__q[id]; if (a === 'down') return Promise.reject(new TypeError('network')); return Promise.resolve(new Response(JSON.stringify(a), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                return R(u, o); };
            return true; })()`);
        await ev(`(async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; st.hub = true; st.servers = [{ id: 'box-2', label: 'Build box', status: 'online', last_seen: new Date().toISOString() }]; return true; })()`);
        await ev(`window.switchNavTab('queue'); true`);
        await waitFor(`document.querySelectorAll('#queue-tab-body tr[data-key]').length >= 3`, 'this computer\'s queue', 10000);
        // geo reads the group line's own cell: it is what sticks, and what sat 33 px down on the first row
        const geo = () => ev(`(() => { const g = [...document.querySelectorAll('#queue-tab-body .dt-group')], rows = [...document.querySelectorAll('#queue-tab-body tr[data-key]')];
            const r = e => e.getBoundingClientRect(); return { groups: g.length, rows: rows.length, bad: g.flatMap(gr => { const gb = r(gr.querySelector('th') || gr); const next = rows.find(x => x.compareDocumentPosition(gr) & Node.DOCUMENT_POSITION_PRECEDING); if (!next) return []; const nb = r(next); return nb.top < gb.bottom - 1 ? [{ g: gr.textContent.trim().slice(0, 20), gBottom: Math.round(gb.bottom), rowTop: Math.round(nb.top) }] : []; }) }; })()`);
        const g1 = await geo(); assert.ok(g1.groups >= 1 && g1.rows >= 3, '1280: a group line and its rows: ' + JSON.stringify(g1)); assert.deepEqual(g1.bad, [], '1280: no row starts above its group line');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await waitFor(`window.innerWidth <= 400`, '390 wide', 4000); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the table folds after the resize
        const g2 = await geo(); assert.ok(g2.groups >= 1 && g2.rows >= 3, '390: a group line and its rows: ' + JSON.stringify(g2)); assert.deepEqual(g2.bad, [], '390: no row starts above its group line (it sat on the first row)');
        await ev(`document.querySelector('.queue-view').scrollTop = 40; true`); await new Promise(r => setTimeout(r, 200)); // sleep-ok: sticky settles
        const g3 = await geo(); assert.deepEqual(g3.bad, [], '390 scrolled: still none overlaps: ' + JSON.stringify(g3));
        console.log('PASS Queue table: the group line is above its first row at 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
