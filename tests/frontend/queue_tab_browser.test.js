// #16030 (the Operator, 2026-11-13): the Queue tab. This computer's queue, and each linked computer's through the hub's link, read only; one that stops answering keeps the last queue with when it was last seen;
// Automations keeps a link to the tab. 1280 and 390 px, light and dark, isolated dev server. Screenshots with CORAL_SCREENSHOT_DIR.
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
        if (await ev(`location.pathname`) !== '/queue') problems.push('the address is not /queue: ' + await ev(`location.pathname`));
        const body = () => ev(`document.getElementById('queue-tab-body').textContent.replace(/\\s+/g, ' ')`);
        const fits = `document.documentElement.scrollWidth <= window.innerWidth + 1`;
        const inView = async label => {
            await ev(`document.getElementById('queue-tab-body').scrollIntoView({ block: 'start' }); true`);
            const g = await ev(`(() => { const b = document.getElementById('queue-tab-body'), r = b.getBoundingClientRect(); return { shown: r.width > 0 && r.height > 0, cut: [...b.querySelectorAll('td,th,select,p')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > window.innerWidth + 1).length }; })()`);
            if (!g.shown) problems.push(label + ': the queue is not shown'); if (g.cut) problems.push(label + ': ' + g.cut + ' cells run past the screen');
            if (!(await ev(fits))) problems.push(label + ': the page scrolls sideways');
        };
        let t = await body();
        if (!/Frontend Dev/.test(t) || /Remote Builder/.test(t)) problems.push('this computer shows its own queue: ' + t.slice(0, 300));
        if (!(await ev(`!!document.querySelector('#queue-tab-body .queue-act')`))) problems.push('this computer has no Move or Kick');
        const opts = await ev(`[...document.querySelectorAll('#queue-tab-body select option')].map(o => o.textContent)`);
        if (JSON.stringify(opts) !== JSON.stringify(['This computer', 'Build box'])) problems.push('the picker: ' + JSON.stringify(opts));
        for (const theme of ['light', 'dark']) { await setTheme(ev, theme); await inView(`1280/${theme}/local`); await shot(`this-computer-1280-${theme}`); }

        await ev(`(() => { const s = document.querySelector('#queue-tab-body select'); s.value = 'box-2'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`/Remote Builder/.test(document.getElementById('queue-tab-body').textContent)`, 'the linked computer\'s queue', 10000);
        t = await body();
        if (/Frontend Dev/.test(t)) problems.push('a linked computer shows this computer\'s rows');
        if (!/read only/.test(t)) problems.push('no read only line: ' + t.slice(0, 300));
        if (await ev(`!!document.querySelector('#queue-tab-body .queue-act') || !!document.querySelector('#queue-tab-body a[href]')`)) problems.push('a linked computer\'s queue has Move, Kick or links');
        if (!(await ev(`window.__reqs.includes('box-2')`))) problems.push('the linked computer was not read through the hub link');
        for (const theme of ['light', 'dark']) { await setTheme(ev, theme); await inView(`1280/${theme}/linked`); await shot(`linked-1280-${theme}`); }

        // it stops answering: the last queue stays, with when it was last seen
        await ev(`(async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; st.servers = [{ id: 'box-2', label: 'Build box', status: 'offline', last_seen: new Date(Date.now() - 3 * 3600e3).toISOString() }]; window.__q['box-2'] = 'down'; const m = await import((window.__coralStatic || '/static/') + 'automations_queue.js'); await m.refreshQueue(); (await import((window.__coralStatic || '/static/') + 'queue_tab.js')).drawQueueTab(); return true; })()`);
        await waitFor(`/Not answering/.test(document.getElementById('queue-tab-body').textContent)`, 'the not-answering line', 10000);
        t = await body();
        if (!/Remote Builder/.test(t)) problems.push('a computer that does not answer lost its queue: ' + t.slice(0, 300));
        if (!/Last seen 3h ago/.test(t)) problems.push('no last seen: ' + t.slice(0, 400));
        for (const theme of ['light', 'dark']) { await setTheme(ev, theme); await inView(`1280/${theme}/stale`); await shot(`not-answering-1280-${theme}`); }

        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true });
        await ev(`window.switchNavTab('queue'); true`);
        await waitFor(`document.querySelectorAll('#queue-tab-body tr[data-key]').length >= 3 && document.getElementById('queue-tab-body').getBoundingClientRect().width > 0`, 'the queue on the phone', 10000);
        for (const theme of ['light', 'dark']) { await setTheme(ev, theme); await inView(`390/${theme}`); await shot(`not-answering-390-${theme}`); }
        await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

        // Automations keeps a link to the tab
        await ev(`window.openAutomationsFolder('queue'); true`);
        await waitFor(`!![...document.querySelectorAll('button')].find(b => /Open the Queue tab/.test(b.textContent))`, 'the Automations link', 8000);
        await ev(`[...document.querySelectorAll('button')].find(b => /Open the Queue tab/.test(b.textContent)).click(); true`);
        await waitFor(`location.pathname === '/queue'`, 'the link opens the tab', 6000).catch(e => problems.push(e.message.slice(0, 200)));
        assert.deepEqual(problems, [], problems.join('\n'));
        console.log('PASS Queue tab: this computer, a linked computer read only, last queue kept, Automations link, 1280 and 390 light and dark');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
