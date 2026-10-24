// The task detail and the Tasks tab (#7182, UI/UX's #7180 findings 1, 2 and 5), with a real board on the isolated dev server (four tasks taken through the real routes: open, claimed, submitted for review with a
// patch, finished; the board is removed again): the review is in words a person reads ("In review", "Submitted by qa, today 08:25", "Waiting for the Orchestrator to pick reviewers", no ISO times, no "slot"); an
// artifact's link shows its name, the address only as its title; the lifecycle chip wraps with Priority under it and nothing scrolls sideways at 390 px and 200% text; the Tasks tab says "1 of 4 done"; every
// title in the list is drawn as the link it is; and a priority is not in capitals. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: panels draw after the clicks
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const B = 'taskpages-' + Date.now().toString(36);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        for (const [id, jt] of [['orch', 'Orchestrator'], ['fe', 'Frontend Dev'], ['qa', 'QA Engineer']]) await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: jt, session_name: id + '-s' });
        const mk = async (title, assigned, priority) => { const r = await api('POST', `/api/board/${B}/tasks`, { title, body: 'Details for ' + title, assigned_to: assigned, created_by: 'orch', priority }); assert.ok(r.status < 300, JSON.stringify(r)); return r.body.id || r.body.task.id; };
        const t1 = await mk('Build the Goals view', 'fe', 'high'), t2 = await mk('Review the Goals view', 'qa', 'medium'); await mk('Write the agent doc text', 'orch', 'low'); const t4 = await mk('Fix the flaky suite', 'fe', 'medium');
        const claim = (who, t) => api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: who, task_id: t });
        assert.equal((await claim('fe', t1)).status, 200); assert.equal((await claim('qa', t2)).status, 200);
        assert.equal((await api('POST', `/api/board/${B}/tasks/${t2}/submit-review`, { subscriber_id: 'qa', reason: 'review pending', message: 'Patch ready: the Goals view, layout A.', artifacts: [{ name: 'goals.patch', uri: 'coral://artifacts/' + 'a'.repeat(64), description: 'the whole change' }] })).status, 200);
        assert.equal((await api('POST', `/api/board/${B}/tasks/${t4}/complete`, { subscriber_id: 'fe', message: 'Fixed.' })).status, 200);
        for (const [w, h, mobile, font] of [[1280, 900, false, ''], [390, 844, true, '32px']]) {
            const tag = `${w} px${font ? ', 200% text' : ''}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            if (font) await ev(`document.documentElement.style.fontSize = '${font}'; true`);
            await ev(`(async () => { const m = await import(${S} + 'message_board.js'); const { showView } = await import(${S} + 'utils.js'); showView('messageboard-view'); m.selectBoardProject(${JSON.stringify(B)}); return true; })()`);
            await waitFor(`document.getElementById('mb-post-input') && document.getElementById('mb-post-input').getClientRects().length > 0`, 'the board', 12000); await sleep(600); // sleep-ok: layout settles after the panel draws
            await ev(`(() => { const b = document.getElementById('panel-toggle-btn') || document.getElementById('popout-panel-toggle-btn'); if (b) b.click(); const t = document.getElementById('agentic-tab-tasks'); if (t) t.click(); return true; })()`);
            await waitFor(`document.querySelectorAll('#agentic-panel-tasks .board-task-item:not(.board-task-header)').length === 4`, 'four tasks', 12000); await sleep(400); // sleep-ok: layout settles after the panel draws
            // the tab says how many are done; every title is a link; a priority is not in capitals
            const tab = await ev(`(() => { const rows = [...document.querySelectorAll('#agentic-panel-tasks .board-task-item:not(.board-task-header):not(.completed) .board-task-desc')]; const link = getComputedStyle(document.documentElement).getPropertyValue('--link-text').trim(); const probe = document.createElement('span'); probe.style.color = link; document.body.append(probe); const lc = getComputedStyle(probe).color; probe.remove();
                const pr = document.querySelector('#agentic-panel-tasks .board-task-item:not(.board-task-header) .board-task-priority'); return { label: document.getElementById('agentic-tab-tasks').getAttribute('aria-label'), colors: [...new Set(rows.map(r => getComputedStyle(r).color))], link: lc, rows: rows.length, prText: pr.textContent, prTransform: getComputedStyle(pr).textTransform }; })()`);
            assert.match(tab.label, /1 of 4 done/, `${tag}: the Tasks tab says how many are done: ` + JSON.stringify(tab));
            assert.ok(tab.colors.length === 1 && tab.colors[0] === tab.link, `${tag}: every open task's title is the link colour: ` + JSON.stringify(tab));
            assert.ok(tab.prTransform === 'none' && /^(High|Medium|Low)$/.test(tab.prText), `${tag}: a priority is not in capitals: ` + JSON.stringify(tab));
            // a finished task's title is still text: 4.5:1 on the panel in both themes (a 60% mix of the link colour measured 3.3 and 2.9)
            const fin = await ev(`(() => { const lum = c => { const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
                const el = document.querySelector('#agentic-panel-tasks .board-task-item.completed:not(.board-task-header) .board-task-desc'); const out = {}; if (!el) return null;
                for (const theme of ['dark', 'light']) { document.documentElement.dataset.theme = theme; const fg = getComputedStyle(el), bgc = getComputedStyle(document.documentElement).getPropertyValue('--bg-secondary').trim(); const p = document.createElement('span'); p.style.color = bgc; document.body.append(p); const bg = getComputedStyle(p).color; p.remove();
                    const a = lum(fg.color), b = lum(bg); out[theme] = { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), alpha: /rgba/.test(fg.color) && !/, 1\\)/.test(fg.color), line: fg.textDecorationLine }; }
                delete document.documentElement.dataset.theme; return out; })()`);
            assert.ok(fin && fin.dark.ratio >= 4.5 && fin.light.ratio >= 4.5 && !fin.dark.alpha && !fin.light.alpha, `${tag}: a finished title reaches 4.5:1 in both themes: ` + JSON.stringify(fin));
            assert.equal(fin.dark.line, 'line-through', `${tag}: a finished title is struck through`);
            // the review task's detail
            await ev(`(() => { const rows = [...document.querySelectorAll('#agentic-panel-tasks .board-task-item:not(.board-task-header)')]; rows.find(x => /Review the Goals view/.test(x.textContent)).click(); return true; })()`);
            await waitFor(`!!document.querySelector('#task-detail-modal .task-detail-title') && /Review the Goals view/.test(document.querySelector('#task-detail-modal .task-detail-title').textContent)`, 'the task detail', 8000); await sleep(400); // sleep-ok: layout settles after the panel draws
            const d = await ev(`(() => { const m = document.querySelector('#task-detail-modal'); const text = m.innerText; const body = m.querySelector('.modal-body, .task-detail-body-wrap') || m; const meta = m.querySelector('.task-detail-meta'); const items = [...meta.querySelectorAll('.task-detail-meta-item')]; const a = m.querySelector('a[data-artifact-uri]');
                return { text, life: (m.querySelector('.task-detail-status') || {}).textContent, iso: /\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d/.test(text), sideways: [...m.querySelectorAll('*')].filter(e => e.scrollWidth > e.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowX)).map(e => e.className.toString().slice(0, 30)), link: a && a.textContent, tip: a && a.title, itemsTop: items.map(e => Math.round(e.getBoundingClientRect().top)), itemsBottom: items.map(e => Math.round(e.getBoundingClientRect().bottom)), overflowRight: [...m.querySelectorAll('.modal-content *')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > innerWidth + 1).map(e => e.className.toString().slice(0, 30)).slice(0, 4) }; })()`);
            assert.equal(d.life, 'In review', `${tag}: the lifecycle is "In review": ` + d.life);
            assert.ok(!/slot|candidate/i.test(d.text) && !d.iso, `${tag}: no "slot", no "candidate", no ISO time: ` + d.text.slice(0, 400));
            assert.match(d.text, /Submitted by qa, /, `${tag}: Submitted by qa, <when>`);
            assert.match(d.text, /Waiting for the Orchestrator to pick reviewers/, `${tag}: says what it waits for`);
            assert.equal(d.link, 'goals.patch', `${tag}: the artifact link is its name: ` + d.link); assert.match(d.tip || '', /^coral:\/\/artifacts\/a{64}$/, `${tag}: the address is its title`);
            assert.deepEqual(d.sideways, [], `${tag}: nothing in the detail scrolls sideways: ` + JSON.stringify(d.sideways));
            assert.deepEqual(d.overflowRight, [], `${tag}: nothing runs past the screen: ` + JSON.stringify(d.overflowRight));
            if (mobile) assert.ok(d.itemsTop[1] >= d.itemsBottom[0] - 1, `${tag}: Priority is under the lifecycle: ` + JSON.stringify([d.itemsTop, d.itemsBottom]));
            await ev(`[...document.querySelectorAll('#task-detail-modal button')].find(b => /^Close$/.test(b.textContent.trim())).click(); true`);
        }
        console.log('PASS task pages');
    } finally { await api('DELETE', `/api/board/${B}`).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
