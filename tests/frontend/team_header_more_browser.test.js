// The team page header has Add agent and one More menu (design guidelines 4.2, #15856): Settings, the board's actions and the stop items (Sleep, Reset, Stop agents) are in More, last under a line, and Remove team after them.
// 1024 px: the header is one row; light and dark; 200% text; and the menu works by keyboard (Enter opens it, arrows move, Escape closes and the focus returns to the button). A team made through the API on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const { coralReady } = require('./helpers/wait');
const BOARD = 'header-more-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const key = async (k, code) => { await client.Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: code === 'Enter' ? 13 : code === 'Escape' ? 27 : 40, text: code === 'Enter' ? '\r' : '' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code }); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, theme, zoom, mobile] of [['1024 dark', 1024, 'dark', ''], ['1440 light', 1440, 'light', ''], ['1024 200% text', 1024, 'dark', '200%'], ['390 touch dark', 390, 'dark', '', true], ['390 touch light', 390, 'light', '', true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: mobile ? 844 : 800, deviceScaleFactor: 1, mobile: !!mobile }); await Emulation.setTouchEmulationEnabled({ enabled: !!mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`fetch('/api/board/${BOARD}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator' }) }).then(r => r.status)`);
            await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; T.state.liveSessions = []; T.render.renderLiveSessions([]); window.openTeamPage(${JSON.stringify(BOARD)}).then(() => true)`);
            await waitFor(`!!document.getElementById('team-page-more') && document.getElementById('team-page-more').getClientRects().length > 0`, `${label}: the header's More`, 15000);
            if (process.env.CORAL_SCREENSHOT_DIR) { require('node:fs').mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); require('node:fs').writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/header-${label.replace(/[ %]/g, '-')}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            const r = await ev(`(() => { const a = document.getElementById('team-page-actions'), vis = e => !!e && e.getClientRects().length > 0; const bs = [...a.children].filter(e => e.matches('button') && vis(e)).map(e => ({ id: e.id, top: Math.round(e.getBoundingClientRect().top), h: Math.round(e.getBoundingClientRect().height) })); return { bs, stop: !!document.getElementById('team-page-stop'), settings: !!document.getElementById('team-page-settings'), headTops: [...new Set([document.getElementById('team-page-title'), ...bs.map(b => document.getElementById(b.id))].map(e => Math.round(e.getBoundingClientRect().top / 20)))].length }; })()`);
            assert.deepEqual(r.bs.map(b => b.id), mobile ? ['team-page-more'] : ['team-page-add-agent', 'team-page-more'], `${label}: the header has Add agent and More (a phone: only More, Add agent is in it), nothing else: ${JSON.stringify(r)}`);
            assert.ok(!r.stop && !r.settings, `${label}: no Settings or Stop button of its own`);
            if (!zoom) assert.ok(r.bs.every(b => b.top === r.bs[0].top), `${label}: the buttons share one row: ${JSON.stringify(r.bs)}`);
            // the menu, by keyboard
            await ev(`document.getElementById('team-page-more').focus(); true`);
            await key('Enter', 'Enter');
            await waitFor(`!document.getElementById('team-page-more-menu').hidden`, `${label}: Enter opens More`, 5000);
            const m = await ev(`(() => { const k = [...document.querySelectorAll('#team-page-more-menu > *')].filter(e => e.getClientRects().length); return { names: k.filter(e => e.matches('button')).map(e => (e.querySelector('.menu-item-text') || e).textContent.trim().replace(/\\s+/g, ' ')), tail: k.slice(-6).map(e => e.tagName === 'HR' ? 'hr' : e.dataset.stop || e.id) , focus: document.activeElement && document.activeElement.textContent.trim().slice(0, 20) }; })()`);
            for (const w2 of ['Settings', 'Save as template']) assert.ok(m.names.some(n => n.startsWith(w2)), `${label}: ${w2} is in More: ${JSON.stringify(m.names)}`);
            assert.deepEqual(m.tail, ['mb-select-btn', 'hr', 'sleep', 'reset', 'kill', 'mb-delete-btn'], `${label}: Select before the stop line, stop items under it, Remove team last (#16359, #16630): ${JSON.stringify(m)}`);
            const fit = await ev(`(() => { const m = document.getElementById('team-page-more-menu'), r = m.getBoundingClientRect(), st = document.getElementById('main-stage') ? document.getElementById('main-stage').getBoundingClientRect() : { bottom: innerHeight }; return { r: [Math.round(r.top), Math.round(r.bottom)], st: Math.round(st.bottom), ih: innerHeight, sh: m.scrollHeight, ch: m.clientHeight, inside: r.bottom <= Math.min(st.bottom, innerHeight) + 1, scrolls: getComputedStyle(m).overflowY === 'auto' && m.scrollHeight >= m.clientHeight }; })()`);
            assert.ok(fit.inside && fit.scrolls, `${label}: More fits the stage or scrolls inside it, so its last item can be reached (#15856): ${JSON.stringify(fit)}`);
            await key('ArrowDown', 'ArrowDown');
            await key('Escape', 'Escape');
            await waitFor(`document.getElementById('team-page-more-menu').hidden && document.activeElement === document.getElementById('team-page-more')`, `${label}: Escape closes More and the focus returns to it`, 5000);
        }
        console.log('PASS the team header is Add agent and More');
    } finally { try { await removeBoards(ev, [BOARD]); } catch (e) {} try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
