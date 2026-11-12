// #15733: the side panel's More button stays while any tab is behind it. The Operator picked Browse from More at a narrow panel and More was gone (it had become "Browse"), so Activity could not be reached. Now the picked
// tab swaps into the row as a real tab, More still says More with the rest in its menu, and picking again swaps again; with nothing left behind it More goes. At 390 and 1280.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const base = { session_id: 'o1', name: 'coral-go', display_name: 'Worker', agent_type: 'claude', summary: 'x', model: 'claude-opus-5-5', branch: 'main', repo_name: 'coral', working_directory: '/work/p', status: 'idle', server: 'local' };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 800, false]]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${w}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`T.state.liveSessions = ${JSON.stringify([base])}; T.render.renderLiveSessions(T.state.liveSessions); window.selectLiveSession('coral-go', 'claude', 'o1'); window.toggleAgenticPanel && window.toggleAgenticPanel(true); true`);
            await waitFor(`!!document.getElementById('agentic-tab-more') && document.getElementById('agentic-tab-more').getClientRects().length > 0`, `${w}: the dock's More tab`, 10000);
            const state = () => ev(`(() => { const m = document.getElementById('agentic-tab-more'); const vis = b => !b.classList.contains('tab-more') && getComputedStyle(b).display !== 'none'; return { more: m.getClientRects().length > 0 && !m.hidden, word: m.querySelector('.agentic-tab-word').textContent, items: [...document.querySelectorAll('#agentic-more-menu [role=menuitem]')].map(i => i.dataset.tab), inRow: ['browse', 'notes', 'activity', 'agent-ui', 'branches'].filter(t => vis(document.getElementById('agentic-tab-' + t))), open: document.querySelector('.agentic-state-tabs .agentic-tab.active')?.dataset.tab }; })()`);
            const pick = async t => {
                await ev(`document.getElementById('agentic-tab-more').click(); true`);
                await waitFor(`!document.getElementById('agentic-more-menu').hidden`, `${w}: the More menu opens`, 5000);
                await shot(`more-menu-open-${w}-${t}`);
                await ev(`document.querySelector('#agentic-more-menu [data-tab="${t}"]').click(); true`);
                await waitFor(`document.getElementById('agentic-panel-${t}').classList.contains('active')`, `${w}: ${t} opens`, 5000);
            };
            let s = await state();
            check(s.more && s.items.length >= 2, `More is there with its tabs before a pick: ${JSON.stringify(s)}`);
            const first = s.items[0], second = s.items[1];
            await pick(first);
            s = await state();
            await shot(`after-pick-${w}`);
            check(s.more, `More stays after picking ${first}: ${JSON.stringify(s)}`);
            check(s.word === 'More', `More still says More, not ${s.word}`);
            check(s.inRow.includes(first), `${first} is in the row as its own tab: ${JSON.stringify(s)}`);
            check(s.open === first, `${first} is the selected tab: ${JSON.stringify(s)}`);
            check(s.items.includes(second) && !s.items.includes(first), `the menu holds the other tabs, ${second} among them, not ${first}: ${JSON.stringify(s)}`);
            await pick(second);
            s = await state();
            check(s.more && s.open === second && s.inRow.includes(second), `a second pick swaps in too: ${JSON.stringify(s)}`);
            check(s.items.includes(first), `${first} is back in the menu: ${JSON.stringify(s)}`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the dock More button:\n  ' + problems.join('\n  '));
    console.log('PASS More stays, and the picked tab swaps into the row');
})().catch(e => { console.error(e); process.exit(1); });
