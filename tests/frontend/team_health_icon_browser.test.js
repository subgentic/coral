// The team health monitor is on for a new team (#14091, was off by default, #4962). While the check is on the team's ⋯ menu has a Health check item (#22105, the approved sidebar
// mock: the team line's pulse icon moved into its menu); a click opens the team's settings on the Health check tab, which
// (against the real server) shows a fresh team's check ON and says what it costs; no icon where the live list carries no state (Coral Hub); the
// Agent Team dialog has the option, checked, with the same sentence, and sends health_monitor false only when it is unticked. 44 px on a phone. Run against an
// isolated dev server; set HEALTH_SHOT_DIR to save screenshots.
const assert = require('node:assert/strict');
const { removeBoards } = require('./helpers/board_cleanup');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const TEAM = 'hl-' + Date.now().toString(36);
    const shot = async name => {
        if (!process.env.HEALTH_SHOT_DIR) return;
        const { data } = await Page.captureScreenshot({ format: 'png' });
        require('node:fs').writeFileSync(`${process.env.HEALTH_SHOT_DIR}/${name}.png`, Buffer.from(data, 'base64'));
    };
    const LONG = 'a-team-with-a-name-that-is-far-too-long-to-fit-in-the-sidebar-' + TEAM;
    const rows = (on, board = TEAM) => [1, 2].map(i => ({ session_id: `hl-${i}`, name: `hl-agent-${i}`, display_name: `Agent ${i}`, agent_type: 'claude', working_directory: '/tmp/hl', board_project: board, status: 'idle',
        ...(on === undefined ? {} : { team_health_on: on }) }));
    const render = (on, board) => ev(`import(${MOD} + 'render.js').then(async r => { const { state } = await import(${MOD} + 'state.js');
        state.liveSessions = ${JSON.stringify(rows(on, board))}; r.flushLiveSessionsRender(); r.renderLiveSessions(state.liveSessions); return true; })`);
    const icon = () => ev(`(() => { const b = document.querySelector('.team-health-item'); if (!b) return null; return { name: b.textContent.trim(), action: b.dataset.onClick, board: b.dataset.board, inMenu: !!b.closest('.board-card-header .sidebar-kebab-menu') }; })()`);
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, dev] of [[1280, 800, false, 'desktop'], [390, 844, true, 'phone']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile, maxTouchPoints: 5 }); // a phone is a coarse pointer: the 44 px rule
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);

          for (const theme of ['dark', 'light']) {
            await setTheme(ev, theme);
            const tag = `${dev}-${theme}`;
            // Off: no icon at all (#5119: the operator, "it doesn't need to be there"); turning the check on is in the info button's Team settings.
            await render(false);
            assert.equal(await icon(), null, `${tag}: no health icon while the check is off`);
            await shot(`${tag}-off`);

            // On: the team menu's Health check item, which opens the setting.
            await render(true);
            assert.deepEqual(await icon(), { name: 'Health check', action: 'team-health', board: TEAM, inMenu: true }, `${tag}: the Health check item in the team's menu`);
            assert.equal(await ev(`!!document.querySelector('.team-health-btn')`), false, `${tag}: no pulse icon on the team line`);
            await shot(`${tag}-on`);
          }
            await setTheme(ev, 'dark');

            // A long team name ends in an ellipsis, with the whole name as its title, and nothing in the header wraps or leaves it.
            await render(true, LONG);
            const long = await ev(`(() => { const t = document.querySelector('.group-name-text'); const hdr = document.querySelector('.session-team-group .board-card-header'); const hb = hdr.getBoundingClientRect(); const btn = hdr.querySelector('.group-kebab').getBoundingClientRect();
                const cs = getComputedStyle(t); return { title: t.getAttribute('title'), truncated: t.scrollWidth > t.clientWidth, ellipsis: cs.textOverflow, nowrap: cs.whiteSpace, oneLine: t.getBoundingClientRect().height < 28, hdrH: Math.round(hb.height), btnInside: btn.right <= hb.right + 1 && btn.left >= hb.left }; })()`);
            assert.equal(long.title, LONG, `${dev}: the whole name is the title`);
            assert.ok(long.truncated && long.ellipsis === 'ellipsis' && long.nowrap === 'nowrap' && long.oneLine, `${dev}: the long name is cut with an ellipsis on one line ${JSON.stringify(long)}`);
            assert.ok(long.btnInside, `${dev}: the buttons stay inside the header ${JSON.stringify(long)}`);
            await shot(`${dev}-long-name`);

            // No blink (#5119): feed messages that do not touch health never toggle the icon: field-level diffs without the field, whole rows without it, and a null for it
            // (a field-level diff says null for a field a row no longer has). Only a row that says false turns it off.
            await render(true);
            assert.ok(await icon(), `${dev}: on before the burst`);
            const missing = await ev(`(async () => { const ws = await import(${MOD} + 'websocket.js'); const r = await import(${MOD} + 'render.js'); const missing = [];
                const ids = [1, 2].map(i => ({ session_id: 'hl-' + i, name: 'hl-agent-' + i, agent_type: 'claude' }));
                const msgs = [];
                for (let i = 0; i < 20; i++) { const id = ids[i % 2];
                    msgs.push({ type: 'coral_diff', changed: [{ ...id, _partial: true, summary: 'step ' + i }] });
                    msgs.push({ type: 'coral_diff', changed: [{ ...id, working_directory: '/tmp/hl', board_project: ${JSON.stringify(TEAM)}, status: 'idle', display_name: 'Agent', summary: 'row ' + i }] });
                    if (i % 5 === 0) msgs.push({ type: 'coral_diff', changed: [{ ...id, _partial: true, team_health_on: null }] });
                    if (i % 7 === 0) msgs.push({ type: 'coral_update', sessions: ids.map(x => ({ ...x, working_directory: '/tmp/hl', board_project: ${JSON.stringify(TEAM)}, status: 'idle' })) });
                }
                for (const m of msgs) { ws.handleCoralMessage(m); r.flushLiveSessionsRender(); if (!document.querySelector('.team-health-item')) missing.push(JSON.stringify(m).slice(0, 90)); }
                return { sent: msgs.length, missing }; })()`);
            assert.ok(missing.sent >= 40, `${dev}: a burst of ${missing.sent} feed messages`);
            assert.deepEqual(missing.missing, [], `${dev}: the icon never left during a burst of feed messages that do not touch health`);
            await ev(`import(${MOD} + 'websocket.js').then(ws => { for (const i of [1, 2]) ws.handleCoralMessage({ type: 'coral_diff', changed: [{ session_id: 'hl-' + i, name: 'hl-agent-' + i, agent_type: 'claude', _partial: true, team_health_on: false }] }); return import(${MOD} + 'render.js').then(r => { r.flushLiveSessionsRender(); return true; }); })`);
            assert.equal(await icon(), null, `${dev}: a row that says the check is off does turn the icon off`);

            // Coral Hub: the list carries no state, so no icon.
            await render(undefined, 'hub-' + TEAM);
            assert.equal(await icon(), null, `${dev}: no icon where the list gives no state`);
            // A team on another computer of a self-hosted hub (#19509): the pulse is a button that opens its settings, on that computer; it was a span that did nothing when clicked.
            assert.deepEqual(await ev(`import(${MOD} + 'list_card_parts.js').then(m => { const host = document.createElement('div'); host.innerHTML = m.teamHealthItem('@remote/${TEAM}', [{ team_health_on: true }]); const icon = host.firstElementChild; return { tag: icon.tagName, role: icon.getAttribute('role'), label: icon.textContent.trim(), action: icon.getAttribute('data-on-click'), board: icon.dataset.board, focusable: icon.tabIndex >= 0 }; })`), { tag: 'BUTTON', role: null, label: 'Health check', action: 'team-health', board: '@remote/' + TEAM, focusable: true }, 'a remote team has the same pulse button, naming the team');
        }

        // A click opens the team's settings on the Health check tab, which (real server) shows a new team's check on and what it costs.
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        const sub = await ev(`fetch('/api/board/${TEAM}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'hl-boss' }) }).then(r => r.status)`);
        assert.ok(sub < 300, 'subscribe');
        await render(false);
        assert.equal(await icon(), null, 'a row that says the check is off: no icon, the settings are reached from the info button');
        await render(true);
        await ev(`document.querySelector('.team-health-item').closest('.sidebar-kebab-wrapper').querySelector('.sidebar-kebab-btn').click(); true`);
        await waitFor(`document.querySelector('.team-health-item').getClientRects().length > 0 && !!document.activeElement.closest('.sidebar-kebab-menu')`, 'the team menu is open, the keyboard in it'); // a scripted click is a keyboard open: the menu puts the focus on its first item first
        await ev(`document.querySelector('.team-health-item').focus(); true`);
        await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await waitFor(`!!document.querySelector('#team-settings-workspace .sv[data-ready]') && !!document.querySelector('#team-settings-health [name=on]')`, 'the Settings tab with the Health check section', 15000);
        assert.equal(await ev(`document.querySelector('#team-settings-workspace .settings-pane[data-section=health]')?.hidden`), false, 'pulse opens Health check directly');
        const panel = await ev(`(() => { const h = n => document.querySelector('#team-settings-health [name="' + n + '"]'); return { on: h('on').checked, text: document.querySelector('#team-settings-health .sv-row[data-key=on] .sv-help').textContent, shown: !document.getElementById('team-settings-health').hidden, interval: h('interval_min').value }; })()`);
        assert.equal(panel.on, true, 'a new team has the check on (#14091)');
        assert.ok(panel.shown && /tokens/.test(panel.text) && /stuck or idle/.test(panel.text), `the setting says what it does and costs: ${panel.text}`);
        assert.equal(panel.interval, '10', 'and shows its interval');
        // while the check is off (a new team starts with it on, #14091), how often / to whom / the all-clear line are dimmed and off; turning it on enables them
        const dep = () => ev(`(() => { const h = n => document.querySelector('#team-settings-health [name="' + n + '"]'); const names = ['interval_min', 'recipient', 'all_clear']; return { on: h('on').checked, disabled: names.map(n => h(n).disabled), dim: names.map(n => h(n).closest('.sv-row').hasAttribute('data-disabled')) }; })()`);
        assert.deepEqual(await dep(), { on: true, disabled: [false, false, false], dim: [false, false, false] }, 'a new team has the check on (#14091): the dependent controls are live');
        await ev(`document.querySelector('#team-settings-health [name=on]').click(); true`);
        assert.deepEqual(await dep(), { on: false, disabled: [true, true, true], dim: [true, true, true] }, 'check unticked: the dependent controls are disabled and dimmed');
        await ev(`document.querySelector('#team-settings-health [name=on]').click(); true`);
        assert.deepEqual((await dep()).disabled, [false, false, false], 'on again: live again');
        assert.deepEqual(await ev(`(() => { const keys = [...document.querySelectorAll('#team-settings-health .sv-row')].map(r => r.dataset.key); const at = k => keys.indexOf(k); return [at('health_reviews') < at('auto_delegate_on'), at('auto_delegate_on') < at('health_rules'), at('on') < at('health_reviews'), at('claim_nudge_on') > at('health_rules')]; })()`), [true, true, true, true], 'handing reviews to the default reviewers is its own section (Reviews), apart from the check and its rules');
        assert.ok(/whether or not the health check/.test(await ev(`document.querySelector('#team-settings-health .sv-row[data-key=auto_delegate_on] .sv-help').textContent`)), 'and says that it works with the check off');
        await shot('settings-health');
        await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await waitFor(`!document.querySelector('.team-settings-modal')`, 'health settings closed');
        assert.equal(await ev(`!!document.activeElement.closest('.session-team-group > .board-card-header')`), true, 'closing settings puts the focus back on the team line');

        // The Agent Team dialog's step 3 has the Health check tab (#7407, the design): the switch is on, and a launch sends health_monitor only when it is unticked (false).
        await ev(`(async () => { window.__launches = []; const real = window.fetch; const json = (b) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href); if (p.pathname === '/api/sessions/launch-team' && (o.method || 'GET') === 'POST') { window.__launches.push(JSON.parse(o.body)); return json({ agents: [{ name: 'A', session_id: 's' }] }); } return real(u, o); };
            await window.showLaunchModal(); window.hideLaunchModal(); // the dialog's markup loads on first use
            return true; })()`);
        const launchTeam = async (name, unticked) => {
            await ev(`window.showLaunchModal(); window._selectLaunchType('team'); true`);
            await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step');
            await ev(`{ const n = document.getElementById('team-board-name'); n.value = ${JSON.stringify(name)}; n.dispatchEvent(new Event('input', { bubbles: true })); const d = document.getElementById('launch-team-dir'); d.value = '/work/project'; d.dispatchEvent(new Event('input', { bubbles: true })); window._validateTeamName(); } window._addTeamAgent('Orchestrator', 'First.'); document.getElementById('launch-team-next').click(); true`); // the members are step 2
            await waitFor(`document.querySelectorAll('#team-agents-list .team-agent-row').length === 4`, 'the members'); // the form opens with the default team's three members (#9877) and this suite adds the Orchestrator: four, pinned so the default stays covered (Security Reviewer)
            await ev(`document.getElementById('launch-team-next').click(); true`); // step 3
            await waitFor(`!!document.querySelector('#launch-step-team [name=on]')`, 'the Health check tab');
            assert.equal(await ev(`document.querySelector('#launch-step-team [name=on]').checked`), true, 'the health check switch is on by default (#14091)');
            if (unticked) await ev(`document.querySelector('#launch-step-team [name=on]').click(); true`);
            const before = await ev(`window.__launches.length`);
            await ev(`document.getElementById('launch-team-go').click(); true`);
            await waitFor(`window.__launches.length === ${before} + 1`, 'the launch request');
            return await ev(`window.__launches[window.__launches.length - 1]`);
        };
        assert.equal('health_monitor' in await launchTeam('hl-launch', false), false, 'not sent while the switch is on: the team gets the default (on, #14091)');
        assert.equal((await launchTeam('hl-launch-2', true)).health_monitor, false, 'sent as false when the person unticks the switch');
        console.log('PASS team health monitor: on by default, a Health check item in the team menu while on (none through the Hub), it opens the setting, a switch in the launch dialog sent only when unticked');
    } finally { await removeBoards(ev, [TEAM, 'hl-launch', 'hl-launch-2']); await client.close(); } // the suite's board goes (the runner's end-check names one left)
})().catch(e => { console.error(e); process.exitCode = 1; });
