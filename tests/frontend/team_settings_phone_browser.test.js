// Team settings on a phone (#5131; operator: "I'm unable to navigate to the team settings views on mobile."). From the agent list at 390x844 with a touch pointer: tap the team's menu
// button, tap Team settings, and the settings are on screen (the side panel opens over the team's page; it used to stay shut, so the settings were drawn at no size behind the chat).
// Each tab (Workflow, Prompt inspection, Health check) is reached by a tap and shows its panel, every tab is 44 px tall, nothing scrolls sideways, and the page
// (there is no /team/<name>/settings link: a popout, #8853). The Team view entry still shows the team's chat, not the panel. Both themes. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setTheme, installAudit, auditRegion } = require('./helpers/contrast');
const { removeBoards } = require('./helpers/board_cleanup');
const { TOUCH_AREA } = require('./helpers/touch_area');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const TEAM = 'phone-set-' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    const settle = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a touch's click and the panel's slide settle over frames; there is no completion event
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true });
        const load = async (theme, path) => {
            await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: theme }] });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + (path || '/') }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await installAudit(ev); await setTheme(ev, theme);
        };
        await load('dark');
        for (const [id, title] of [['Boss', 'Orchestrator'], ['Dev One', 'Developer']]) {
            const r = await ev(`fetch('/api/board/${TEAM}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify({ subscriber_id: id, job_title: title, session_name: id.toLowerCase().replace(' ', '-') + '-session' }))} }).then(r => r.status)`);
            assert.ok(r < 300, `subscribe ${id}: ${r}`);
        }
        const scene = () => ev(`(async () => {
            T.state.liveSessions = []; window.__m.agents = {};
            window.__m.add('boss', 'A', 3, { sleeping: false }); window.__m.add('dev', 'B', 3, { sleeping: false });
            T.state.liveSessions.forEach(s => { s.board_name = ${JSON.stringify(TEAM)}; s.board_project = ${JSON.stringify(TEAM)}; });
            T.render.renderLiveSessions(T.state.liveSessions); return T.state.liveSessions.length; })()`);
        const hit = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? (${TOUCH_AREA})(e) : null; })()`); // the area a finger hits: the box, or its transparent ::after (#9332)
    const rect = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })()`);
        const tap = async sel => {
            const r = await rect(sel); assert.ok(r && r.w > 0 && r.h > 0, `${sel} is on screen to tap: ` + JSON.stringify(r));
            const x = (Math.max(r.l, 0) + Math.min(r.r, 390)) / 2, y = (r.t + r.b) / 2;
            await Input.dispatchTouchEvent({ type: 'touchStart', touchPoints: [{ x, y }] }); await Input.dispatchTouchEvent({ type: 'touchEnd', touchPoints: [] }); await settle(400);
        };
        const HEADER = '#mobile-session-list .board-card-header';
        const open = async () => {
            assert.equal(await scene(), 2);
            await waitFor(`!!document.querySelector(${JSON.stringify(HEADER + ' .group-kebab-btn')})`, 'the team card on the phone list', 6000);
            const k = await hit(HEADER + ' .group-kebab-btn'); assert.ok(k.w >= 44 && k.h >= 44, `the team's menu button is touch-sized (${k.w}x${k.h})`);
            await tap(HEADER + ' .group-kebab-btn');
            const item = await rect(HEADER + ' [data-on-click="team-working-mode"]'); assert.ok(item && item.h >= 44, 'Team settings is in the menu, touch-sized: ' + JSON.stringify(item));
            await tap(HEADER + ' [data-on-click="team-working-mode"]');
        };
        const insideScreen = (r, what) => assert.ok(r && r.w > 0 && r.h > 0 && r.l >= 0 && r.r <= 390.5 && r.t >= 0 && r.b <= 844.5, `${what} is on the screen: ` + JSON.stringify(r));
        const reach = async theme => {
            await waitFor(`!!document.querySelector('#team-settings-workspace #team-settings-health [name=on]')`, 'the Health check section', 15000);
            await settle(300);
            insideScreen(await rect('#team-settings-workspace'), `${theme}: the Team settings page`);
            // the main Settings' groups (#7663): on a phone a selector at the top (44 px) opens one group's pane at a time; each heading is on the screen, and nothing scrolls sideways
            const pick = await rect('#team-settings-workspace .settings-group-pick select'); assert.ok(pick && pick.h >= 44, `${theme}: the group selector is a 44 px target (${pick && pick.h})`);
            for (const [id, name] of [['workflow', 'Workflow'], ['health', 'Health check'], ['messaging', 'Messaging'], ['prompts', 'Prompts']]) {
                await ev(`(() => { const s = document.querySelector('#team-settings-workspace .settings-group-pick select'); s.value = [...s.options].find(o => o.textContent === ${JSON.stringify(name)}).value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(300);
                insideScreen(await rect('#team-settings-workspace .settings-pane:not([hidden]) .settings-pane-title'), `${theme}: the ${id} heading`);
            }
            assert.equal(await ev(`document.querySelector('#team-settings-workspace .settings-panes').scrollWidth - document.querySelector('#team-settings-workspace .settings-panes').clientWidth`), 0, `${theme}: nothing scrolls sideways`);
            for (const sel of ['.sv-cancel', '.sv-save']) { const r = await rect(`#team-settings-workspace ${sel}`); assert.ok(r && r.h >= 44, `${theme}: ${sel} is 44 px tall (${r && r.h})`); }
            const audit = await auditRegion(ev, ['#team-settings-workspace']);
            assert.deepEqual(audit.fails, [], `${theme}: contrast of the Team settings page: ` + JSON.stringify(audit.fails.slice(0, 3)));
        };

        await open();
        await reach('dark');
        console.log('   ✓ dark: the team menu → Team settings opens the page, and the four groups are reached by the selector');

        // (there is no /team/<name>/settings link any more: the settings are a popout, #8853)
        // the same in the light theme
        await load('light');
        await open();
        await reach('light');
        console.log('   ✓ light: the team menu → Team settings');

        // The team's row opens the team page (its Goals tab, #7453); the side panel stays shut
        await load('dark');
        assert.equal(await scene(), 2);
        await waitFor(`!!document.querySelector(${JSON.stringify(HEADER + ' .group-name-text')})`, 'the team card', 6000);
        await tap(HEADER + ' .group-name-text');
        await waitFor(`!!document.getElementById('team-page-view') && getComputedStyle(document.getElementById('team-page-view')).display !== 'none'`, 'the team page', 6000);
        const view = await ev(`(() => { const a = document.getElementById('agentic-state'); return { open: a.classList.contains('mobile-panel-overlay'), page: getComputedStyle(document.getElementById('team-page-view')).display !== 'none', tab: document.querySelector('#team-tabs [aria-selected=true]')?.textContent.trim().replace(/\\s*\\d+$/, '') }; })()`);
        assert.deepEqual(view, { open: false, page: true, tab: 'Goals' }, 'Opening the team (its row) shows the team page on Goals with the side panel shut');
        console.log('   ✓ opening the team shows its page, panel shut');
        console.log('team_settings_phone: ok');
        await removeBoards(ev, [TEAM]); await client.close(); process.exit(0);
    } catch (e) {
        console.error('FAIL', e && e.stack || e);
        await removeBoards(ev, [TEAM]); await client.close().catch(() => {});
        process.exit(1);
    }
})();
