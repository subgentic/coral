// One row style for every sidebar list (#9926, the operator's): the Inbox's view list, the agent list, the Analytics views and the Settings tabs read the same. A row at rest is 14 px / 400 in
// the secondary colour, the current one 14 / 600 in the primary colour (the Slack model: quiet, and the one you are on is bold), every row 36 px, and the team heading of the agent list is the strong
// text. A row that needs you says so with its dot or chip, never with louder text. Both themes at 1280, the numbers read from the real page against the tokens.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const uid = n => '0000' + String(n).padStart(4, '0') + '-0000-4000-8000-000000000000';
const SESSIONS = Array.from({ length: 4 }, (_, i) => { const n = i + 1; return { name: 'ag-' + n, session_id: uid(n), agent_type: 'claude', server: 'local', status: 'idle', summary: 'Task ' + n, display_name: 'Agent ' + n, working_directory: '/repo/team-a', branch: 'main', board_project: 'team-a', staleness_seconds: 100 * n, token_cost_usd: n, working: n === 2, waiting_for_input: n === 1, sleeping: n === 4 }; });

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const failures = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`(async () => { const st = window.__coralStatic || '/static/'; const ws = await import(st + 'websocket.js'); const render = await import(st + 'render.js'); const { state } = await import(st + 'state.js');
            if (state.coralWs) { state.coralWs.onclose = null; state.coralWs.onmessage = null; try { state.coralWs.close(); } catch {} }
            localStorage.clear(); state.hub = false; window.__T = { ws, render, state };
            ws.handleCoralMessage({ type: 'coral_update', servers: [], sessions: ${JSON.stringify(SESSIONS)} }); render.flushLiveSessionsRender(); render.renderLiveSessions(state.liveSessions); return true; })()`);
        await waitFor(`document.querySelectorAll('#live-sessions-list .session-group-item').length >= 3`, 'the agents', 8000);
        // the colour a token resolves to, as the page computes it (rgb), and a row's label look
        const tok = name => ev(`(() => { const i = document.createElement('i'); i.style.color = 'var(${name})'; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return c; })()`);
        const look = (rowSel, labelSel, which) => ev(`(() => { const rows = [...document.querySelectorAll(${JSON.stringify(rowSel)})].filter(e => e.getClientRects().length); const row = rows.find(${which}); if (!row) return null; const l = ${labelSel ? `row.querySelector(${JSON.stringify(labelSel)}) || row` : 'row'}, c = getComputedStyle(l); return { size: c.fontSize, weight: c.fontWeight, color: c.color, h: Math.round(row.getBoundingClientRect().height), n: rows.length }; })()`);
        const lists = {
            'Inbox': { go: `document.getElementById('nav-tab-hub-inbox').click()`, row: '.view-list-item', label: '.view-list-name', rest: 'e => e.getAttribute("aria-current") !== "true"', cur: 'e => e.getAttribute("aria-current") === "true"' },
            'Agents': { go: `document.getElementById('nav-tab-agents').click()`, row: '#live-sessions-list li.session-group-item', label: '.session-label', rest: 'e => !e.classList.contains("active") && !e.classList.contains("sleeping") && !e.classList.contains("needs-attention")', cur: null },
            'Analytics': { go: `document.getElementById('nav-tab-tokens').click()`, row: '#cost-nav-list .row-btn', label: null, rest: 'e => e.getAttribute("aria-current") !== "true"', cur: 'e => e.getAttribute("aria-current") === "true"' },
        };
        for (const theme of ['dark', 'light']) {
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); true`);
            const secondary = await tok('--text-secondary'), primary = await tok('--text-primary');
            for (const [name, l] of Object.entries(lists)) {
                await ev(`${l.go}; true`); await sleep(700); // sleep-ok: the page behind the tab is drawn
                if (name === 'Agents') await ev(`document.querySelector('#live-sessions-list li.session-group-item:not(.sleeping):not(.needs-attention)').classList.add('active', 'list-row-current'); true`); // the current agent, as the list marks it
                const rest = await look(l.row, l.label, l.rest), cur = await look(l.row, l.label, name === 'Agents' ? 'e => e.classList.contains("active")' : l.cur);
                const at = `${theme} ${name}: `;
                const ok = (cond, what) => { if (!cond) failures.push(at + what); };
                ok(rest && rest.size === '14px' && rest.weight === '400' && rest.color === secondary, 'a row at rest is 14px/400 in the secondary colour: ' + JSON.stringify(rest) + ' wanted ' + secondary);
                ok(cur && cur.size === '14px' && cur.weight === '600' && cur.color === primary, 'the current row is 14px/600 in the primary colour: ' + JSON.stringify(cur) + ' wanted ' + primary);
                ok(rest && rest.h === 36 && cur && cur.h === 36, 'rows are 36 px: ' + JSON.stringify([rest && rest.h, cur && cur.h]));
                if (name === 'Agents') {
                    const w = await look(l.row, l.label, 'e => e.classList.contains("needs-attention")');
                    ok(w && w.weight === '400' && w.size === '14px', 'a row that needs input is not louder text, its dot and chip say it: ' + JSON.stringify(w));
                    const head = await ev(`(() => { const e = [...document.querySelectorAll('#live-sessions-list .board-card-header .group-name-text')].find(x => x.getClientRects().length); const c = e && getComputedStyle(e); return c && { size: c.fontSize, weight: c.fontWeight }; })()`);
                    ok(head && head.size === '14px' && head.weight === '600', 'the team heading is 14px/600: ' + JSON.stringify(head));
                }
                await shot(`sidebar-${name.toLowerCase()}-${theme}`);
            }
            await ev(`(async () => { await window.showSettingsModal(); return true; })()`); await sleep(500); // sleep-ok: the dialog is drawn
            const rest = await look('#settings-tabs [role=tab]', '.settings-tab-name', 'e => e.getAttribute("aria-selected") !== "true"'), cur = await look('#settings-tabs [role=tab]', '.settings-tab-name', 'e => e.getAttribute("aria-selected") === "true"');
            const ok = (cond, what) => { if (!cond) failures.push(`${theme} Settings: ` + what); };
            ok(rest && rest.size === '14px' && rest.weight === '400' && rest.color === secondary, 'a tab at rest is 14px/400 secondary: ' + JSON.stringify(rest));
            ok(cur && cur.size === '14px' && cur.weight === '600' && cur.color === primary, 'the current tab is 14px/600 primary: ' + JSON.stringify(cur));
            await shot(`sidebar-settings-${theme}`);
            await ev(`window.hideSettingsModal(); true`);
        }
        assert.equal(failures.length, 0, '\n' + failures.join('\n'));
        console.log('PASS sidebar rows: one style in the Inbox, agent list, Analytics and Settings, both themes');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
