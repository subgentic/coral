// The "N need input" chip on a team's sidebar row opens that team's Needs you tab, not its Goals (#19429, the Operator's bug); the rest of the row still opens the team's page on Goals. 1440 and 390.
// The question list is a stub of /api/operator-asks; the rows are drawn from state.liveSessions.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const ALPHA = `qa-chip19429-${Date.now() % 100000}`;
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const fs = require('node:fs');
const S = `(window.__coralStatic || '/static/')`;
const row = (id, team) => ({ session_id: id, name: id, agent_type: 'claude', working_directory: '/tmp/' + team, board_project: team, display_name: id, sleeping: false });

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const { settle } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, mobile, chip] of [[1440, false, true], [1440, false, false], [1440, false, 'key'], [390, true, true], [390, true, false]]) {
            const at = width + ' px, ' + (chip === 'key' ? 'the chip by keyboard' : chip ? 'the chip' : 'the row') + ': ';
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installTP(ev); await seed(ev, ALPHA);
            await ev(`(() => { localStorage.removeItem('coral-group-by-team'); localStorage.removeItem('coral_collapsed_groups'); window.switchNavTab('agents');
                const ago = m => new Date(Date.now() - m * 60000).toISOString(); window.__asks = [{ board: '${ALPHA}', board_label: '${ALPHA}', kind: 'ask', id: 5, asker: 'Orchestrator', text: '@Operator approve the plan?', at: ago(5) }];
                const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify(window.__asks), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); return true; })()`);
            await ev(`import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
            const header = `document.querySelector('li.session-team-group > .session-group-header[data-group-name="${ALPHA}"]')`;
            const selected = () => ev(`(() => { const t = window.__tp.allTabs().find(x => x.getAttribute('aria-selected') === 'true'); return t ? window.__tp.tabLabel(t).replace(/\\s*\\d+\\+?$/, '') : null; })()`);
            const openFrom = async (what, key) => {
                await ev(`window.switchNavTab('agents'); window._coralSetLiveSessions(${JSON.stringify([row('a1', ALPHA), row('b1', 'beta')])}); true`);
                await waitFor(`!!${header} && !!${header}.querySelector('.team-row-needs')`, at + 'the count on the team row', 15000);
                await ev(what);
                if (key) { await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); }
                await waitFor(`!!window.__tp.tablist()`, at + 'the team page', 10000);
                await waitFor(`window.__tp.allTabs().some(x => x.getAttribute('aria-selected') === 'true')`, at + 'a tab is open', 10000);
            };
            if (chip === 'key') { // the row is drawn by openFrom's own first steps: draw it here too, or a slow runner reads a null header (post70t)
                await ev(`window.switchNavTab('agents'); window._coralSetLiveSessions(${JSON.stringify([row('a1', ALPHA), row('b1', 'beta')])}); true`);
                await waitFor(`!!${header} && !!${header}.querySelector('.team-row-needs')`, at + 'the count on the team row', 15000);
            }
            if (chip === 'key') assert.equal(await ev(`(() => { const c = ${header}.querySelector('.team-row-needs'); return c.tagName === 'BUTTON' && c.tabIndex >= 0 && /Needs you/.test(c.getAttribute('aria-label')); })()`), true, at + 'the chip is a button with a name, so Tab reaches it');
            await openFrom(chip === 'key' ? `${header}.querySelector('.team-row-needs').focus(); true` : chip ? `${header}.querySelector('.team-row-needs').click(); true` : `${header}.click(); true`, chip === 'key');
            await settle(600); // the page draws its tab before the picture
            if (process.env.CORAL_SCREENSHOT_DIR && chip) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${process.env.SHOT_TAG || 'after'}-${width}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } // after the chip's click: the tab that opened
            assert.equal(await selected(), chip ? 'Needs you' : 'Goals', at + (chip ? 'the chip opens Needs you' : 'the rest of the row opens the team on Goals'));
        }
        console.log('PASS the "need input" chip opens the team\'s Needs you; the rest of the row opens Goals');
    } finally { await removeBoards(ev, [ALPHA]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
