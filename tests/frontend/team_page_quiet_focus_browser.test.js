// The focus the team page puts on a heading (a goal's page, the detail pane, a task's page) wears no ring after a click or a tap and the ring after a key (UI/UX #7453 round 1, the dialogs' quiet_focus rule): a REAL mouse click on a
// row (CDP input events, not a script click) leaves the view marked quiet and the heading with no outline; Enter on the focused row leaves it unmarked and the heading with its ring. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-quiet-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const center = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const mouse = async p => { await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y }); await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await settle(500); };
    const key = async (k, code, vk) => { await client.Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text: '\r' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); await settle(500); };
    const state = () => ev(`(() => { const t = document.querySelector('.goal-main .goals-back'); const v = document.getElementById('team-page-view'); return { quiet: v.hasAttribute('data-quiet-focus'), focused: document.activeElement === t, outline: t ? getComputedStyle(t).outlineStyle + ' ' + getComputedStyle(t).outlineWidth : null }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
        await seed(ev, TEAM); await openTeam(ev, waitFor, TEAM); await settle(500);
        await S.run('a real click on a goal row: the Back link is focused with no ring (the keyboard starts at the way back, not the heading, #7404)', async () => {
            await mouse(await center('.goals-body .dt-primary'));
            const s = await state(); assert.equal(s.focused, true, 'the goal page Back link has the focus'); assert.equal(s.quiet, true, 'the view is marked quiet'); assert.match(s.outline, /^none|0px$/, `no outline (got ${s.outline})`);
        });
        await S.run('Enter on the focused row: the Back link shows its ring', async () => {
            await ev(`window.__tp.find('button, a', /^(\\u2190\\s*)?Goals$/).click(); true`); await settle(400);
            await ev(`document.querySelector('.goals-body .dt-primary').focus(); true`);
            await key('Enter', 'Enter', 13);
            const s = await state(); assert.equal(s.focused, true, 'the Back link has the focus'); assert.equal(s.quiet, false, 'the view is not marked quiet'); assert.ok(!/^none/.test(s.outline), `an outline (got ${s.outline})`);
        });
        await removeBoards(ev, [TEAM]); S.finish();
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
