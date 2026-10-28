// #8792: verification stays in task details; dock rows only show status/title/avatar.
// Real API tasks with injected verification fields cover verified, evidence, unverified and absent states.
// Drives Chrome over CDP through agent_view_harness.js; run_cdp_suites.mjs finds CDP suites by that name.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { openBoardTasksTab } = require('./helpers/board_tasks_tab');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const BOARD = 'verify-4564-board';
// The server's field, by title: v- verified (two reviewers), e- evidence (by: []), u- unverified, n- none sent (an older server).
const ADD = `(() => {
    const prev = window.fetch;
    const verification = t => {
        const at = '2026-10-17T20:15:00Z';
        if (/^v-/.test(t.title)) return { state: 'verified', by: ['QA Engineer', 'Security Reviewer'], at };
        if (t.title === 'e-gate') return { state: 'evidence', by: ['gate:report'], at }; // a gate's report names itself (df6a32ff)
        if (/^e-/.test(t.title)) return { state: 'evidence', by: [], at }; // as #4563 sends it: no one confirmed it
        if (/^u-/.test(t.title)) return { state: 'unverified', by: [], at };
        return undefined;
    };
    window.fetch = async (url, opts = {}) => {
        const resp = await prev(url, opts);
        if (!/\\/api\\/board\\/[^/?]+\\/tasks(\\/\\d+)?(\\?|$)/.test(String(url)) || (opts.method && opts.method !== 'GET')) return resp;
        const body = await resp.clone().json().catch(() => null);
        if (!body) return resp;
        const tag = t => { if (t && typeof t === 'object' && t.title && t.status === 'completed') { const v = verification(t); if (v) t.verification = v; } return t; };
        if (Array.isArray(body)) body.forEach(tag); else if (Array.isArray(body.tasks)) body.tasks.forEach(tag); else tag(body);
        return new Response(JSON.stringify(body), { status: resp.status, headers: { 'content-type': 'application/json' } });
    };
})()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const shot = async (name) => {
        if (!process.env.CORAL_SCREENSHOT_DIR) return;
        await sleep(350); // sleep-ok: tab strips fade; a picture mid-fade shows two tabs lit
        fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    };
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const rows = () => ev(`[...document.querySelectorAll('#board-task-list .board-task-item:not(.board-task-header)')].map(r => ({ title: r.querySelector('.board-task-desc').textContent.replace(/[a-z_]+$/, m => m).trim(), mark: (() => { const b = r.querySelector('.board-task-verify-mark'); return b ? { cls: b.className.replace('board-task-verify-mark', '').trim(), aria: b.getAttribute('aria-label'), title: b.title, role: b.getAttribute('role'), words: b.textContent.trim() } : null; })() }))`);
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE });
        await Page.loadEventFired();
        await install();
        await ev(`localStorage.clear()`);
        await ev(ADD);
        // A board with finished tasks of each kind and an open one, through the real API.
        const post = async (path, body) => { const r = await api('POST', `/api/board/${BOARD}${path}`, body); assert.ok(r.status < 300, path + ': ' + JSON.stringify(r)); return r.body; };
        for (const title of ['v-one', 'v-two', 'e-one', 'e-gate', 'u-one', 'u-two', 'n-one']) {
            const t = await post('/tasks', { title, body: 'b ' + title, created_by: 'Operator' });
            await post('/tasks/claim', { subscriber_id: 'worker', task_id: t.id });
            await post('/tasks/' + t.id + '/complete', { subscriber_id: 'worker', message: 'done ' + title });
        }
        await post('/tasks', { title: 'open-one', body: 'still open', created_by: 'Operator' });
        await openBoardTasksTab({ ev, waitFor }, BOARD); // the board's tasks are an agent's Tasks tab (#7457)
        await waitFor(`document.querySelectorAll('#board-task-list .board-task-item:not(.board-task-header)').length === 8`, 'eight task rows', 10000, `JSON.stringify({ n: document.querySelectorAll('#board-task-list .board-task-item:not(.board-task-header)').length, txt: document.getElementById('board-task-list').textContent.slice(0, 160), tab: document.getElementById('agentic-panel-tasks').className, bt: (T.state.currentBoardTasks || []).length, page: document.getElementById('agentic-state').dataset.page, proj: T.state.boardPageProject })`);

        assert.ok((await rows()).every(r => r.mark === null), 'verification stays in the detail, not the one-line row');
        await shot('verify-list-dark');

        console.log('2. The task page has one plain muted line (no chip)');
        const detailLine = async title => {
            await ev(`[...document.querySelectorAll('#board-task-list .board-task-item')].find(r => r.textContent.includes(${JSON.stringify(title)})).click(); true`);
            await waitFor(`!!document.querySelector('#preview-pane #team-task-title') && document.querySelector('#team-task-title').textContent.includes(${JSON.stringify(title)}) && !!document.querySelector('#preview-pane .goals-pinbar')`, 'the page of ' + title, 12000);
            await sleep(250); // sleep-ok: the page's other sections are added when their module is there; an absent line has no event
            if (title === 'e-one') await shot('verify-detail');
            const out = await ev(`({ line: (document.querySelector('#preview-pane .task-detail-verification') || {}).textContent || null, chip: !!document.querySelector('#preview-pane .board-task-verify, #preview-pane .board-task-verify-mark') })`);
            await ev(`document.querySelector('#preview-pane .preview-tab-close').click(); true`);
            await waitFor(`document.querySelectorAll('#board-task-list .board-task-item').length > 0 && document.getElementById('board-task-list').getClientRects().length > 0`, 'the list again', 8000);
            return out;
        };
        let d = await detailLine('v-two'); assert.match(d.line, /^Verified by QA Engineer, Security Reviewer, /); assert.equal(d.chip, false);
        d = await detailLine('e-one'); assert.equal(d.line, 'Not independently verified (evidence attached)');
        d = await detailLine('e-gate'); assert.equal(d.line, 'Not independently verified (evidence attached: gate:report)');
        d = await detailLine('u-one'); assert.equal(d.line, null, 'an unverified task has no line');
        d = await detailLine('n-one'); assert.equal(d.line, null, 'no state from the server, no line');

        console.log('3. Verification marks stay out of the row in both themes');
        for (const theme of ['dark', 'light']) {
            await ev(`import((window.__coralStatic || '/static/') + 'settings_core.js').then(m => { m.clearCustomThemeVars(); m.applyTheme('${theme}'); return true; })`);
            assert.ok((await rows()).every(r => r.mark === null), 'detail-only verification in ' + theme);
            if (theme === 'light') await shot('verify-list-light');
        }

        console.log('4. A 390 px phone: verification stays in detail and the rows fit');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true });
        await sleep(400); // sleep-ok: the layout settles over frames after a viewport change; there is no completion event
        await ev(`window.toggleAgenticPanel(true); document.getElementById('agentic-tab-tasks').click(); true`);
        await waitFor(`document.querySelectorAll('#board-task-list .board-task-item').length === 8`, 'the phone rows', 8000);
        assert.ok((await rows()).every(r => r.mark === null), 'no verification icon in phone rows');
        const phone = await ev(`(() => { const dock = document.getElementById('agentic-state').getBoundingClientRect();
            const over = [...document.querySelectorAll('#board-task-list .board-task-item')].filter(b => b.getBoundingClientRect().right > dock.right + 1 || b.getBoundingClientRect().left < dock.left - 1).length;
            const r0 = document.querySelector('#board-task-list .board-task-item').getBoundingClientRect(), box = document.querySelector('#board-task-list .dt-box');
            return { over, page: document.documentElement.scrollWidth - document.documentElement.clientWidth, dock: [Math.round(dock.left), Math.round(dock.right)], row: [Math.round(r0.left), Math.round(r0.right)], box: box && [box.scrollWidth, box.clientWidth], kids: [...document.querySelector('#board-task-list .board-task-item').children].map(c => c.dataset.key + ':' + Math.round(c.getBoundingClientRect().width)) }; })()`);
        assert.equal(phone.over, 0, 'no row is cut off: ' + JSON.stringify(phone));
        assert.ok(phone.page <= 0, 'no sideways scroll: ' + JSON.stringify(phone));
        await shot('verify-list-phone');
        await Emulation.setTouchEmulationEnabled({ enabled: false });
        console.log('   ✓');
    } finally { await removeBoards(ev, [BOARD]); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
