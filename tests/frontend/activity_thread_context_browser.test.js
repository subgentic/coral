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
            // every fixture row is picked by its id (the table keys its rows by it) and must exist: a check on a row that is not there would pass for nothing (UI Reviewer's SHOULD on #14442)
            const byId = id => ev(`(() => { const tr = document.querySelector('#group-table-view tbody tr.dt-row[data-key="${id}"]'); if (!tr) return null; const btn = tr.querySelector('button.dt-mail-open, button.dt-primary'); return { text: tr.textContent.replace(/\\s+/g, ' ').trim(), name: btn ? btn.getAttribute('aria-label') : '' }; })()`);
            const R = {}; for (const id of [9, 8, 7, 6, 5, 4]) { R[id] = await byId(id); assert.ok(R[id] && R[id].text.length > 0, `${width}: fixture row ${id} is on the page`); }
            const T = id => R[id].text;
            assert.ok(T(9).includes('Which docs format do you want?') && T(9).includes(ABOUT), `${width}: an answer says its goal and task: ${T(9)}`);
            assert.ok(T(7).includes('after-filter-open-1280.png') && T(7).includes(ABOUT), `${width}: a star says its goal and task: ${T(7)}`);
            assert.ok(T(8).includes('Completed') && /Goal #233 · Threaded Needs you/.test(T(8)) && (T(8).match(/task #14390/gi) || []).length === 1, `${width}: a task's own row says its goal and is not told its task again: ${T(8)}`);
            assert.ok(T(6).includes('done: shipped') && (T(6).match(/Goal #233/g) || []).length === 0, `${width}: a goal's own row is not told its goal again: ${T(6)}`);
            assert.ok(/a file/.test(T(5)) && /Starred/.test(T(5)) && !/Goal #|Task #\d/.test(T(5)), `${width}: an older starred row (id 5, no key) reads 'a file' and has no goal or task line: ${T(5)}`);
            assert.ok(/a question/.test(T(4)) && /Your answer: Yes/.test(T(4)) && !/Goal #|Task #\d/.test(T(4)), `${width}: an older answer (id 4, no key) reads 'a question' and has no goal or task line: ${T(4)}`);
            assert.ok([9, 7].every(id => !/\ba file\b|\ba question\b/.test(T(id))), `${width}: a new row never reads "a file" or "a question": ${T(9)} / ${T(7)}`);
            // the row's accessible name says what the row says (WCAG 2.5.3): its goal and task are in it too, the same words as the visible line
            for (const id of [9, 7]) { const nm = R[id].name; if (nm) assert.ok(nm.includes('Goal #233') && nm.includes('Task #14390'), `${width}: row ${id}'s accessible name carries its goal and task: ${nm}`); }
            if (width === 390) { const cut = await ev(`[...document.querySelectorAll('#group-table-view tbody tr.dt-row')].slice(0, 3).map(r => { const e = r.querySelector('.dt-mail-ask'); const cs = e && getComputedStyle(e); return e ? { has: /Goal #/.test(e.textContent), clipped: e.scrollWidth > e.clientWidth + 1, ellipsis: cs.textOverflow === 'ellipsis' && cs.whiteSpace === 'nowrap' } : null; })`); assert.ok(cut.length >= 2 && cut.every(c => c && c.has && !c.clipped && !c.ellipsis), `${width}: the goal and task line is whole on a phone card (the card's wrapping second line), not cut with an ellipsis: ${JSON.stringify(cut)}`); }
            assert.ok(await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`) <= 0, `${width}: no sideways scroll`);
            if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/activity-about-${width}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            console.log(`   ✓ ${width} px`);
        }
        console.log('PASS Activity rows say their goal and task, a new row its item name, an older row neither guessed, at 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
