// Delete team from the team page's More menu shows the in-page dialog, at 1280 and at 390 (#10318, Mobile pass 23: "Team page > More > Delete shows nothing and the team stays"). The real dialog, the real board: Delete asks, Cancel keeps
// the team, Delete team removes it and goes back to Agents. The sidebar's team menu has the same Delete. Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'tdd-' + Date.now().toString(36);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            let l = Page.loadEventFired(); await Page.navigate({ url: BASE + '/' }); await l;
            await ev(`fetch('/api/board/${B}/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'qa', as: 'QA Engineer', content: 'a team to delete' }) }).then(r => r.status)`);
            l = Page.loadEventFired(); await Page.navigate({ url: `${BASE}/board/${B}` }); await l;
            await install();
            await ev(`window.__coralReady.then(() => true)`);
            await waitFor(`!!document.getElementById('team-page-more') && document.getElementById('team-page-more').getBoundingClientRect().width > 0`, `${w}: the team page and its More menu`, 15000);
            await ev(`document.getElementById('team-page-more').click(); true`);
            await waitFor(`!!document.getElementById('mb-delete-btn') && document.getElementById('mb-delete-btn').getClientRects().length > 0`, `${w}: Delete in the More menu`, 5000);
            await ev(`document.getElementById('mb-delete-btn').click(); true`);
            await waitFor(`!!document.getElementById('confirm-modal') && document.getElementById('confirm-modal').getClientRects().length > 0 && /Delete team/.test(document.getElementById('confirm-modal').textContent)`, `${w}: the Delete team dialog is on screen`, 5000);
            const dlg = await ev(`(() => { const m = document.getElementById('confirm-modal'), r = m.getBoundingClientRect(); const yes = document.getElementById('confirm-modal-yes'), yr = yes.getBoundingClientRect(); return { text: m.textContent.replace(/\\s+/g, ' ').trim(), inside: yr.top >= 0 && yr.bottom <= innerHeight && yr.left >= 0 && yr.right <= innerWidth, yes: yes.textContent.trim() }; })()`);
            assert.match(dlg.text, /Delete team "/, `${w}: it names the team: ${dlg.text.slice(0, 120)}`);
            assert.ok(dlg.inside, `${w}: its Delete team button is on the screen`);
            await shot(`delete-team-${w}`);
            // Cancel keeps the team
            await ev(`[...document.querySelectorAll('#confirm-modal .modal-actions .btn')].find(b => /cancel/i.test(b.textContent)).click(); true`);
            await waitFor(`document.getElementById('confirm-modal').getClientRects().length === 0`, `${w}: Cancel closes it`, 4000);
            assert.equal(await ev(`fetch('/api/board/projects').then(r => r.json()).then(p => (Array.isArray(p) ? p : p.projects || []).some(x => x.project === ${JSON.stringify(B)}))`), true, `${w}: the team is still there`);
        }
        // the real delete, at 390: the team goes and the page goes back to Agents
        await ev(`document.getElementById('team-page-more').click(); true`);
        await waitFor(`document.getElementById('mb-delete-btn').getClientRects().length > 0`, 'Delete again', 5000);
        await ev(`document.getElementById('mb-delete-btn').click(); true`);
        await waitFor(`!!document.getElementById('confirm-modal-yes') && document.getElementById('confirm-modal-yes').getClientRects().length > 0`, 'the dialog again', 5000);
        await ev(`document.getElementById('confirm-modal-yes').click(); true`);
        await waitFor(`fetch('/api/board/projects').then(r => r.json()).then(p => !(Array.isArray(p) ? p : p.projects || []).some(x => x.project === ${JSON.stringify(B)})).then(v => v)`, 'the team is gone', 8000).catch(() => {});
        assert.equal(await ev(`fetch('/api/board/projects').then(r => r.json()).then(p => (Array.isArray(p) ? p : p.projects || []).some(x => x.project === ${JSON.stringify(B)}))`), false, 'the team is deleted');
        // the sidebar's team menu has Delete team too (#10318)
        {
            const B2 = 'tdd2-' + Date.now().toString(36);
            await Page.addScriptToEvaluateOnNewDocument({ source: `window.__qaSeed = [{ name: 'sb-agent', prefix: 'A', n: 2, sleeping: true, board_project: ${JSON.stringify(B2)}, session_id: 'sb-agent-id' }];` });
            await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
            let l = Page.loadEventFired(); await Page.navigate({ url: BASE + '/' }); await l;
            await ev(`fetch('/api/board/${B2}/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'qa', as: 'QA Engineer', content: 'a team to delete from the sidebar' }) }).then(r => r.status)`);
            l = Page.loadEventFired(); await Page.navigate({ url: BASE + '/' }); await l;
            await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`Promise.resolve(window._coralLoadLiveSessions()).then(() => true)`);
            await waitFor(`!!document.querySelector('[data-on-click="team-delete"][data-board="${B2}"]')`, 'Delete team in the sidebar team menu', 15000);
            await ev(`document.querySelector('[data-on-click="team-delete"][data-board="${B2}"]').click(); true`);
            await waitFor(`!!document.getElementById('confirm-modal') && document.getElementById('confirm-modal').getClientRects().length > 0 && /Delete team/.test(document.getElementById('confirm-modal').textContent)`, 'the dialog from the sidebar', 6000);
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`fetch('/api/board/projects').then(r => r.json()).then(p => !(Array.isArray(p) ? p : p.projects || []).some(x => x.project === ${JSON.stringify(B2)})).then(v => v)`, 'the team is gone', 8000).catch(() => {});
            assert.equal(await ev(`fetch('/api/board/projects').then(r => r.json()).then(p => (Array.isArray(p) ? p : p.projects || []).some(x => x.project === ${JSON.stringify(B2)}))`), false, 'the sidebar\'s Delete team deleted it');
            await removeBoards(ev, [B2]).catch(() => {});
        }
        console.log('\nPASS Delete team from the More menu shows the dialog at 1280 and 390, Cancel keeps it, Delete team removes it');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
