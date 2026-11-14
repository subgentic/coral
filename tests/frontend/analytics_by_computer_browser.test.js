// #16017 (the Operator's ask, 2026-11-12): the Overview's "By computer" table. This computer and each linked one with cost, input and output tokens, agents and requests, each read from its own computer
// (GET /api/token-usage/summary?include=totals, stubbed); a computer that stops answering keeps its last figures and says when it was last seen; the total is the sum of the rows. 1280 and 390 px, light and dark,
// isolated dev server. Screenshots with CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const sceneShots = require('./helpers/scene_shots');
const { coralReady } = require('./helpers/wait');
const { setTheme } = require('./helpers/contrast');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const shot = sceneShots(Page, 'by-computer');
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { const S = (id, c, i, o, a, r) => ({ totals: { input_tokens: i, output_tokens: o, num_sessions: a, num_requests: r, cost_usd: c } });
            window.__ans = { local: S('local', 12.4, 3200000, 910000, 6, 412), 'box-2': S('b2', 7.35, 1800000, 500000, 3, 190), 'laptop': S('lp', 0.62, 120000, 44000, 1, 31) }; window.__reqs = [];
            const R = window.fetch.bind(window);
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), m = /^\\/api\\/remote\\/([^/]+)\\/api\\/token-usage\\/summary$/.exec(url.pathname), id = m ? m[1] : (url.pathname === '/api/token-usage/summary' ? 'local' : null);
                if (id && url.searchParams.get('include') === 'totals') { window.__reqs.push(id + url.search); const a = window.__ans[id]; if (a === 'down') return Promise.reject(new TypeError('network')); return Promise.resolve(new Response(JSON.stringify(a), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                return R(u, o); };
            return true; })()`);
        await ev(`(async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; st.hub = true; st.servers = [{ id: 'box-2', label: 'Build box', status: 'online', last_seen: new Date().toISOString() }, { id: 'laptop', label: 'Chris laptop', status: 'online', last_seen: new Date().toISOString() }]; return true; })()`);
        await ev(`window.switchNavTab('tokens'); true`);
        const refresh = () => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard({ force: true }); return true; })()`);
        await refresh();
        await waitFor(`document.querySelectorAll('#cost-by-computer tr[data-computer]').length === 3`, 'the three computers', 10000);
        const rows = () => ev(`[...document.querySelectorAll('#cost-by-computer tr[data-computer]')].map(tr => [tr.dataset.computer, tr.dataset.state, [...tr.querySelectorAll('td')].map(td => td.textContent.trim())])`);
        const total = () => ev(`(document.querySelector('#cost-by-computer [data-total]') || {}).textContent || ''`);
        const norm = s => s.replace(/\s+/g, ' ').trim();
        const r1 = await rows();
        if (r1[0][0] !== 'local' || r1[0][2][0] !== 'This computer') problems.push('this computer is not first: ' + JSON.stringify(r1));
        if (r1[0][2][1] !== '$12.40' || r1[1][2][1] !== '$7.35' || r1[2][2][1] !== '$0.62') problems.push('the costs: ' + JSON.stringify(r1));
        if (norm(await total()) !== 'Total of the computers above$20.37 · 5,120,000 in · 1,454,000 out · 10 agents · 633 requests') problems.push('the total is not the sum of the rows: ' + norm(await total()));
        const reqs = await ev('window.__reqs');
        if (!reqs.every(q => /include=totals/.test(q)) || new Set(reqs.map(q => q.split('?')[0])).size !== 3) problems.push('each computer is read for the range, totals only: ' + JSON.stringify(reqs));

        const fits = `document.documentElement.scrollWidth <= window.innerWidth + 1`;
        const inView = async label => {
            await ev(`document.getElementById('cost-by-computer-section').scrollIntoView({ block: 'start' }); true`);
            const g = await ev(`(() => { const s = document.getElementById('cost-by-computer-section'), r = s.getBoundingClientRect(); return { shown: !s.hidden && r.width > 0, hid: s.hidden, disp: getComputedStyle(s).display, par: s.parentElement && getComputedStyle(s.parentElement).display, w: r.width, vw: window.innerWidth, cut: [...s.querySelectorAll('td,th,.cost-by-computer-total')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > window.innerWidth + 1).length }; })()`);
            if (!g.shown) problems.push(label + ': the section is not shown ' + JSON.stringify(g)); if (g.cut) problems.push(label + ': ' + g.cut + ' cells run past the screen');
            if (!(await ev(fits))) problems.push(label + ': the page scrolls sideways');
        };
        for (const theme of ['light', 'dark']) { await setTheme(ev, theme); await inView(`1280/${theme}`); await shot(`all-answering-1280-${theme}`); }

        // one computer stops answering: its last figures stay, with when it was last seen; the total still adds the rows shown
        await ev(`(async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; st.servers = [{ id: 'box-2', label: 'Build box', status: 'offline', last_seen: new Date(Date.now() - 3 * 3600e3).toISOString() }, { id: 'laptop', label: 'Chris laptop', status: 'online', last_seen: new Date().toISOString() }]; window.__ans['box-2'] = 'down'; return true; })()`);
        await refresh();
        await waitFor(`document.querySelector('#cost-by-computer tr[data-computer="box-2"]')?.dataset.state === 'last-known'`, 'the last-known row', 10000);
        const r2 = await rows();
        if (r2[1][2][1] !== '$7.35' || r2[1][2][2] !== '1,800,000') problems.push('a computer that does not answer lost its figures: ' + JSON.stringify(r2[1]));
        if (!/^last seen 3h ago$/.test(r2[1][2][6])) problems.push('no last seen on the row: ' + JSON.stringify(r2[1][2]));
        if (norm(await total()) !== 'Total of the computers above$20.37 · 5,120,000 in · 1,454,000 out · 10 agents · 633 requests') problems.push('the total moved when a computer stopped answering: ' + norm(await total()));
        const note = await ev(`(document.querySelector('#cost-by-computer .cost-by-computer-note') || {}).textContent || ''`);
        if (!/Build box is not answering: the figures shown are the last ones read/.test(note)) problems.push('no note: ' + note);
        for (const theme of ['light', 'dark']) { await setTheme(ev, theme); await inView(`1280/${theme}/stale`); await shot(`one-not-answering-1280-${theme}`); }

        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true });
        await ev(`window.switchNavTab('tokens'); true`); await refresh();
        await waitFor(`document.querySelectorAll('#cost-by-computer tr[data-computer]').length === 3 && document.getElementById('cost-by-computer-section').getBoundingClientRect().width > 0`, 'the table on the phone', 10000);
        for (const theme of ['light', 'dark']) { await setTheme(ev, theme); await inView(`390/${theme}`); await shot(`one-not-answering-390-${theme}`); }
        // a phone reads each computer as a name and its figures, the cost first
        const phone = await ev(`(() => { const tr = document.querySelector('#cost-by-computer tr[data-computer="box-2"]'); return tr ? tr.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`);
        if (!/Build box/.test(phone) || !/\$7\.35/.test(phone)) problems.push('390: the Build box row does not show its name and cost: ' + phone);
        await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

        // one computer only: no table, nothing asked
        await ev(`(async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; st.hub = false; st.servers = []; window.__reqs = []; return true; })()`);
        await refresh();
        await waitFor(`document.getElementById('cost-by-computer-section').hidden === true`, 'the section hidden', 6000).catch(e => problems.push(e.message.slice(0, 200)));
        assert.deepEqual(await ev('window.__reqs.filter(q => !q.startsWith("local"))'), [], 'no linked computer is asked when there is none');
        assert.deepEqual(problems, [], problems.join('\n'));
        console.log('PASS Overview By computer: rows, last known figures, total is the sum, 1280 and 390 light and dark');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
