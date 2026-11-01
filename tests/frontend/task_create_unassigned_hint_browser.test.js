// Create task says who picks up an unassigned task (#11885, Beta #11837 F): under "Assigned to", "Unassigned: any agent on the team can claim it, and an idle one is told when it is ready. Choose an agent to hand it to
// them." A real team; the dialog the goal page and the Tasks tab open. 1280 and 390 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'tch-' + Date.now().toString(36);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            assert.equal(await ev(`fetch('/api/board/${B}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'orch', job_title: 'Orchestrator', session_name: '${B}' }) }).then(r => r.status)`), 200);
            await ev(`window.showCreateTaskModal({ project: ${JSON.stringify(B)} }); true`);
            await waitFor(`!!document.getElementById('create-task-modal') && document.getElementById('create-task-modal').getClientRects().length > 0 && !!document.getElementById('create-task-assignee')`, at + 'the dialog', 8000);
            const info = await ev(`(() => { const sel = document.getElementById('create-task-assignee'), field = sel.closest('.field, .form-field, .dlg-field, div'); const hint = [...document.getElementById('create-task-modal').querySelectorAll('*')].filter(e => e.children.length === 0 && /^Unassigned: any agent/.test(e.textContent)).map(e => ({ text: e.textContent, shown: e.getClientRects().length > 0, near: !!e.closest('[id]') && e.compareDocumentPosition(sel) !== 0 })); return { first: sel.options[0].textContent, hint, order: hint.length ? !!(sel.compareDocumentPosition(document.querySelectorAll('*')[0]) ) : false }; })()`);
            assert.equal(info.first, 'Unassigned', at + 'the first choice is still Unassigned');
            assert.ok(info.hint.length === 1 && info.hint[0].shown && info.hint[0].text === 'Unassigned: any agent on the team can claim it, and an idle one is told when it is ready. Choose an agent to hand it to them.', at + 'the hint: ' + JSON.stringify(info.hint));
            const near = await ev(`(() => { const sel = document.getElementById('create-task-assignee'), lab = document.querySelector('label[for="create-task-assignee"]'), h = [...document.getElementById('create-task-modal').querySelectorAll('*')].find(e => e.children.length === 0 && /^Unassigned: any agent/.test(e.textContent)), r = e => e.getBoundingClientRect(); return !!lab && r(h).top >= r(lab).bottom - 2 && r(h).bottom <= r(sel).top + 2 && r(sel).top - r(lab).bottom < 80; })()`);
            await shot(`create-task-hint-${w}`);
            assert.ok(near, at + 'it sits between the Assigned to label and its choices, where the form puts a field\'s help');
            await shot(`create-task-hint-${w}`);
            await ev(`window.closeCreateTaskModal ? window.closeCreateTaskModal() : document.getElementById('create-task-modal').close?.(); true`);
        }
        console.log('task_create_unassigned_hint_browser: ok');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
