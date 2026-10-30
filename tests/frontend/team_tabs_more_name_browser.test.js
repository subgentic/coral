// The team page's tab strip on a phone (#10759 Mobile pass 38, now #11239 slice B): a team that opens on the Board or on Knowledge names the open tab and shows it. The tabs behind a More menu (the old design) are in the one strip now, so the
// open tab is the selected one in the strip, named for itself and kept inside it (the strip scrolls it in), with no More tab; the row and the page do not scroll sideways at 320 and 390 px. A real board over the API.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'tabs-more-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(r => r.status)`);
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[390, 844], [320, 640]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-s' });
            await api('POST', `/api/board/${B}/messages`, { subscriber_id: 'Boss', content: 'Please check the release notes.' });
            const seen = async tab => {
                await Page.navigate({ url: `${BASE}/team/${B}/${tab}` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
                await waitFor(`!!document.getElementById('team-tab-${tab}') && document.getElementById('team-tab-${tab}').getClientRects().length > 0`, `${w}: the tab strip on ${tab}`, 15000);
                await waitFor(`document.getElementById('team-tab-${tab}') && document.getElementById('team-tab-${tab}').getAttribute('aria-selected') === 'true'`, `${w}: ${tab} is the open tab`, 15000);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: the strip scrolls the open tab in over a frame or two
                return ev(`(() => { const tl = document.getElementById('team-tabs'), nr = tl.getBoundingClientRect(), t = document.getElementById('team-tab-${tab}'), r = t.getBoundingClientRect(), m = document.getElementById('team-tab-more'); return { name: (t.querySelector('.team-tab-label') || t).textContent.trim(), selected: t.getAttribute('aria-selected') === 'true', inStrip: r.left >= nr.left - 1 && r.right <= nr.right + 1, more: !!m && m.getClientRects().length > 0, page: document.documentElement.scrollWidth - innerWidth }; })()`);
            };
            for (const [tab, name] of [['messages', 'Board'], ['knowledge', 'Knowledge'], ['goals', 'Goals']]) {
                const r = await seen(tab);
                if (r.name !== name || !r.selected) problems.push(`${w}: with ${name} open the strip's selected tab is "${r.name}" (${JSON.stringify(r)})`);
                if (!r.inStrip) problems.push(`${w}: the open ${name} tab is not inside the strip (${JSON.stringify(r)})`);
                if (r.more) problems.push(`${w}: a More tab is drawn (${JSON.stringify(r)})`);
                if (r.page > 1) problems.push(`${w}: the page scrolls sideways with ${name} open (${r.page})`);
            }
        }
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'the team page tab row on a phone:\n  ' + problems.join('\n  '));
    console.log('PASS the open tab is named and in view in the strip');
})().catch(e => { console.error(e); process.exit(1); });
