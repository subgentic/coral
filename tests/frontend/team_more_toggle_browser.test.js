// The team page's More menu while the team sleeps, and its button (#16394, the Beta Tester's re-walk #16382): (1) a sleeping team's More lists Wake team ONCE (the Sleep item's, not also the Pause item's under
// the same name); (2) the sleeping banner names no button that is not on the page ("the Sleep button"); (3) More toggles predictably with real mouse clicks: open, a second click closes and it stays closed,
// a third opens again, and Remove team never sits under the button, so the click that closes More cannot land on it. 1280 and 390 px, light and dark; shots go to CORAL_SCREENSHOT_DIR when set.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const BOARD = 'more-toggle-' + Date.now().toString(36);
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await ev(framesJs(3)); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const mk = (id, name, sleeping) => ({ session_id: id, name, display_name: name, agent_type: 'claude', summary: 'x', model: 'claude-opus-5-5', branch: 'main', repo_name: 'coral', working_directory: '/work/' + name, status: 'idle', server: 'local', board_project: BOARD, sleeping });
    const click = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await Input.dispatchMouseEvent({ type, x, y, button: 'left', clickCount: 1 }); };
    const centre = id => ev(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    const open = () => ev(`!document.getElementById('team-page-more-menu').hidden`);
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, theme] of [[1280, 800, false, 'dark'], [1280, 800, false, 'light'], [390, 844, true, 'dark'], [390, 844, true, 'light']]) {
            const tag = `${w}-${theme}`, check = (ok, msg) => { if (!ok) problems.push(`${tag}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`fetch('/api/board/${BOARD}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator' }) }).then(r => r.status)`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'settings_core.js'); m.applyTheme('${theme}'); return true; })()`);
            await ev(`T.state.liveSessions = ${JSON.stringify([mk('s1', 'Boss', true), mk('s2', 'Worker', true)])}; T.render.renderLiveSessions(T.state.liveSessions); window.openTeamPage(${JSON.stringify(BOARD)}).then(() => true)`);
            await waitFor(`!!document.getElementById('team-page-title') && document.getElementById('team-page-title').textContent.includes('more-toggle')`, 'the team page', 15000);
            await new Promise(r => setTimeout(r, 600)); // sleep-ok: the header fills
            await ev(`(() => { const f = window.fetch; window.fetch = (u, o) => /\\/sleep-status/.test(String(u && u.url || u)) ? Promise.resolve(new Response(JSON.stringify({ sleeping: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : f(u, o); return true; })()`); // the server's word that the team sleeps
            await ev(`import((window.__coralStatic || '/static/') + 'board_controls.js').then(m => m.loadSleepState(${JSON.stringify(BOARD)})).then(() => true)`);
            await waitFor(`(document.getElementById('mb-pause-btn') || {}).textContent === 'Wake team'`, `${tag}: the board knows the team sleeps`, 8000);
            // 1. Wake team once
            let p = await centre('team-page-more'); await click(p.x, p.y);
            await waitFor(`!document.getElementById('team-page-more-menu').hidden`, `${tag}: a real click opens More`, 5000);
            const names = await ev(`[...document.querySelectorAll('#team-page-more-menu button')].filter(b => b.getClientRects().length).map(b => (b.querySelector('.menu-item-text') || b).textContent.trim().replace(/\\s+/g, ' '))`);
            check(names.filter(n => /^Wake team/.test(n)).length === 1, `a sleeping team's More lists Wake team once: ${JSON.stringify(names)}`);
            await shot(`more-sleeping-${tag}`);
            // 3. Remove team is not under the button, and the button toggles
            const geo = await ev(`(() => { const b = document.getElementById('team-page-more').getBoundingClientRect(), d = document.getElementById('mb-delete-btn').getBoundingClientRect(); return { overlap: !(d.right < b.left || d.left > b.right || d.bottom < b.top || d.top > b.bottom), delTop: Math.round(d.top), btnBottom: Math.round(b.bottom) }; })()`);
            check(!geo.overlap, `Remove team does not sit over the More button: ${JSON.stringify(geo)}`);
            p = await centre('team-page-more');
            const hit = await ev(`(() => { const e = document.elementFromPoint(${p.x}, ${p.y}); return !!e && !!e.closest('#team-page-more'); })()`);
            check(hit, 'with the menu open, the point on the More button is the button itself (nothing of the menu covers it)');
            await click(p.x, p.y); await new Promise(r => setTimeout(r, 400)); // sleep-ok: a close that is slow or reopens would show by now
            check(!(await open()), 'a second click on More closes it, and it stays closed');
            const onDelete = await ev(`(() => { const d = document.getElementById('mb-delete-btn'); return !!d && d.getClientRects().length > 0; })()`);
            check(!onDelete, 'closed, Remove team is not on the screen to be clicked');
            await click(p.x, p.y); await new Promise(r => setTimeout(r, 300)); // sleep-ok: as above
            check(await open(), 'a third click opens it again');
            await click(p.x, p.y); await new Promise(r => setTimeout(r, 300)); // sleep-ok: as above
            check(!(await open()), 'a fourth click closes it again');
            check(await ev(`![...document.querySelectorAll('dialog[open], [role=dialog]')].some(d => d.getClientRects().length > 0)`), 'no dialog was opened by the toggling (Remove team was not clicked by accident)');
            // 2. the banner
            const said = await ev(`(document.querySelector('#mb-sleep-banner .mb-sleep-text') || {}).textContent || ''`);
            check(said && !/Sleep button/.test(said), `the sleeping banner names no button that is not on the page: ${JSON.stringify(said)}`);
        }
    } finally { try { await removeBoards(ev, [BOARD]); } catch (e) {} try { await client.close(); } catch (e) {} }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('PASS the sleeping More lists Wake team once, the banner names no missing button, and More toggles predictably');
})().catch(e => { console.error(e); process.exit(1); });
