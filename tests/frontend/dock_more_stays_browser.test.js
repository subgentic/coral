// #21684 (was #15733): the side panel's More button holds the LAST tabs and stays where it is. A tab picked from More stays behind More (it does not swap into the row), More lights to say the open tab is behind it, and the
// row and the menu keep the same tabs before and after the pick. At 390 and 1280, at a row narrow enough that some tabs are behind More.
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
            await waitFor(`!!document.getElementById('agentic-tab-more') && document.getElementById('agentic-tab-more').getClientRects().length > 0`, `${w}: the dock's More tab`, 10000);
            const state = () => ev(`(() => { const m = document.getElementById('agentic-tab-more'); const vis = b => !b.classList.contains('tab-more') && getComputedStyle(b).display !== 'none'; return { more: m.getClientRects().length > 0 && !m.hidden, lit: m.classList.contains('active'), word: (m.querySelector('.agentic-tab-word') || {}).textContent, items: [...document.querySelectorAll('#agentic-more-menu [data-tab]')].map(i => i.dataset.tab), inRow: [...document.querySelectorAll('#agentic-block-top .agentic-state-tabs .agentic-tab[data-tab]')].filter(vis).map(b => b.dataset.tab), open: (document.querySelector('#agentic-block-top .agentic-state-tabs .agentic-tab.active:not(#agentic-tab-more)') || {}).dataset?.tab }; })()`);
            const pick = async t => {
                await ev(`document.getElementById('agentic-tab-more').click(); true`);
                await waitFor(`!document.getElementById('agentic-more-menu').hidden`, `${w}: the More menu opens`, 5000);
                await shot(`more-menu-open-${w}-${t}`);
                await ev(`document.querySelector('#agentic-more-menu [data-tab="${t}"]').click(); true`);
                await waitFor(`document.getElementById('agentic-panel-${t}').classList.contains('active')`, `${w}: ${t} opens`, 5000);
            };
            await settle(ev, 400); // sleep-ok: the row is measured over a few frames before it is read
            const s0 = await state();
            check(s0.more && s0.items.length >= 2, `More is there with its tabs before a pick: ${JSON.stringify(s0)}`);
            const first = s0.items[0], second = s0.items[1];
            await pick(first);
            let s = await state();
            await shot(`after-pick-${w}`);
            check(s.more && s.word === 'More', `More stays and still says More: ${JSON.stringify(s)}`);
            check(JSON.stringify(s.inRow) === JSON.stringify(s0.inRow), `the row is the same after the pick: ${JSON.stringify(s0.inRow)} -> ${JSON.stringify(s.inRow)}`);
            check(JSON.stringify(s.items) === JSON.stringify(s0.items), `the menu holds the same tabs after the pick: ${JSON.stringify(s0.items)} -> ${JSON.stringify(s.items)}`);
            check(s.lit, `${first} is open behind More and More is lit: ${JSON.stringify(s)}`);
            await pick(second);
            s = await state();
            check(s.more && s.lit && JSON.stringify(s.inRow) === JSON.stringify(s0.inRow) && JSON.stringify(s.items) === JSON.stringify(s0.items), `a second pick moves nothing: ${JSON.stringify(s)}`);
            await ev(`document.getElementById('agentic-tab-files').click(); true`);
            await waitFor(`document.getElementById('agentic-panel-files').classList.contains('active')`, `${w}: Files opens`, 5000);
            s = await state();
            check(!s.lit && s.more, `a tab of the row opens: More is no longer lit: ${JSON.stringify(s)}`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the dock More button:\n  ' + problems.join('\n  '));
    console.log('PASS More holds the last tabs; a tab picked from it stays behind it and lights More');
})().catch(e => { console.error(e); process.exit(1); });
