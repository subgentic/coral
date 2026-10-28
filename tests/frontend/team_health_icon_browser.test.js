// The team health monitor is off by default and easy to see (#4962): an icon beside the team's info button in the agent list, dimmed while the
// check is off and accent while it is on, named "Team health monitor: on/off"; a click opens the team's settings on the Health check tab, which
// (against the real server) shows a fresh team's check OFF and says what it costs; no icon where the live list carries no state (Coral Hub); the
// Agent Team dialog has the option, unchecked, with the same sentence, and sends it only when it is checked. 44 px on a phone. Run against an
// isolated dev server; set HEALTH_SHOT_DIR to save screenshots.
const assert = require('node:assert/strict');
const { removeBoards } = require('./helpers/board_cleanup');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');

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
    const icon = () => ev(`(() => { const b = document.querySelector('.team-health-btn'); if (!b) return null; const r = b.getBoundingClientRect(), cs = getComputedStyle(b);
        const open = document.querySelector('.board-card-header .group-kebab').getBoundingClientRect();
        return { label: b.getAttribute('aria-label'), title: b.getAttribute('title'), on: b.classList.contains('is-on'), w: Math.round(r.width), h: Math.round(r.height), color: cs.color, opacity: cs.opacity,
            beside: Math.abs((r.top + r.bottom) / 2 - (open.top + open.bottom) / 2) < 6 && r.right <= open.left + 1, board: b.dataset.board, bg: cs.backgroundColor, shadow: cs.boxShadow, border: cs.borderTopWidth, stroke: getComputedStyle(b.querySelector('svg')).strokeWidth }; })()`);
    // The icon's contrast against what is behind it (the panel; the button has no fill of its own), 3:1 for a graphic (WCAG 1.4.11).
    const contrast = () => ev(`(() => { const b = document.querySelector('.team-health-btn'); const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
        const rgba = c => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
        const over = (f, g) => [f[0] * f[3] + g[0] * (1 - f[3]), f[1] * f[3] + g[1] * (1 - f[3]), f[2] * f[3] + g[2] * (1 - f[3]), 1];
        const lum = c => { const t = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]; };
        let bg = [255, 255, 255, 1]; const layers = []; for (let e = b; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] === 1) break; } } for (const l of layers.reverse()) bg = over(l, bg);
        const fg = over(rgba(getComputedStyle(b).color), bg); const a = lum(fg), z = lum(bg); return (Math.max(a, z) + 0.05) / (Math.min(a, z) + 0.05); })()`);
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, dev] of [[1280, 800, false, 'desktop'], [390, 844, true, 'phone']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile, maxTouchPoints: 5 }); // a phone is a coarse pointer: the 44 px rule
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);

          for (const theme of ['dark', 'light']) {
            await setTheme(ev, theme);
            const tag = `${dev}-${theme}`;
            // Off: no icon at all (#5119: the operator, "it doesn't need to be there"); turning the check on is in the info button's Team settings.
            await render(false);
            assert.equal(await icon(), null, `${tag}: no health icon while the check is off`);
            await shot(`${tag}-off`);

            // On: accent, full strength, named on.
            await render(true);
            const on = await icon();
            assert.equal(on.label, 'Team health monitor: on'); assert.equal(on.title, 'Team health monitor: on'); assert.equal(on.on, true);
            assert.ok(on.beside, `${dev}: it sits beside the team's info button ${JSON.stringify(on)}`);
            const accent = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
            const same = await ev(`(() => { const c = document.createElement('i'); c.style.color = ${JSON.stringify(accent)}; document.body.appendChild(c); const v = getComputedStyle(c).color; c.remove(); return v; })()`);
            assert.equal(on.color, same, `${dev}: accent coloured while on`);
            // Quiet (#5119): the accent icon alone, no fill, no ring, no border.
            assert.equal(on.bg, 'rgba(0, 0, 0, 0)', `${tag}: on has no fill (${on.bg})`);
            assert.equal(on.shadow, 'none', `${tag}: on has no ring (${on.shadow})`);
            assert.equal(on.border, '0px', `${tag}: on has no border (${on.border})`);
            assert.ok(parseFloat(on.stroke) >= 2, `${tag}: drawn with the heavier stroke (${on.stroke})`);
            if (mobile) { const hit = await ev(`parseFloat(getComputedStyle(document.querySelector('.team-health-btn'), '::after').width) || 0`); assert.ok(hit >= 44, `${dev}: the 44 px target: a ${on.w}x${on.h} box with a ${hit} px hit area (the dense icon button's ::after)`); }
            const onContrast = await contrast();
            assert.ok(onContrast >= 3, `${tag}: the accent icon is 3:1 on its panel (${onContrast.toFixed(2)})`);
            await shot(`${tag}-on`);
          }
            await setTheme(ev, 'dark');

            // A long team name ends in an ellipsis, with the whole name as its title, and nothing in the header wraps or leaves it.
            await render(true, LONG);
            const long = await ev(`(() => { const t = document.querySelector('.group-name-text'); const hdr = document.querySelector('.session-team-group .board-card-header'); const hb = hdr.getBoundingClientRect(); const btn = document.querySelector('.team-health-btn').getBoundingClientRect();
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
                for (const m of msgs) { ws.handleCoralMessage(m); r.flushLiveSessionsRender(); if (!document.querySelector('.team-health-btn.is-on')) missing.push(JSON.stringify(m).slice(0, 90)); }
                return { sent: msgs.length, missing }; })()`);
            assert.ok(missing.sent >= 40, `${dev}: a burst of ${missing.sent} feed messages`);
            assert.deepEqual(missing.missing, [], `${dev}: the icon never left during a burst of feed messages that do not touch health`);
            await ev(`import(${MOD} + 'websocket.js').then(ws => { for (const i of [1, 2]) ws.handleCoralMessage({ type: 'coral_diff', changed: [{ session_id: 'hl-' + i, name: 'hl-agent-' + i, agent_type: 'claude', _partial: true, team_health_on: false }] }); return import(${MOD} + 'render.js').then(r => { r.flushLiveSessionsRender(); return true; }); })`);
            assert.equal(await icon(), null, `${dev}: a row that says the check is off does turn the icon off`);

            // Coral Hub: the list carries no state, so no icon.
            await render(undefined, 'hub-' + TEAM);
            assert.equal(await icon(), null, `${dev}: no icon where the list gives no state`);
        }

        // A click opens the team's settings on the Health check tab, which (real server) shows a new team's check off and what it costs.
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        const sub = await ev(`fetch('/api/board/${TEAM}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'hl-boss' }) }).then(r => r.status)`);
        assert.ok(sub < 300, 'subscribe');
        await render(false);
        assert.equal(await icon(), null, 'a new team has the check off: no icon, the settings are reached from the info button');
        await ev(`window.showTeamWorkingModeWorkspace(${JSON.stringify(TEAM)}); true`);
        await waitFor(`!!document.querySelector('#team-settings-workspace .sv[data-ready]') && !!document.querySelector('#team-settings-health [name=on]')`, 'the Settings tab with the Health check section', 15000);
        await ev(`document.querySelector('#team-settings-workspace .settings-tab[data-section=health]').click(); true`);
        const panel = await ev(`(() => { const h = n => document.querySelector('#team-settings-health [name="' + n + '"]'); return { on: h('on').checked, text: document.querySelector('#team-settings-health .sv-row[data-key=on] .sv-help').textContent, shown: !document.getElementById('team-settings-health').hidden, interval: h('interval_min').value }; })()`);
        assert.equal(panel.on, false, 'a new team has the check off');
        assert.ok(panel.shown && /tokens/.test(panel.text) && /stuck or idle/.test(panel.text), `the setting says what it does and costs: ${panel.text}`);
        assert.equal(panel.interval, '10', 'and shows its interval');
        // while the check is off, how often / to whom / the all-clear line are dimmed and off; turning it on enables them
        const dep = () => ev(`(() => { const h = n => document.querySelector('#team-settings-health [name="' + n + '"]'); const names = ['interval_min', 'recipient', 'all_clear']; return { on: h('on').checked, disabled: names.map(n => h(n).disabled), dim: names.map(n => h(n).closest('.sv-row').hasAttribute('data-disabled')) }; })()`);
        assert.deepEqual(await dep(), { on: false, disabled: [true, true, true], dim: [true, true, true] }, 'check off: the dependent controls are disabled and dimmed');
        await ev(`document.querySelector('#team-settings-health [name=on]').click(); true`);
        assert.deepEqual(await dep(), { on: true, disabled: [false, false, false], dim: [false, false, false] }, 'check on: they are live');
        await ev(`document.querySelector('#team-settings-health [name=on]').click(); true`);
        assert.deepEqual((await dep()).disabled, [true, true, true], 'off again: off again');
        assert.deepEqual(await ev(`(() => { const keys = [...document.querySelectorAll('#team-settings-health .sv-row')].map(r => r.dataset.key); const at = k => keys.indexOf(k); return [at('health_reviews') < at('auto_delegate_on'), at('auto_delegate_on') < at('health_rules'), at('on') < at('health_reviews'), at('claim_nudge_on') > at('health_rules')]; })()`), [true, true, true, true], 'handing reviews to the default reviewers is its own section (Reviews), apart from the check and its rules');
        assert.ok(/whether or not the health check/.test(await ev(`document.querySelector('#team-settings-health .sv-row[data-key=auto_delegate_on] .sv-help').textContent`)), 'and says that it works with the check off');
        await shot('settings-health');

        // The Agent Team dialog's step 3 has the Health check tab (#7407, the design): the switch is off, and a launch sends health_monitor only when it is on.
        await ev(`(async () => { window.__launches = []; const real = window.fetch; const json = (b) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href); if (p.pathname === '/api/sessions/launch-team' && (o.method || 'GET') === 'POST') { window.__launches.push(JSON.parse(o.body)); return json({ agents: [{ name: 'A', session_id: 's' }] }); } return real(u, o); };
            await window.showLaunchModal(); window.hideLaunchModal(); // the dialog's markup loads on first use
            return true; })()`);
        const launchTeam = async (name, ticked) => {
            await ev(`window.showLaunchModal(); window._selectLaunchType('team'); true`);
            await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step');
            await ev(`{ const n = document.getElementById('team-board-name'); n.value = ${JSON.stringify(name)}; n.dispatchEvent(new Event('input', { bubbles: true })); const d = document.getElementById('launch-team-dir'); d.value = '/work/project'; d.dispatchEvent(new Event('input', { bubbles: true })); window._validateTeamName(); } window._addTeamAgent('Orchestrator', 'First.'); document.getElementById('launch-team-next').click(); true`); // the members are step 2
            await waitFor(`document.querySelectorAll('#team-agents-list .team-agent-row').length === 4`, 'the members'); // the form opens with the default team's three members (#9877) and this suite adds the Orchestrator: four, pinned so the default stays covered (Security Reviewer)
            await ev(`document.getElementById('launch-team-next').click(); true`); // step 3
            await waitFor(`!!document.querySelector('#launch-step-team [name=on]')`, 'the Health check tab');
            assert.equal(await ev(`document.querySelector('#launch-step-team [name=on]').checked`), false, 'the health check switch is off by default');
            if (ticked) await ev(`document.querySelector('#launch-step-team [name=on]').click(); true`);
            const before = await ev(`window.__launches.length`);
            await ev(`document.getElementById('launch-team-go').click(); true`);
            await waitFor(`window.__launches.length === ${before} + 1`, 'the launch request');
            return await ev(`window.__launches[window.__launches.length - 1]`);
        };
        assert.equal('health_monitor' in await launchTeam('hl-launch', false), false, 'not sent while the switch is off: the team gets the default (off)');
        assert.equal((await launchTeam('hl-launch-2', true)).health_monitor, true, 'sent as true when the switch is on');
        console.log('PASS team health monitor: off by default, the icon (dimmed off, accent on, 44 px on a phone, none through the Hub), it opens the setting, a switch in the launch dialog sent only when on');
    } finally { await removeBoards(ev, [TEAM, 'hl-launch', 'hl-launch-2']); await client.close(); } // the suite's board goes (the runner's end-check names one left)
})().catch(e => { console.error(e); process.exitCode = 1; });
