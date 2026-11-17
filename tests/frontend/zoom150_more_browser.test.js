// Walk 60 (#17300), 150% zoom on a 1280 x 800 laptop (853 x 533 CSS px): the team's More menu rows (Sleep, Reset, Archive, Stop) do not draw over each other and each hint stays inside its row. A guard: main already keeps them apart (#16359).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const BOARD = 'toast-zoom-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 853, height: 533, deviceScaleFactor: 1.5, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`fetch('/api/board/${BOARD}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator' }) }).then(r => r.status)`);
        await ev(`T.state.liveSessions = [{ name: 'dev', agent_type: 'claude', session_id: 'sess-dev-1', board_project: ${JSON.stringify(BOARD)}, sleeping: false, working: false }]; window.openTeamPage(${JSON.stringify(BOARD)}).then(() => true)`);
        await waitFor(`!!document.getElementById('team-tabs-row') && document.getElementById('team-tabs-row').getClientRects().length > 0`, 'the tab strip', 15000);
        await ev(`[...document.querySelectorAll('#team-page-head button')].find(b => /^More$/.test(b.textContent.trim())).click(); true`);
        await waitFor(`[...document.querySelectorAll('[role=menu], .menu')].some(m => m.getClientRects().length && /Reset team/.test(m.textContent))`, 'the menu', 5000);
        await ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
        await shot('zoom-more');
        const r = await ev(`(() => { const m = [...document.querySelectorAll('[role=menu], .menu')].find(m => m.getClientRects().length && /Reset team/.test(m.textContent)), b = e => { const x = e.getBoundingClientRect(); return [Math.round(x.top), Math.round(x.bottom), Math.round(x.left), Math.round(x.right)]; };
            return { cls: m.className, menu: b(m), vh: innerHeight, items: [...m.querySelectorAll('button, [role=menuitem]')].map(e => (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 24) + ':' + b(e) + ':' + e.scrollHeight + '/' + e.clientHeight) }; })()`);
        const rows = r.items.map(t => t.split(':')).filter(a => a[1] !== '0,0,0,0').map(a => ({ name: a[0], top: +a[1].split(',')[0], bottom: +a[1].split(',')[1], fit: a[2] }));
        for (let k = 1; k < rows.length; k++) assert.ok(rows[k].top >= rows[k - 1].bottom - 1, `${rows[k].name} does not overlap ${rows[k - 1].name}: ` + JSON.stringify(rows));
        assert.ok(rows.every(x => { const [sh, ch] = x.fit.split('/'); return +sh <= +ch + 1; }), 'no row hint is cut inside its row: ' + JSON.stringify(rows));
        assert.ok(rows.some(x => /^Sleep team/.test(x.name)), 'the stop items are in the menu: ' + JSON.stringify(rows));
        console.log('PASS zoom150_more_browser');
    } finally { try { await removeBoards(ev, [BOARD]); } catch (e) {} try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
