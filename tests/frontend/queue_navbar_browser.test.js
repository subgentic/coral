// #18719 (the Operator, 2026-11-16: "It should have a navbar, with search and expand similar to all of our other panels"): the Queue tab has the app's left sidebar like Skills and Automations: the
// navbar with one entry (Resources, a list that can grow), a search that filters the entries, the Hide/Show toggle, and a line that says why when nothing is queued. 1440, 1280 and 390 (the views are a strip on the page).
// Screenshots with CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const sceneShots = require('./helpers/scene_shots');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const shot = sceneShots(Page, 'queue-navbar');
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { const iso = ms => new Date(Date.now() + ms).toISOString();
            window.__q = { resources: [{ name: 'mac-heavy', slots: 1, machine: 'Mac', holders: [{ id: 1, agent: 'Frontend Dev', note: 'go test ./...', task: 7, project: 'p', granted_at: iso(-60000), lease_until: iso(1500000) }], queue: [{ id: 2, agent: 'QA Engineer', note: 'browser suites', task: 8, project: 'p', enqueued_at: iso(-30000), place: 1 }] }] };
            const R = window.fetch.bind(window);
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); if (url.pathname === '/api/resources' && (!o.method || o.method === 'GET')) return Promise.resolve(new Response(JSON.stringify(window.__q), { status: 200, headers: { 'Content-Type': 'application/json' } })); return R(u, o); };
            return true; })()`);
        await ev(`window.switchNavTab('queue'); true`);
        await waitFor(`document.querySelectorAll('#queue-tab-body tr[data-key]').length >= 2`, 'the queue', 10000);
        const side = () => ev(`(() => { const p = document.querySelector('.sidebar-pane[data-pane="queue"]'), s = document.getElementById('queue-search'), l = document.querySelector('.layout'), items = [...document.querySelectorAll('#queue-nav-list button')];
            return { pane: !!p && !p.hidden && p.getBoundingClientRect().width > 0, search: !!s && s.getBoundingClientRect().width > 0, hidden: l.classList.contains('sidebar-hidden'), items: items.map(b => b.textContent.replace(/\\s+/g, ' ').trim()), current: items.filter(b => b.getAttribute('aria-current')).length, hide: !!document.querySelector('.sidebar-pane[data-pane="queue"] .sidebar-hide-btn') }; })()`);
        for (const w of [1440, 1280]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile: false });
            const g = await side();
            if (!g.pane || g.hidden) problems.push(w + ': the Queue tab has no left sidebar: ' + JSON.stringify(g));
            if (!g.search) problems.push(w + ': no search box in the sidebar');
            if (g.items.length !== 1 || !/Resources/.test(g.items[0]) || g.current !== 1) problems.push(w + ': the navbar is not one current Resources entry: ' + JSON.stringify(g));
            if (!g.hide) problems.push(w + ': no Hide the sidebar button');
            await shot(`queue-${w}`);
        }
        // search filters the entries (agents, notes, resources)
        const type = v => ev(`(() => { const s = document.getElementById('queue-search'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        const keys = () => ev(`[...document.querySelectorAll('#queue-tab-body tr[data-key]')].map(r => r.textContent).join('|')`);
        await type('qa');
        await waitFor(`!/Frontend Dev/.test(document.getElementById('queue-tab-body').textContent)`, 'the search leaves the match', 5000).catch(e => problems.push('search "qa" did not filter: ' + e.message.slice(0, 120)));
        if (!/QA Engineer/.test(await keys())) problems.push('search "qa" lost QA Engineer');
        await type('zzzz');
        await waitFor(`/No entry matches/.test(document.getElementById('queue-tab-body').textContent)`, 'no match line', 5000).catch(e => problems.push(e.message.slice(0, 120)));
        await type('');
        await waitFor(`/Frontend Dev/.test(document.getElementById('queue-tab-body').textContent)`, 'cleared search', 5000).catch(e => problems.push(e.message.slice(0, 120)));
        // the sidebar folds to its rail and comes back
        await ev(`document.querySelector('.sidebar-pane[data-pane="queue"] .sidebar-hide-btn').click(); true`);
        if (!(await ev(`document.querySelector('.layout').classList.contains('sidebar-collapsed')`))) problems.push('Hide the sidebar did not fold it to the rail');
        await ev(`document.querySelector('.layout').classList.remove('sidebar-collapsed'); try { localStorage.removeItem('coral-sidebar-collapsed-rail'); } catch {} true`);
        // nothing queued: the page says why
        await ev(`window.__q = { resources: [] }; true`);
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'automations_queue.js'); await m.refreshQueue(); return true; })()`);
        await waitFor(`/Nothing is waiting for a computer/.test(document.getElementById('queue-tab-body').textContent)`, 'the empty state', 6000).catch(e => problems.push('no empty state: ' + e.message.slice(0, 120)));
        await shot('queue-empty-1280');
        // the phone: no sidebar, the views are a strip at the top of the page
        await ev(`window.__q = { resources: [{ name: 'mac-heavy', slots: 1, machine: 'Mac', holders: [{ id: 1, agent: 'Frontend Dev', note: 'go test', task: 7, project: 'p', granted_at: new Date().toISOString(), lease_until: new Date(Date.now() + 1500000).toISOString() }], queue: [] }] }; true`);
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await Page.navigate({ url: BASE + '/queue' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { const R = window.fetch.bind(window); const body = ${JSON.stringify({ resources: [{ name: 'mac-heavy', slots: 1, machine: 'Mac', holders: [{ id: 1, agent: 'Frontend Dev', note: 'go test', task: 7, project: 'p', granted_at: new Date().toISOString(), lease_until: new Date(Date.now() + 1500000).toISOString() }], queue: [] }] })}; window.fetch = (u, o = {}) => (new URL(String(u), location.origin).pathname === '/api/resources' && (!o.method || o.method === 'GET') ? Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })) : R(u, o)); return true; })()`);
        await ev(`window.switchNavTab('queue'); true`);
        await waitFor(`document.querySelectorAll('#queue-tab-body tr[data-key], #queue-tab-body .dt-mail-row').length >= 1`, 'the phone queue', 10000);
        const ph = await ev(`({ strip: !!document.querySelector('#queue-tab-body > .view-list'), fits: document.documentElement.scrollWidth <= window.innerWidth + 1 })`);
        if (!ph.strip) problems.push('390: no views strip at the top of the page: ' + await ev(`JSON.stringify([window.innerWidth, [...document.querySelectorAll('#queue-tab-body > *')].map(e => e.tagName + '.' + e.className + '#' + e.id)])`));
        if (!ph.fits) problems.push('390: the page scrolls sideways');
        await shot('queue-390');
        assert.deepEqual(problems, [], problems.join('\n'));
        console.log('PASS Queue navbar: left sidebar with Resources and search at 1440 and 1280, Hide, the empty state, the views strip at 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
