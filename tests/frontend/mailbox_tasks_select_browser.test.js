// Selecting tasks in the Inbox's Tasks folder (#7776, #7743): the table's checkboxes, the selection bar in the toolbar's place ("N selected", Mark done, Clear), and Mark done calling each task's own Complete. Real board, tasks
// assigned to the Operator, on the isolated dev server (removed again).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const sceneShots = require('./helpers/scene_shots');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const shot = sceneShots(Page, 'inbox-tasks-no-files');
    const B = 'mt-2f0x-' + Date.now().toString(36);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'o-s' })).status, 200);
        const ids = [];
        for (const t of ['One', 'Two', 'Three']) { const r = await api('POST', `/api/board/${B}/tasks`, { title: t, body: 'x', created_by: 'orch', priority: 'medium', assigned_to: 'Operator' }); assert.ok(r.status < 300, JSON.stringify(r)); ids.push(r.body.id || r.body.task.id); }
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr').length === 3`, 'the three tasks', 15000);
        await ev(`(() => { const s=document.createElement('style'); s.textContent='*, *::before, *::after { transition: none !important; animation: none !important; }'; document.head.append(s); return true; })()`);
        assert.equal(await ev(`document.querySelectorAll('#group-table-view [data-key="files"]').length`), 0, 'no empty Files heading or cells');
        for (const width of [1280,390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: width===390 });
            await Emulation.setTouchEmulationEnabled({ enabled: width===390 });
            for (const theme of ['dark','light']) {
                await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`);
                await waitFor(`document.querySelector('#group-table-view .dt-box').classList.contains('dt-folded') === ${width===390}`, 'table layout settled');
                await shot(`${width}-${theme}`);
                if (width === 1280) { // the State column is the state's word in the state's colour: no pill, no dot, no fill, and 4.5:1 or more in each state (the Operator, #11189)
                    const st = await ev(`(() => { const lum = c => { const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
                        const td = document.querySelector('.dt-table tbody tr td[data-key=state], .dt-table tbody tr td:nth-child(2)'), cell = td.firstElementChild; const cs = getComputedStyle(cell);
                        const bgOf = e => { for (let n = e; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (c && !/rgba\\(.*, 0\\)$/.test(c) && c !== 'transparent') return c; } return getComputedStyle(document.body).backgroundColor; };
                        const bg = bgOf(td), ratios = {}; for (const k of ['queued', 'active', 'blocked', 'done']) { const p = document.createElement('span'); p.className = 'dt-state goal-state-task-' + k; p.textContent = k; td.append(p); ratios[k] = Math.round(((a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05))(lum(getComputedStyle(p).color), lum(bg)) * 100) / 100; p.remove(); }
                        return { cls: cell.className, text: cell.textContent.trim(), dot: !!td.querySelector('.goal-dot'), border: cs.borderTopWidth, bg: cs.backgroundColor, radius: cs.borderTopLeftRadius, ratios }; })()`);
                    assert.ok(/dt-state/.test(st.cls) && !/chip/.test(st.cls) && !st.dot && st.border === '0px' && /rgba\(0, 0, 0, 0\)|transparent/.test(st.bg) && st.text, `${width} ${theme}: the state is plain text, no pill, dot or fill: ` + JSON.stringify(st));
                    assert.ok(Object.values(st.ratios).every(r => r >= 4.5), `${width} ${theme}: every state's text holds 4.5:1 on the row: ` + JSON.stringify(st.ratios));
                    { // and on every kind of row: rest, open (aria-current, the row's hover background), selected and quiet, in this theme (QA Reviewer 2 on #11189: Queued was 4.40:1 on the open row, #11210)
                        const rows = await ev(`(() => { const P = c => { const n = c.match(/[\\d.]+/g).map(Number), k = c.startsWith('color(') ? 255 : 1; return [n[0] * k, n[1] * k, n[2] * k, c.includes('/') || n.length > 3 ? n[3] : 1]; };
                            const lum = a => { const [r, g, b] = a.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
                            const page = P(getComputedStyle(document.body).backgroundColor), over = (f, b) => [0, 1, 2].map(i => f[i] * f[3] + b[i] * (1 - f[3])).concat(1), ratio = (fg, bg) => { const a = lum(fg), b = lum(bg); return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100; };
                            const trs = [...document.querySelectorAll('.dt-table tbody tr.dt-row')], out = {}; const kinds = { rest: () => {}, open: tr => tr.setAttribute('aria-current', 'true'), selected: tr => tr.classList.add('dt-selected'), quiet: tr => tr.classList.add('dt-quiet') };
                            for (const [k, set] of Object.entries(kinds)) { const tr = trs[0], was = [tr.getAttribute('aria-current'), tr.className]; set(tr); const td = tr.children[1], bgc = getComputedStyle(td).backgroundColor, bg = over(P(bgc), page), ratios = {};
                                for (const c of ['queued', 'active', 'blocked', 'done']) { const p = document.createElement('span'); p.className = 'dt-state goal-state-task-' + c; p.textContent = c; td.append(p); ratios[c] = ratio(over(P(getComputedStyle(p).color), bg), bg); p.remove(); }
                                const sec = tr.querySelector('.dt-tone-secondary, .dt-subtitle'); if (sec) ratios.secondaryCell = ratio(over(P(getComputedStyle(sec).color), bg), bg);
                                out[k] = { bg: bgc, ratios }; tr.removeAttribute('aria-current'); if (was[0]) tr.setAttribute('aria-current', was[0]); tr.className = was[1]; }
                            return out; })()`);
                        for (const [k, v] of Object.entries(rows)) assert.ok(Object.values(v.ratios).every(r => r >= 4.5), `${width} ${theme}: on the ${k} row (${v.bg}) every state colour and the secondary cells hold 4.5:1: ` + JSON.stringify(v.ratios));
                    }
                }
                if (width === 1280) for (const fs of [16, 32]) { // the select column keeps its 44 px at any text size: the box is inside the table's border with the table's own inner padding, level with its row's text, and the chip is not cut (the Operator: "the checkboxes are outside the line", #11160)
                    await ev(`document.documentElement.style.fontSize = '${fs}px'; true`);
                    // The table sits near its fold at 200% text: it re-fits over a few frames after the size changes, and either settles as columns (a select column) or folds into mail rows (no select column: the row's own affordance). Wait until it is one or the other, then check what that layout promises.
                    await waitFor(`(() => { const box = document.querySelector('#group-table-view .dt-box'), c = document.querySelector('#group-table-view .dt-table .dt-check'); return !!box && ((!!c && c.getBoundingClientRect().width >= 44) || box.classList.contains('dt-folded') || box.classList.contains('dt-mail-on')); })()`, `${fs}px ${theme}: the table has laid out at this text size`, 6000);
                    await new Promise(r => setTimeout(r, 150)); // sleep-ok: the fold settles over a frame or two; there is no completion event
                    const mailRows = await ev(`(() => { const box = document.querySelector('#group-table-view .dt-box'); return !document.querySelector('#group-table-view .dt-table .dt-check') || getComputedStyle(document.querySelector('#group-table-view .dt-table .dt-check')).display === 'none' || box.classList.contains('dt-mail-on'); })()`);
                    if (mailRows) { assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth`), true, `${fs}px ${theme}: folded into mail rows (no select column at this text size), the page does not scroll sideways`); await ev(`document.documentElement.style.fontSize = ''; true`); continue; }
                    const g = await ev(`(() => { const box = document.querySelector('#group-table-view .dt-box'), b = box.getBoundingClientRect(), bw = parseFloat(getComputedStyle(box).borderLeftWidth), pad = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--table-pad-x')) || 12; const R = e => e.getBoundingClientRect(); const rows = [...document.querySelectorAll('.dt-table thead tr, .dt-table tbody tr.dt-row')].map(tr => { const cell = tr.children[0], inp = cell.querySelector('input'), next = tr.children[1], lead = next.querySelector('button, .chip, span, *') || next; const c = R(cell), i = R(inp), n = R(next), l = R(lead); return { inset: Math.round((i.left - b.left - bw) * 10) / 10, cellW: Math.round(c.width), dy: Math.round(((i.top + i.bottom) / 2 - (l.top + l.bottom) / 2) * 10) / 10, gap: Math.round((l.left - i.right) * 10) / 10, clipped: l.right > n.right + 0.5, inLeft: i.left >= c.left - 0.5 && i.right <= c.right + 0.5 }; }); return { pad, rows }; })()`);
                    const at = `${fs}px ${theme}: `;
                    assert.ok(g.rows.length >= 4 && g.rows.every(r => r.cellW >= 44 && r.inLeft), at + 'the select cell keeps its 44 px and holds the box: ' + JSON.stringify(g));
                    assert.ok(g.rows.every(r => r.inset >= g.pad - 1), at + `each checkbox is inside the table's border by the table's own padding (${g.pad} px): ` + JSON.stringify(g));
                    assert.ok(g.rows.every(r => Math.abs(r.dy) <= 1.5 && !r.clipped), at + 'the header and every row share a centre line with their first cell, nothing is clipped: ' + JSON.stringify(g));
                    assert.ok(new Set(g.rows.map(r => r.inset)).size === 1, at + 'the header box and the rows\' boxes are in one column: ' + JSON.stringify(g));
                    await ev(`document.documentElement.style.fontSize = ''; true`);
                }
            }
        }
        await Emulation.setDeviceMetricsOverride({ width:1280, height:800, deviceScaleFactor:1, mobile:false });
        await Emulation.setTouchEmulationEnabled({ enabled:false });
        // Keep the real API rows and their timestamps; change only the returned artifact count.
        // The heading must appear and disappear on refresh even when updated_at did not change.
        await ev(`(() => {
            window.__filesFetchOriginal = window.fetch;
            window.__filesCount = 2;
            window.fetch = async (...args) => {
                const response = await window.__filesFetchOriginal(...args);
                const url = new URL(typeof args[0]==='string' ? args[0] : args[0].url, location.href);
                if (url.pathname !== '/api/board/tasks') return response;
                window.__filesRequested = (url.searchParams.get('fields')||'').split(',').includes('artifact_count');
                const data = await response.json();
                data.tasks = data.tasks.map(t => ({...t, artifact_count: t.id===${ids[0]} ? window.__filesCount : 0}));
                return new Response(JSON.stringify(data), {status:response.status,headers:{'Content-Type':'application/json'}});
            };
            return true;
        })()`);
        const refresh = () => ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.showInbox({quiet:true})).then(()=>true)`);
        await refresh();
        await waitFor(`document.querySelector('#group-table-view th[data-key="files"]') && document.querySelectorAll('#group-table-view .dt-files').length===1`, 'Files appears with one populated row');
        assert.equal(await ev('window.__filesRequested'),true,'the adapter requests the server count');
        assert.equal(await ev(`document.querySelector('#group-table-view .dt-files-count').textContent.trim()`), '2 files', 'the count is kept');
        await ev(`window.__filesCount=0; true`); await refresh();
        await waitFor(`!document.querySelector('#group-table-view [data-key="files"]')`, 'Files disappears after the count clears');
        await ev(`window.fetch=window.__filesFetchOriginal; delete window.__filesFetchOriginal; delete window.__filesCount; delete window.__filesRequested; true`);
        const cb = i => `document.querySelectorAll('#group-table-view tbody .dt-check input')[${i}]`;
        const state = () => ev(`(() => { const r = document.querySelector('#group-table-view .gt-toolbar'), bar = document.querySelector('#group-table-view .dt-bar'); return { selecting: r.classList.contains('team-toolbar-selecting'), count: bar && !bar.hidden ? bar.querySelector('.dt-bar-count').textContent : '', actions: bar ? [...bar.querySelectorAll('button')].map(b => b.textContent) : [] }; })()`);
        assert.equal((await state()).selecting, false);
        await ev(`${cb(0)}.click(); ${cb(1)}.click(); true`);
        let s = await state();
        assert.deepEqual([s.selecting, s.count, s.actions], [true, '2 selected', ['Mark done', 'Clear']], 'the bar takes the toolbar line ' + JSON.stringify(s));
        await ev(`[...document.querySelectorAll('#group-table-view .dt-bar-action')].find(b => b.textContent === 'Mark done').click(); true`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr').length === 1`, 'the two done tasks leave the list', 12000);
        await ev(`[...document.querySelectorAll('.toast')].some(t => /Marked done 2 tasks/.test(t.textContent))`).then(ok => assert.ok(ok, 'the toast says two were marked done'));
        assert.equal((await state()).selecting, false, 'the toolbar is back');
        // the table's order is the Inbox's (not the order they were made in): the two rows that were selected are the two the server completed, and the one left is still open
        const st = await Promise.all(ids.map(async id => { const t = await api('GET', `/api/board/${B}/tasks/${id}`); return [id, t.body.title, t.body.status || t.body.task.status]; }));
        const left = await ev(`document.querySelector('#group-table-view .dt-table tbody .dt-primary').textContent`);
        assert.equal(st.filter(x => x[2] === 'completed').length, 2, 'the server completed two ' + JSON.stringify(st));
        assert.deepEqual(st.filter(x => x[2] !== 'completed').map(x => x[1]), [left], 'the one still open is the one still listed ' + JSON.stringify(st));
        console.log('PASS Inbox Tasks: select and Mark done through the selection bar');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
