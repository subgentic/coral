// Automations > Queue, the history of the runs (#13724, the Operator: "I'd like to see a list of the history of the runs somewhere"): under the live table a History list of every entry that ended, newest first: the agent,
// the resource, the task and goal (links, like the live table's), the note (the hook's matched pattern), when it started, how long it waited and held, and how it ended. 50 a request and Show more for the next 50 by the
// cursor; filtered by resource and agent; searched by the folder's own search box (the server searches); the live queue changing reads the first page again; no record and a failed read say so. The reads are
// stubbed as the server answers them. 1280 and 390 (a phone's rows are cards with the links in their menu, the filters fill the width, no sideways scroll).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const LIVE = { resources: [{ name: 'mac-heavy', slots: 1, machine: 'Mac', max_lease_seconds: 3600, holders: [], queue: [] }] };
const STUB = `(() => { const real = window.fetch; window.__queueTickMs = 1000;
    window.__live = ${JSON.stringify(LIVE)}; window.__runReqs = []; window.__runs = { status: 200, history: true };
    const AG = ['Frontend Dev', 'QA Engineer', 'Backend Dev'], RES = ['mac-heavy', 'mini'], ENDS = ['released', 'call_ended', 'expired', 'kicked', 'cap', 'unused'];
    const mk = i => ({ key: (1000000 - i) + '-1', id: 500 - i, resource: RES[i % 2], machine: RES[i % 2] === 'mini' ? 'Mac mini' : 'Mac', agent: AG[i % 3], task: 13000 + i, project: 'coral-go-team', goal_id: i % 4 === 0 ? 225 : 0, goal_title: i % 4 === 0 ? 'Resource queue, the Operator sees who waits and why' : '',
        via: i % 2 ? 'hook' : '', pattern: i % 2 ? 'go test ./...' : '', enqueued_at: new Date(Date.now() - (i + 5) * 600000).toISOString(), started_at: new Date(Date.now() - (i + 4) * 600000).toISOString(), ended_at: new Date(Date.now() - (i + 1) * 600000).toISOString(), wait_s: 90, held_s: 1500, end: ENDS[i % 6] });
    window.__all = Array.from({ length: 120 }, (_, i) => mk(i));
    window.__all[1] = { ...window.__all[1], started_at: '', held_s: 0, wait_s: 400, end: 'kicked_from_line', task: 0, goal_id: 0, goal_title: '', pattern: '' }; // never ran, no task
    window.__all[2] = { ...window.__all[2], project: '', goal_id: 0, goal_title: '' }; // a row from before the record kept the board: its task is text
    window.fetch = (u, o) => { const url = new URL(String(u), location.origin), p = url.pathname, get = !o || !o.method || o.method === 'GET';
        const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
        if (p === '/api/resources' && get) return json(window.__live);
        if (p === '/api/analytics/resource-queue/runs') { window.__runReqs.push(url.search);
            if (window.__runs.status !== 200) return json({ error: 'no' }, window.__runs.status);
            if (!window.__runs.history) return json({ history: false, runs: [], next: '', resources: [], agents: [] });
            const q = (url.searchParams.get('q') || '').toLowerCase(), res = url.searchParams.get('resource'), ag = url.searchParams.get('agent'), before = url.searchParams.get('before'), lim = Math.min(50, +url.searchParams.get('limit') || 50);
            let list = window.__all.filter(r => (!res || r.resource === res) && (!ag || r.agent === ag) && (!q || [r.agent, r.resource, r.pattern, '#' + r.task, r.end.replace(/_/g, ' ')].some(s => String(s).toLowerCase().includes(q))));
            if (before) { const at = list.findIndex(r => r.key === before); list = at < 0 ? [] : list.slice(at + 1); }
            const page = list.slice(0, lim);
            return json({ history: true, runs: page, next: list.length > lim ? page[page.length - 1].key : '', resources: RES, agents: AG }); }
        return real(u, o); };
    return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const run = async (name, fn) => { try { await fn(); results.push(true); console.log('PASS ' + name); } catch (e) { results.push(false); console.log('FAIL ' + name + ': ' + (e && e.message)); process.exitCode = 1; } };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 500)); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const rows = () => ev(`[...document.querySelectorAll('.qh-section tbody tr[data-key]')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
    const reqs = () => ev(`window.__runReqs.slice()`);
    const history = '.qh-section';
    const dbg = () => ev(`JSON.stringify({ reqs: window.__runReqs.slice(-4), rows: document.querySelectorAll('.qh-section tbody tr[data-key]').length, text: (document.querySelector('.qh-section') || { textContent: 'NO SECTION' }).textContent.slice(0, 160) })`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`window.__opened = []; window.openTeamPage = (t, o) => { window.__opened.push(['team', t, JSON.stringify(o)]); return Promise.resolve(); }; true`);
            await ev(`history.pushState(null, '', '/automations/queue'); window.dispatchEvent(new PopStateEvent('popstate')); true`);
            await waitFor(`document.querySelectorAll('${history} tbody tr[data-key]').length >= 50`, at + 'the first 50 runs', 10000);

            await run(at + 'the history is under the live table, newest first, 50 a request, the count says there are more', async () => {
                assert.equal(await ev(`document.querySelector('${history} h3').textContent`), 'History');
                assert.equal(await ev(`document.querySelector('${history} .session-group-count').textContent`), '50+');
                assert.ok(await ev(`(() => { const live = document.querySelector('#group-table-view .dt-box'), hs = document.querySelector('${history}'); return !!live && !!hs && !!(live.compareDocumentPosition(hs) & Node.DOCUMENT_POSITION_FOLLOWING); })()`), 'the history follows the live table');
                const r = await reqs();
                assert.ok(r.some(q => /limit=50/.test(q) && !/before=/.test(q)), 'a first request of 50: ' + JSON.stringify(r));
                assert.equal(await ev(`document.querySelectorAll('${history} tbody tr[data-key]').length`), 50);
                await shot(`queue-history-${process.env.SHOT_TAG || 'after'}-${w}`);
            });
            if (!mobile) {
                await run(at + 'a run says who, where, the task and goal as links, the note, when it started, how long it waited and held, and how it ended', async () => {
                    const heads = await ev(`[...document.querySelectorAll('${history} thead th')].filter(t => t.getClientRects().length).map(t => t.textContent.trim())`);
                    assert.deepEqual(heads, ['Agent', 'Resource', 'Task', 'Goal', 'Started', 'Waited', 'Held', 'Ended'], at + 'the columns on screen at 1280 (the note shows from 62 rem, as the live table\'s): ' + JSON.stringify(heads));
                    const all = await rows();
                    assert.match(all[0], /Frontend Dev.*mac-heavy.*#13000.*#225 Resource queue.*2 min.*25 min.*Released/, at + all[0]);
                                        assert.match(all[3], /Backend Dev|Frontend Dev/);
                    assert.ok(await ev(`[...document.querySelectorAll('${history} tbody tr[data-key] td')].every(c => !/-run|secret/.test(c.textContent))`), 'never a command');
                    const row0 = `document.querySelectorAll('${history} tbody tr[data-key]')[0]`;
                    assert.equal(await ev(`${row0}.querySelector('.queue-agent').tagName`), 'SPAN', 'the agent is text when it is not running here');
                    assert.equal(await ev(`${row0}.querySelector('button.dt-link:not(.queue-goal)').textContent`), '#13000', 'the task is a link');
                    assert.ok(await ev(`(() => { const b = ${row0}.querySelector('button.dt-link:not(.queue-goal)'); return b.scrollWidth <= b.clientWidth + 1; })()`), 'the task number is not cut');
                    assert.ok(await ev(`[...document.querySelectorAll('${history} tbody tr[data-key]')][1].querySelector('.dt-chip .state-word').scrollWidth <= [...document.querySelectorAll('${history} tbody tr[data-key]')][1].querySelector('.dt-chip .state-word').clientWidth + 1`), 'the longest end, Kicked from the line, is not cut');
                    assert.match(await ev(`${row0}.querySelector('button.queue-goal').getAttribute('aria-label')`), /^Open goal #225 Resource queue/);
                    const never = await ev(`[...document.querySelectorAll('${history} tbody tr[data-key]')][1].textContent.replace(/\\s+/g, ' ')`);
                    assert.match(never, /Kicked from the line/); assert.ok(!/min\\b.*min\\b.*min\\b/.test(never), 'no hold for a run that never ran');
                    assert.equal(await ev(`[...document.querySelectorAll('${history} tbody tr[data-key]')][1].querySelectorAll('button.dt-link').length`), 0, 'no task, no links');
                    assert.equal(await ev(`[...document.querySelectorAll('${history} tbody tr[data-key]')][2].querySelectorAll('button.dt-link:not(.queue-goal)').length`), 0, 'a row from before the board was kept: the task is text, not a link');
                    assert.match((await rows())[2], /#13002/, 'but the task is still named');
                });
                await run(at + 'the page does not scroll sideways and the table fits its box', async () => {
                    assert.ok(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), 'no sideways scroll of the page');
                    assert.ok(await ev(`(() => { const box = document.querySelector('${history} .dt-box'); return box.scrollWidth <= box.clientWidth + 1; })()`), 'the history table has no scroll of its own');
                });
            } else {
                await run(at + 'a phone has cards: the agent, the resource and note, how it ended and the times, the links in the menu', async () => {
                    const card = await ev(`document.querySelector('${history} tbody tr[data-key]').textContent.replace(/\\s+/g, ' ')`);
                    assert.match(card, /Frontend Dev/, card); assert.match(card, /mac-heavy/, card); assert.match(card, /Released · held 25 min · waited 2 min/, card); assert.match(card, /Nov \d+, /, 'the start time is on the first line');
                    await ev(`document.querySelector('${history} tbody tr[data-key] .dt-mail-more-toggle').click(); true`);
                    await waitFor(`document.querySelectorAll('.dt-mail-menu:not([hidden]) .menu-item').length >= 2`, 'the card menu', 5000);
                    const items = await ev(`[...document.querySelectorAll('.dt-mail-menu:not([hidden]) .menu-item')].map(b => b.textContent.trim())`);
                    assert.ok(items.some(x => /^Task #13000/.test(x)) && items.some(x => /^Goal #225/.test(x)), 'task and goal in the menu: ' + JSON.stringify(items));
                    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
                });
                await run(at + 'the filters fill the width and the page does not scroll sideways', async () => {
                    const g = await ev(`(() => { const f = [...document.querySelectorAll('${history} .qh-filter')].map(s => Math.round(s.getBoundingClientRect().height)); return { heights: f, over: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
                    assert.deepEqual(g.heights, [44, 44], at + 'the filters are 44 px on a phone: ' + JSON.stringify(g)); assert.ok(g.over <= 1, 'no sideways scroll');
                });
            }
            await run(at + 'Show more reads the next 50 by the cursor, each run once, and the button goes at the end', async () => {
                await ev(`window.__runReqs.length = 0; document.querySelector('${history} .qh-more').click(); true`);
                await waitFor(`document.querySelectorAll('${history} tbody tr[data-key]').length === 100`, 'the next 50', 8000);
                assert.ok((await reqs()).some(q => /before=1000000-1/.test(q) === false && /before=\d+-1/.test(q)), 'the cursor of the last row shown: ' + JSON.stringify(await reqs()));
                assert.equal(await ev(`document.querySelector('${history} .session-group-count').textContent`), '100+');
                await ev(`document.querySelector('${history} .qh-more').click(); true`);
                await waitFor(`document.querySelectorAll('${history} tbody tr[data-key]').length === 120 && !document.querySelector('${history} .qh-more')`, 'the last 20 and no button', 8000);
                assert.equal(await ev(`new Set([...document.querySelectorAll('${history} tbody tr[data-key]')].map(r => r.dataset.key)).size`), 120, 'each run once');
                assert.equal(await ev(`document.querySelector('${history} .session-group-count').textContent`), '120');
            });
            await run(at + 'the Resource and Agent filters ask the server and start the list again', async () => {
                const opts = await ev(`[...document.querySelectorAll('${history} .qh-filter')].map(s => [...s.options].map(o => o.textContent))`);
                assert.deepEqual(opts, [['All resources', 'mac-heavy', 'mini'], ['All agents', 'Frontend Dev', 'QA Engineer', 'Backend Dev']], 'the names the record has');
                await ev(`window.__runReqs.length = 0; { const s = document.querySelectorAll('${history} .qh-filter')[0]; s.value = 'mini'; s.dispatchEvent(new Event('change', { bubbles: true })); } true`);
                await waitFor(`window.__runReqs.some(q => /resource=mini/.test(q))`, 'the resource in the request', 8000);
                await waitFor(`document.querySelectorAll('${history} tbody tr[data-key]').length === 50 && ![...document.querySelectorAll('${history} tbody tr[data-key]')].some(r => /mac-heavy/.test(r.textContent))`, 'only mini', 8000);
                await ev(`window.__runReqs.length = 0; { const s = document.querySelectorAll('${history} .qh-filter')[1]; s.value = 'QA Engineer'; s.dispatchEvent(new Event('change', { bubbles: true })); } true`);
                await waitFor(`window.__runReqs.some(q => /resource=mini/.test(q) && /agent=QA/.test(q))`, 'both filters in the request', 8000);
                await waitFor(`(() => { const r = [...document.querySelectorAll('${history} tbody tr[data-key]')]; return r.length > 0 && r.every(x => /QA Engineer/.test(x.textContent) && /mini/.test(x.textContent)); })()`, 'only QA on mini', 8000);
                for (const i of [0, 1]) await ev(`{ const s = document.querySelectorAll('${history} .qh-filter')[${i}]; s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); } true`);
                await waitFor(`document.querySelectorAll('${history} tbody tr[data-key]').length === 50`, 'back to all', 8000);
            });
            await run(at + 'the folder\'s search box searches the history on the server: a run beyond the first page is found, a miss says so', async () => {
                await ev(`window.__runReqs.length = 0; true`);
                await ev(`(() => { const i = document.getElementById('automations-search'); i.value = '#13119'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
                await waitFor(`window.__runReqs.some(q => /q=%2313119/.test(q))`, 'the search in the request', 8000);
                await waitFor(`document.querySelectorAll('${history} tbody tr[data-key]').length === 1 && /13119/.test(document.querySelector('${history}').textContent)`, 'the one run, from the last page of the record: ' + await dbg(), 8000);
                await ev(`(() => { const i = document.getElementById('automations-search'); i.value = 'zzz nothing'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
                await waitFor(`/No run matches the search and filters/.test(document.querySelector('${history}').textContent)`, 'the miss line', 8000);
                await ev(`(() => { const i = document.getElementById('automations-search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
                await waitFor(`document.querySelectorAll('${history} tbody tr[data-key]').length === 50`, 'cleared', 8000);
            });
            await run(at + 'when the live queue changes the first page is read again and a new run joins the top', async () => {
                const before = (await reqs()).length;
                await ev(`window.__all.unshift({ ...window.__all[0], key: '1000001-1', id: 999, agent: 'Brand New Agent', task: 14000, goal_id: 0, goal_title: '' }); window.__live = { resources: [{ name: 'mac-heavy', slots: 1, machine: 'Mac', max_lease_seconds: 3600, holders: [{ id: 700, agent: 'Brand New Agent', enqueued_at: new Date().toISOString(), granted_at: new Date().toISOString(), lease_until: new Date(Date.now() + 600000).toISOString() }], queue: [] }] }; true`);
                await waitFor(`(() => { const r = document.querySelector('${history} tbody tr[data-key]'); return !!r && /Brand New Agent/.test(r.textContent); })()`, 'the new run on top: ' + await dbg(), 15000);
                assert.ok((await reqs()).length > before, 'it asked again');
                await ev(`window.__live = ${JSON.stringify(LIVE)}; window.__all.shift(); true`);
            });
            await run(at + 'no record and a failed read say so in a line, and Retry reads again', async () => {
                await ev(`window.__runs.history = false; true`);
                await ev(`(() => { const s = document.querySelectorAll('${history} .qh-filter')[0]; if (s) { s.value = 'mini'; s.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
                await waitFor(`/record could not be opened on this computer/.test(document.querySelector('${history}').textContent)`, 'no record', 8000);
                assert.equal(await ev(`document.querySelectorAll('${history} .qh-filter').length`), 0, 'no filters without a record');
                await ev(`window.__runs.history = true; window.__runs.status = 500; true`);
                await ev(`(() => { const i = document.getElementById('automations-search'); i.value = 'x'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
                await waitFor(`/could not be read/.test(document.querySelector('${history}').textContent) && !!document.querySelector('${history} .btn')`, 'the failed read and Retry', 8000);
                await ev(`window.__runs.status = 200; (() => { const i = document.getElementById('automations-search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })(); document.querySelector('${history} .btn')?.click(); true`);
                await waitFor(`document.querySelectorAll('${history} tbody tr[data-key]').length >= 50`, 'back after Retry', 10000);
            });
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) process.exitCode = 1; else console.log('PASS queue history: the list, the links, paging, filters, search, live refresh, the off states, a phone');
})().catch(e => { console.error(e); process.exitCode = 1; });
