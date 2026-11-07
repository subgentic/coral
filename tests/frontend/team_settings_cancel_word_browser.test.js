// The Team settings dialog's foot, through the real sequence (#14293, UI's SHOULD): the button says Close while nothing is changed and Cancel once something is.
//   - open: Close. Change a switch: Cancel. Save (a real PUT to the isolated server): the status says Saved and the button is Close again, and the dialog opened again (the values read from the server) says Close;
//   - a Save the server refuses (a failing PUT): the button stays Cancel, the changed switch is still as the person set it (the draft is kept), and Save is still on to try again.
// 1280 and 390. Real isolated board seeded by the team page helpers; only the refused Save is a stubbed answer. Isolated dev server.
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, openSettings, closeSettings } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-tcw-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const word = () => ev(`document.querySelector('.team-settings-modal .sv-cancel').textContent.trim()`);
    const status = () => ev(`document.querySelector('.team-settings-modal .sv-status').textContent.trim()`);
    const toggle = () => ev(`(() => { const m = document.querySelector('.team-settings-modal'); const all = [...m.querySelectorAll('[role=switch], input[type=checkbox]')].filter(e => e.getClientRects().length); const sw = all[0]; if (!sw) return null; sw.click(); return { checked: sw.checked !== undefined ? sw.checked : sw.getAttribute('aria-checked'), id: 0 }; })()`);
    const stateOf = () => ev(`(() => { const m = document.querySelector('.team-settings-modal'); const sw = [...m.querySelectorAll('[role=switch], input[type=checkbox]')].filter(e => e.getClientRects().length)[${Number(0)}]; return sw ? (sw.checked !== undefined ? sw.checked : sw.getAttribute('aria-checked')) : null; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
            await seed(ev, TEAM);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM); await settle(800);
            await ev(`window.__opener = (function () { const b = document.getElementById('team-page-settings'); return b && b.getClientRects().length ? b : document.getElementById('team-page-more'); })(); true`);

            // the sequence: open, change, Save, open again
            await openSettings(ev, settle);
            check(`${label}: opened with nothing changed the button says Close`, await word() === 'Close', await word());
            const t = await toggle(); await settle(200);
            check(`${label}: a switch was found and changed`, !!t, JSON.stringify(t));
            check(`${label}: with a change the button says Cancel`, await word() === 'Cancel', await word());
            await ev(`document.querySelector('.team-settings-modal .sv-save').click(); true`);
            await waitFor(`/^Saved/.test(document.querySelector('.team-settings-modal .sv-status').textContent.trim())`, `${label}: the save is told`, 10000).catch(() => {});
            check(`${label}: after the Save the status says Saved`, /^Saved/.test(await status()), await status());
            check(`${label}: and the button is Close again (nothing left to cancel)`, await word() === 'Close', await word());
            await closeSettings(ev, settle);
            await openSettings(ev, settle);
            check(`${label}: opened again (read back from the server) it says Close`, await word() === 'Close', await word());
            check(`${label}: and the saved value is what the switch shows`, t && String(await stateOf(t.id)) === String(t.checked), `${t && t.id}: ${await stateOf(t && t.id)} vs ${t && t.checked}`);

            // a Save the server refuses: Cancel stays, the draft stays, Save stays on
            await ev(`(() => { const R = window.fetch; window.__refuse = true; window.__fetchBefore = R; window.fetch = (u, o = {}) => { const m = (o.method || 'GET').toUpperCase(); if (window.__refuse && m !== 'GET' && String(u).includes('/api/board/')) return Promise.resolve(new Response(JSON.stringify({ error: 'refused for the test' }), { status: 500, headers: { 'content-type': 'application/json' } })); return R(u, o); }; return true; })()`);
            const t2 = await toggle(); await settle(200);
            const draft = await stateOf(t2.id);
            await ev(`document.querySelector('.team-settings-modal .sv-save').click(); true`);
            await waitFor(`/Could not|refused|failed|error/i.test(document.querySelector('.team-settings-modal .sv-status').textContent) || document.querySelector('.toast, [role=alert]')`, `${label}: the refusal is told`, 10000).catch(() => {});
            check(`${label}: after a refused Save the button still says Cancel`, await word() === 'Cancel', `${await word()} / ${await status()}`);
            check(`${label}: the changed switch keeps what the person set (the draft)`, String(await stateOf(t2.id)) === String(draft), `${await stateOf(t2.id)} vs ${draft}`);
            check(`${label}: Save is still on to try again`, await ev(`!document.querySelector('.team-settings-modal .sv-save').disabled`));
            await ev(`window.__refuse = false; true`);
            await closeSettings(ev, settle); // Cancel throws the draft away
        }
    } finally { await removeBoards?.(ev, [TEAM]).catch?.(() => {}); await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`PASS the Team settings foot: Close, Cancel on a change, Close after Save, Cancel and the draft after a refused Save (${results.length} checks)`);
})().catch(e => { console.error(e); process.exit(1); });
