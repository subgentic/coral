// #21684 (was #15733): there is no More button in the side panel. At 390 and at 1280 with a 300 px row (icons do not fit) every tab is in the row in one order, the row scrolls sideways and reaches every tab, and a tab picked
// far along the row stays where it is: no More, no menu, nothing swaps in.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { settle, coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect({ tabLayout: '{"agent":{"order":[],"hidden":["board","saved"]}}' });
    const problems = [];
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const base = { session_id: 'o1', name: 'coral-go', display_name: 'Worker', agent_type: 'claude', summary: 'x', model: 'claude-opus-5-5', branch: 'main', repo_name: 'coral', working_directory: '/work/p', status: 'idle', server: 'local' };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, rowPx] of [[390, 844, true, 0], [1280, 800, false, 300]]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${w}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`T.state.liveSessions = ${JSON.stringify([base])}; T.render.renderLiveSessions(T.state.liveSessions); window.selectLiveSession('coral-go', 'claude', 'o1'); window.toggleAgenticPanel && window.toggleAgenticPanel(true); true`);
            if (rowPx) await ev(`(() => { const s = document.getElementById('agentic-state'); s.style.setProperty('width', '${rowPx}px', 'important'); s.style.setProperty('max-width', '${rowPx}px', 'important'); return true; })()`);
            await waitFor(`document.getElementById('agentic-tab-files').getClientRects().length > 0`, `${w}: the dock's tabs`, 10000);
            await settle(ev, 400); // sleep-ok: the row is measured over a few frames before it is read
            const state = () => ev(`(() => { const r = document.querySelector('#agentic-block-top .agentic-state-tabs'); const tabs = [...r.querySelectorAll('.agentic-tab[data-tab]')].filter(b => getComputedStyle(b).display !== 'none'); const rb = r.getBoundingClientRect();
                return { order: tabs.map(b => b.dataset.tab), noMore: !document.getElementById('agentic-tab-more') && !document.getElementById('agentic-more-menu') && !document.querySelector('.tab-more'), scrolls: r.scrollWidth > r.clientWidth, tops: new Set(tabs.map(b => b.offsetTop)).size,
                    reach: tabs.every(b => { b.scrollIntoView({ inline: 'nearest' }); const x = b.getBoundingClientRect(); return x.width > 0 && x.left >= rb.left - 1 && x.right <= rb.right + 1; }), open: (r.querySelector('.agentic-tab.active') || {}).dataset?.tab }; })()`);
            const s0 = await state();
            check(s0.order.length >= 6 && s0.noMore && s0.tops === 1 && s0.reach, `every tab is in one row, none behind More: ${JSON.stringify(s0)}`);
            if (rowPx) check(s0.scrolls, `at ${rowPx} px the icons do not fit: the row scrolls sideways: ${JSON.stringify(s0)}`);
            await shot(`no-more-${w}`);
            const last = s0.order[s0.order.length - 1];
            await ev(`(() => { const b = document.querySelector('#agentic-block-top .agentic-state-tabs .agentic-tab[data-tab="${last}"]'); b.scrollIntoView({ inline: 'nearest' }); b.click(); return true; })()`);
            await waitFor(`document.getElementById('agentic-panel-${last}').classList.contains('active')`, `${w}: ${last} opens`, 5000);
            await settle(ev, 300); // sleep-ok: the switch redraws the strip
            const s1 = await state();
            check(JSON.stringify(s1.order) === JSON.stringify(s0.order) && s1.noMore && s1.tops === 1 && s1.reach && s1.open === last, `the last tab is picked and nothing moves: ${JSON.stringify(s1)}`);
            await shot(`no-more-last-open-${w}`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the dock tabs:\n  ' + problems.join('\n  '));
    console.log('PASS there is no More: every tab stays in the row and can be reached');
})().catch(e => { console.error(e); process.exit(1); });
