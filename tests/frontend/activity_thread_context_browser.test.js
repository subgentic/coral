// Activity rows say which goal and task they were about (#14442, U2 of goal #233; the record keeps them since S1, #14421): "Goal #233 · Threaded Needs you · Task #14390 · Mockups" under the row's detail, muted and whole; on a phone the
// card's second line. A task's own row is not told its task again nor a goal's row its goal; a row from before the record kept them, or about neither, has no such line (never guessed); a new row has its item's NAME (S2), never
// "a file" or "a question". 1280 and 390 px; the record is stood in (the shape S1 and S2 return: goal_id, task_id, goal_title, task_title, asker, title).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const ABOUT = 'Goal #233 · Threaded Needs you · Task #14390 · Mockups for threading';
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`(() => { const at = n => new Date(Date.now() - n * 60000).toISOString(), base = { actor: 'operator', team: 'coral-go-team', source: 'local', version: '', hint: '', surface: '' }, key = { goal_id: 233, goal_title: 'Threaded Needs you', task_id: 14390, task_title: 'Mockups for threading' };
                window.__rows = [
                    { id: 9, action: 'answer', item_kind: 'question', item_id: '71', title: 'Which docs format do you want?', asker: 'Developer', note: '@Developer Markdown', at: at(5), ...base, ...key },
                    { id: 8, action: 'task_complete', item_kind: 'task', item_id: '14390', title: 'Mockups for threading', note: '', at: at(8), ...base, ...key },
                    { id: 7, action: 'file_star', item_kind: 'file', item_id: 'b'.repeat(64), version: 'b'.repeat(64), title: 'after-filter-open-1280.png', note: '', at: at(12), ...base, ...key },
                    { id: 6, action: 'goal_close', item_kind: 'goal', item_id: '233', title: 'Threaded Needs you', note: 'done: shipped', at: at(20), ...base, goal_id: 233, goal_title: 'Threaded Needs you' },
                    { id: 5, action: 'file_star', item_kind: 'file', item_id: 'c'.repeat(64), version: 'c'.repeat(64), title: '', note: '', at: at(41), ...base },
                    { id: 4, action: 'answer', item_kind: 'question', item_id: '8', title: '', note: 'Yes', at: at(50), ...base },
                ];
                const real = window.fetch; window.fetch = (u, o) => new URL(String(u), location.origin).pathname === '/api/activity' ? Promise.resolve(new Response(JSON.stringify({ actions: window.__rows, check: { intact: true, rows: 6 } }), { headers: { 'Content-Type': 'application/json' } })) : real(u, o);
                localStorage.removeItem('coral-inbox-activity-filters'); window.switchNavTab('hub-inbox'); return import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => m.openInboxGroup('activity')).then(() => true); })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length === 6`, `${width}: the six rows`, 15000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the columns settle
            const rows = await ev(`[...document.querySelectorAll('#group-table-view tbody tr.dt-row')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
            const row = n => rows.find(t => t.includes(n)) || '';
            assert.ok(row('Which docs format do you want?').includes(ABOUT), `${width}: an answer says its goal and task: ${row('Which docs format')}`);
            assert.ok(row('after-filter-open-1280.png').includes(ABOUT), `${width}: a star says its goal and task: ${row('after-filter-open')}`);
            const done = row('Mockups for threading').replace(ABOUT, '');
            assert.ok(/Goal #233 · Threaded Needs you/.test(row('Completed')) && !/Task #14390 · Mockups for threading.*Task #14390/.test(row('Completed')), `${width}: a task's own row is not told its task again: ${row('Completed')}`);
            assert.ok(!/Goal #233 .*Goal #233/.test(row('done: shipped')), `${width}: a goal's own row is not told its goal again: ${row('done: shipped')}`);
            assert.ok(!/Goal #|Task #\d+ ·/.test(row('Yes')) && !/Goal #/.test(row('Starred a file')), `${width}: an older row, with no key, has no goal or task line: ${row('Yes')} / ${row('Starred a file')}`);
            const newRows = [row('Which docs format do you want?'), row('after-filter-open-1280.png')];
            assert.ok(newRows.every(t => !/\ba file\b|\ba question\b/.test(t)), `${width}: a new row never reads "a file" or "a question": ${JSON.stringify(newRows)}`);
            if (width === 390) { const cut = await ev(`[...document.querySelectorAll('#group-table-view tbody tr.dt-row')].slice(0, 3).map(r => { const walk = [...r.querySelectorAll('*')].filter(e => e.children.length === 0 && /Goal #/.test(e.textContent)); return walk.map(e => ({ clipped: e.scrollWidth > e.clientWidth + 1, ellipsis: getComputedStyle(e).textOverflow === 'ellipsis' && getComputedStyle(e).whiteSpace === 'nowrap' })); })`); assert.ok(cut.flat().length >= 2 && cut.flat().every(c => !c.clipped && !c.ellipsis), `${width}: the goal and task line is whole on a phone card, not cut with an ellipsis: ${JSON.stringify(cut)}`); }
            assert.ok(await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`) <= 0, `${width}: no sideways scroll`);
            if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/activity-about-${width}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            console.log(`   ✓ ${width} px`);
        }
        console.log('PASS Activity rows say their goal and task, a new row its item name, an older row neither guessed, at 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
