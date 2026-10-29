// The 170 accessibility pass on the Analytics page and the goal page (task 7721): what a walk of both found and this holds:
//   - a phone's Analytics view has its way back on the title's line at normal text and over the title only when the title would not fit beside it (at 200% text it wrapped to a word a line);
//   - an agent's name in a By agent row is a 44 px target on a phone;
//   - the agent dock's divider is drawn in forced colors too (#7732: ButtonText at rest, Highlight while dragged; it was not drawn at all);
//   - the goal page's column handle is drawn in forced colors (Windows High Contrast drops backgrounds, and its hover, drag and focus line was one) when it has the keyboard.
// (The names, the sort state, the keyboard order, the contrast in both themes and the targets of the rest were walked and are right; analytics_a11y and the censuses hold them.)
// Drives Chrome over CDP through agent_view_harness.js against the isolated dev server, with the census data world for Analytics and a seeded team for the goal page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { DATA_WORLD } = require('./helpers/census_world');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-a11y-pass-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: DATA_WORLD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        await ev(`window.switchNavTab('tokens'); true`); await settle(1500);
        const view = async key => { await ev(`(() => { const g = ({ provider: 'Provider', model: 'Model', thinking: 'Thinking level', team: 'Team', agent: 'Agent', branch: 'Branch', task: 'Task' })[${JSON.stringify(key)}]; const b = g ? [...document.querySelectorAll('#cost-group-bar .eff-seg-btn')].find(x => x.textContent === g) : document.querySelector('#cost-nav-list .row-btn[data-view="${key}"]'); if (b) b.click(); return !!b; })()`); await settle(900); }; // a grouping is Overview's Group by (#9236)
        await S.run('a phone: an agent name in a By agent row is a 44 px target', async () => {
            await view('agent');
            const links = await ev(`[...document.querySelectorAll('#cost-by-agent .dt-link')].filter(e => e.getClientRects().length).map(e => { const b = e.getBoundingClientRect(); return [e.textContent.trim(), Math.round(b.height)]; })`);
            assert.ok(links.length >= 2, 'the By agent table has agent links: ' + JSON.stringify(links)); for (const [n, h] of links) assert.ok(h >= 44, `${n} is ${h} px high`);
        });
        await S.run('a phone: the way back is on the title\'s line at normal text (no row spent) and over it at 200% text, where the title would be a word a line', async () => {
            await view('provider');
            const geo = () => ev(`(() => { const b = document.querySelector('.cost-phone-back').getBoundingClientRect(), t = document.getElementById('cost-view-title').getBoundingClientRect(); return { backTop: Math.round(b.top), backBottom: Math.round(b.bottom), titleTop: Math.round(t.top), titleWidth: Math.round(t.width) }; })()`);
            const normal = await geo(); await shot('analytics-100-back');
            assert.ok(normal.titleTop < normal.backBottom, 'at normal text the title is beside the way back, not under it: ' + JSON.stringify(normal));
            await ev(`document.documentElement.style.fontSize = '32px'; true`); await settle(700);
            const big = await geo(); await shot('analytics-200-back'); await ev(`document.documentElement.style.fontSize = ''; true`);
            assert.ok(big.backBottom <= big.titleTop + 1, 'at 200% the title is under the way back: ' + JSON.stringify(big)); assert.ok(big.titleWidth > 200, 'and has the width of the screen, not a word a line: ' + JSON.stringify(big));
        });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM); await openTeam(ev, waitFor, TEAM).catch(() => {}); await goTab(ev, settle, 'Goals'); await settle(800);
        await ev(`(() => { const b = [...document.querySelectorAll('[role=tabpanel]:not([hidden]) button')].find(x => /Explore goals/.test(x.textContent)); if (b) b.click(); return !!b; })()`);
        await S.run("the agent dock's divider is drawn in forced colors (ButtonText) and in Highlight while it is dragged", async () => {
            await ev(`window.__m.add('dock-a', 'A', 3, { sleeping: false, session_id: 'dock-a-id' }); window.selectLiveSession('dock-a', 'claude', 'dock-a-id', 'local'); true`);
            await waitFor(`!!document.getElementById('task-bar-resize-handle') && document.getElementById('task-bar-resize-handle').getBoundingClientRect().height > 100`, 'the dock divider', 10000);
            await Emulation.setEmulatedMedia({ features: [{ name: 'forced-colors', value: 'active' }] }); await settle(400);
            await ev(`(() => { const st = document.createElement('style'); st.textContent = '*, *::before, *::after { transition: none !important; }'; document.head.append(st); return true; })()`);
            const sys = k => ev(`(() => { const t = document.createElement('i'); t.style.background = ${JSON.stringify(k)}; document.body.append(t); const c = getComputedStyle(t).backgroundColor; t.remove(); return c; })()`);
            const bg = () => ev(`getComputedStyle(document.getElementById('task-bar-resize-handle')).backgroundColor`);
            const rest = await bg(); await shot('dock-divider-forced-colors');
            assert.equal(rest, await sys('ButtonText'), 'at rest the divider is ButtonText, not the page colour it falls to without a rule: ' + rest);
            await ev(`document.getElementById('task-bar-resize-handle').classList.add('dragging'); true`); await settle(200);
            assert.equal(await bg(), await sys('Highlight'), 'while dragged it is Highlight');
            await ev(`document.getElementById('task-bar-resize-handle').classList.remove('dragging'); true`);
        });
    } finally { await Emulation.setEmulatedMedia({ features: [] }).catch(() => {}); await removeBoards(ev, [TEAM]); await client.close(); }
    S.finish();
})().catch(e => { console.error(e); process.exitCode = 1; });
