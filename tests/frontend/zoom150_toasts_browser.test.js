// Walk 60 (#17300), 150% zoom on a 1280 x 800 laptop (853 x 533 CSS px): the toasts ("needs you", "Sent") covered the team header, its tabs and the message box.
// On a short desktop window the column does not cover them.
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
        await ev(`T.state.liveSessions = []; T.render.renderLiveSessions([]); window.openTeamPage(${JSON.stringify(BOARD)}).then(() => true)`);
        await waitFor(`!!document.getElementById('team-tabs-row') && document.getElementById('team-tabs-row').getClientRects().length > 0`, 'the tab strip', 15000);
        await ev(`(async () => { const n = await import((window.__coralStatic || '/static/') + 'notifications.js'); n.showToast('Sent: the team has your message'); n.showToast('Copied: paste it to an agent'); n.showToast('Orchestrator needs you: a plan to approve', false, { label: 'Open', onClick() {} }); return true; })()`).catch(() => {});
        await waitFor(`document.querySelectorAll('#toast-host > .toast').length >= 2`, 'the toasts', 5000);
        await ev(`Promise.all([...document.querySelectorAll('#toast-host > .toast')].flatMap(t => t.getAnimations()).map(a => a.finished.catch(() => {}))).then(() => true)`);
        await shot('zoom-toasts');
        const r = await ev(`(() => { const b = e => { if (!e || !e.getClientRects().length) return null; const x = e.getBoundingClientRect(); return [Math.round(x.top), Math.round(x.bottom), Math.round(x.left), Math.round(x.right)]; };
            return { vh: innerHeight, notices: b(document.getElementById('notices')), head: b(document.getElementById('team-page-head')), tabs: b(document.getElementById('team-tabs-row')), box: b(document.querySelector('#team-page textarea, #team-page .team-composer, #team-page .board-compose')), n: document.querySelectorAll('#toast-host > .toast').length }; })()`);
        assert.ok(r.notices && r.tabs && r.notices[0] >= r.tabs[1] - 1 && r.notices[1] <= r.vh - 60, 'the toasts sit under the team header and tabs (and its search box), clear of the foot where the message box is: ' + JSON.stringify(r));
        console.log('PASS zoom150_toasts_browser');
    } finally { try { await removeBoards(ev, [BOARD]); } catch (e) {} try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
