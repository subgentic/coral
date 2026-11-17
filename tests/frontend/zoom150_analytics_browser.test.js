// Walk 60 (#17300), 150% zoom on a 1280 x 800 laptop (853 x 533 CSS px): Analytics. A guard: main keeps an agent's name whole in the Agent table and no icon's name ("filter_list", "notes", "smart_toy", "system_update") is read as text.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { DATA_WORLD } = require('./helpers/census_world');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: DATA_WORLD });
        await Emulation.setDeviceMetricsOverride({ width: 853, height: 533, deviceScaleFactor: 1.5, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`['cost-by-provider', 'cost-by-model', 'cost-by-agent', 'cost-by-team'].every(id => document.querySelectorAll('#' + id + ' tbody tr').length > 0) && !!document.querySelector('#cost-spend-chart svg')`, 'the analytics data', 15000);
        await ev(`[...document.querySelectorAll('#cost-dashboard-view button')].find(b => b.textContent.trim() === 'Agent').click(); true`);
        await waitFor(`[...document.querySelectorAll('#cost-dashboard-view button')].some(b => b.textContent.trim() === 'Agent' && b.getAttribute('aria-pressed') === 'true') && document.querySelectorAll('#cost-by-agent tbody tr').length > 0`, 'the Agent grouping', 10000);
        await ev(`document.getElementById('cost-by-agent')?.scrollIntoView({ block: 'start' }); true`); await waitFor(`document.getElementById('cost-by-agent') && document.getElementById('cost-by-agent').getBoundingClientRect().top < window.innerHeight - 60`, 'the table scrolled into view', 5000);
        await shot('zoom-analytics');
        const d = await ev(`(() => {
            const ICONS = /^(filter_list|notes|smart_toy|system_update|arrow_upward|arrow_downward|unfold_more|search|close|more_vert|chevron_right|expand_more)$/;
            const hidden = e => !!e.closest('[aria-hidden="true"]');
            const leaks = [...document.querySelectorAll('#cost-dashboard-view *, header, nav, #top-bar-settings *')].filter(e => e.children.length === 0 && ICONS.test((e.textContent || '').trim()) && e.getClientRects().length && !hidden(e)).map(e => e.tagName + '.' + e.className + ':' + e.textContent.trim());
            const names = [...document.querySelectorAll('button, a, [role=button], th')].filter(e => e.getClientRects().length && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby')).map(e => { const c = e.cloneNode(true); c.querySelectorAll('[aria-hidden="true"]').forEach(x => x.remove()); return { e, t: c.textContent.replace(/\\s+/g, ' ').trim() }; }).filter(x => ICONS.test(x.t)).map(x => x.e.tagName + '.' + x.e.className + ':' + x.t);
            const cut = [...document.querySelectorAll('#cost-by-agent td, #cost-by-team td')].filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.trim().slice(0, 30) + ' ' + e.scrollWidth + '/' + e.clientWidth);
            const ellip = [...document.querySelectorAll('#cost-by-agent td *, #cost-by-team td *')].filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow === 'ellipsis').map(e => e.textContent.trim().slice(0, 30));
            const t = document.querySelector('#cost-by-agent table'), cols = t ? [...t.querySelectorAll('thead th')].map(h => h.textContent.trim().slice(0, 14) + ':' + Math.round(h.getBoundingClientRect().width)) : null; return { leaks, names, cut, ellip, cols, rows: t ? [...t.querySelectorAll('tbody tr')].slice(0, 4).map(r => r.cells[0].textContent.trim()) : null, tw: t && Math.round(t.getBoundingClientRect().width), vw: innerWidth }; })()`);
        assert.deepEqual(d.leaks, [], 'no icon name is visible to a screen reader: ' + JSON.stringify(d.leaks));
        assert.deepEqual(d.names, [], 'no control is named by an icon word: ' + JSON.stringify(d.names));
        assert.deepEqual(d.cut, [], 'no agent or team name is cut: ' + JSON.stringify(d.cut));
        assert.ok(d.rows && d.rows.includes('Frontend Dev'), 'the Agent table is on screen: ' + JSON.stringify(d.rows));
        console.log('PASS zoom150_analytics_browser');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
