// The agent dock's task preview, by keyboard and by name (#8830, from the #8829 walk): closing the preview (Escape on its heading, its Close) gives the focus back to the row that opened it at 1280 as at 390;
// a row's name and its chip say the word on the screen (Queued, not Open) and not the task number; the goal link and the tab's Close are 24 px targets on a desktop and 44 px on a phone, and the focused
// Close is not clipped by its tab bar; a preview tab has a Keep button (Enter keeps it open, the focus stays in the tab); the pane is a region named Preview beside the chat and a dialog when full screen.
// Real isolated board; drives Chrome over CDP against the dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { connect } = require('./agent_view_harness');
const { openBoardTasksTab } = require('./helpers/board_tasks_tab');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const board = 'preview-a11y-' + Date.now().toString(36);
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect(); const Input = client.Input;
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out')); if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, n + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const key = async (k, code, vk, extra = {}) => { await Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...extra }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); await settle(150); };
    const enter = () => key('Enter', 'Enter', 13, { text: '\r', unmodifiedText: '\r' });
    const escape = () => key('Escape', 'Escape', 27);
    const api = (m, p, b) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(b))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const focusName = () => ev(`(() => { const a = document.activeElement; return a ? { tag: a.tagName.toLowerCase(), label: a.getAttribute('aria-label') || a.textContent.trim().slice(0, 60), inPreview: !!a.closest('#preview-pane') } : null; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'Boss', job_title: 'Orchestrator' });
        const g = await api('POST', `/api/board/${board}/goals`, { subscriber_id: 'Boss', title: 'Walk the new screens', outcome: 'x', done_when: 'y' });
        const goalId = g.body.id || (g.body.goal && g.body.goal.id);
        for (let i = 1; i <= 4; i++) assert.equal((await api('POST', `/api/board/${board}/tasks`, { subscriber_id: 'Boss', title: 'Walk task ' + i, body: 'Description ' + i, priority: 'medium', assigned_to: 'Boss', goal_id: goalId })).status, 201);
        for (const [tag, w, h, mobile] of [['1280', 1280, 900, false], ['390', 390, 844, true]]) {
            const at = `${tag}: `, min = mobile ? 44 : 24;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady('startup', 'liveList', 'liveListLoaded', 'settings');
            await openBoardTasksTab({ ev, waitFor }, board);
            await waitFor(`document.querySelectorAll('#board-task-list .board-task-item').length >= 3`, 'the task list', 10000); await settle(300);
            // a row says the word on the screen and not the number
            const rows = await ev(`[...document.querySelectorAll('#board-task-list .board-task-item')].map(r => ({ name: r.querySelector('.board-task-name').getAttribute('aria-label') || r.querySelector('.board-task-name').textContent, chipText: r.querySelector('.board-task-status-wrap').textContent.trim(), chipLabel: r.querySelector('.board-task-status-wrap').getAttribute('aria-label'), key: r.dataset.key }))`);
            assert.ok(rows.length >= 3 && rows.every(r => /^Open task: Walk task \d, Queued$/.test(r.name) && r.chipText === 'Queued' && r.chipLabel === 'Queued'), at + 'a row\'s name and chip say Queued (what the screen shows), with no task number: ' + JSON.stringify(rows[0]));
            const opener = async () => { await ev(`document.querySelectorAll('#board-task-list .board-task-name')[1].focus(); true`); return ev(`document.activeElement.closest('tr').dataset.key`); };
            const open = async () => { const k = await opener(); await enter(); await waitFor(`!!document.querySelector('#preview-pane .team-task-page')`, 'the preview', 8000); await settle(300); return k; };
            let k = await open();
            // the pane's name
            const pane = await ev(`(() => { const p = document.getElementById('preview-pane'); return { role: p.getAttribute('role'), label: p.getAttribute('aria-label') }; })()`);
            assert.deepEqual(pane, { role: mobile ? 'dialog' : 'region', label: 'Preview' }, at + 'the pane is a region named Preview beside the chat, a dialog full screen');
            // targets
            const sizes = await ev(`(() => { const r = e => { const b = e.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; }; const goal = [...document.querySelectorAll('#preview-pane .team-link')][0]; return { close: r(document.querySelector('#preview-pane .preview-tab-close')), keep: r(document.querySelector('#preview-pane .preview-tab-keep')), goal: goal ? r(goal) : null }; })()`);
            console.log(`measured at ${tag} (w x h px): ${JSON.stringify(sizes)}`);
            for (const [n, v] of Object.entries(sizes)) assert.ok(v && v[0] >= min && v[1] >= min, `${at}${n} is at least ${min} x ${min} px: ${JSON.stringify(sizes)}`);
            const keepText = await ev(`(() => { const k = document.querySelector('#preview-pane .preview-tab-keep'), cs = getComputedStyle(k); return { text: k.textContent.trim(), px: parseFloat(cs.fontSize), by: k.getAttribute('aria-describedby'), note: (document.getElementById(k.getAttribute('aria-describedby')) || {}).textContent || '', tabRight: Math.round(document.querySelector('#preview-pane .preview-tab').getBoundingClientRect().right), barRight: Math.round(document.getElementById('preview-tabs').getBoundingClientRect().right) }; })()`);
            assert.ok(keepText.text === 'Pin tab' && keepText.px >= 12, at + 'the pin button says Pin tab, at 12 px or more: ' + JSON.stringify(keepText));
            assert.match(keepText.note, /italics.*preview/, at + 'its description says an italic tab is a preview');
            assert.ok(keepText.tabRight <= keepText.barRight + 1, at + 'the tab with Pin tab fits its bar: ' + JSON.stringify(keepText));
            // the focused Close is not clipped by its tab bar
            const clip = await ev(`(() => { const c = document.querySelector('#preview-pane .preview-tab-close'); c.focus(); const b = c.getBoundingClientRect(), bar = document.getElementById('preview-tabs').getBoundingClientRect(); return { top: Math.round(b.top - bar.top), bottom: Math.round(bar.bottom - b.bottom), right: Math.round(bar.right - b.right) }; })()`);
            assert.ok(clip.top >= 0 && clip.bottom >= 0, at + 'the focused Close sits inside its tab bar, its ring is not clipped: ' + JSON.stringify(clip));
            await shot(`preview-a11y-close-focus-${tag}`);
            // Escape on the heading gives the focus back to the row
            await ev(`document.querySelector('#preview-pane h2').focus(); true`); await escape();
            await waitFor(`!document.querySelector('#preview-pane .team-task-page')`, 'the preview to close', 6000);
            assert.equal(await ev(`(document.activeElement.closest('tr') || {dataset:{}}).dataset.key`), k, at + 'Escape: the focus is on the row that opened it: ' + JSON.stringify(await focusName()));
            // Close with Enter does too (at 390 the Back button leaves full screen, and the Close button closes)
            k = await open();
            await ev(`document.querySelector('#preview-pane .preview-tab-close').focus(); true`); await enter();
            await waitFor(`!document.querySelector('#preview-pane .team-task-page')`, 'the preview to close', 6000);
            assert.equal(await ev(`(document.activeElement.closest('tr') || {dataset:{}}).dataset.key`), k, at + 'Close: the focus is on the row that opened it: ' + JSON.stringify(await focusName()));
            // Keep: a keyboard way to keep a preview tab open
            await open();
            assert.equal(await ev(`document.querySelector('#preview-pane .preview-tab').classList.contains('preview')`), true, at + 'the tab is a preview (italic) at first');
            await ev(`document.querySelector('#preview-pane .preview-tab-keep').focus(); true`);
            assert.match((await focusName()).label, /^Pin tab: Walk task \d$/, at + 'the pin button is named for its tab and begins with the words it shows');
            await shot(`preview-a11y-keep-${tag}`);
            await enter();
            assert.equal(await ev(`document.querySelector('#preview-pane .preview-tab').classList.contains('preview')`), false, at + 'Enter keeps the tab open');
            assert.equal(await ev(`!!document.querySelector('#preview-pane .preview-tab-keep')`), false, at + 'a kept tab has no Keep button');
            assert.deepEqual(await focusName(), { tag: 'button', label: await ev(`document.querySelector('#preview-pane .preview-tab-close').getAttribute('aria-label')`), inPreview: true }, at + 'the focus stays in the tab, on its Close');
            await ev(`document.querySelector('#preview-pane .preview-tab-close').click(); true`); await settle(300);
            console.log('PASS ' + at.trim());
        }
    } finally { await removeBoards(ev, [board]); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
