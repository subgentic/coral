// Needs you says what waits on a row (#11442): an agent waiting on you whose task holds up others says so ("High priority: 3 tasks wait on this"), blockers sort first (the default "Blocking first"), a row with nothing
// waiting on it and a team whose tasks cannot be read look as they did, and "Waiting longest" gives the old order back. The board's tasks are stubbed. 1280 (the table) and 390 (the phone's rows).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

const iso = ms => new Date(Date.now() - ms).toISOString();
const mk = (n, name, team, ageMs) => ({ name: n, session_id: `0000000${n.length}-0000-4000-8000-00000000000${n.length}`, agent_type: 'claude', server: 'local', status: 'idle', display_name: name, working_directory: '/repo/' + n, waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run: go test ./...', waiting_since: iso(ageMs), board_project: team, sleeping: false });
const AGENTS = [mk('a', 'Backend Dev', 'team-a', 600000), mk('bb', 'Frontend Dev', 'team-a', 120000), mk('ccc', 'Docs Writer', 'team-b', 300000)]; // by age: Backend, Docs, Frontend; Frontend holds up three tasks
AGENTS[0].board_job_title = 'Release Manager'; // the board's own name for it differs from the display name: its task is assigned to that name
for (const [i, a] of AGENTS.entries()) a.session_id = `0000000${i + 1}-0000-4000-8000-00000000000${i + 1}`;
const TASKS_A = [
    { id: 20, title: 'Cut the release', status: 'in_progress', priority: 'low', assigned_to: 'Release Manager', blocked_by: [] },
    { id: 21, title: 'Ship\u202e the build\u200b', status: 'pending', priority: 'low', assigned_to: '', blocked_by: [{ task_id: 20, board_id: 'team-a', satisfied: false }] },
    { id: 10, title: 'Frontend work', status: 'in_progress', priority: 'medium', assigned_to: 'Frontend Dev', blocked_by: [] },
    { id: 11, title: 'Tag v2.0.10', status: 'pending', priority: 'high', assigned_to: '', blocked_by: [{ task_id: 10, board_id: 'team-a', satisfied: false }] },
    { id: 12, title: 'Write the notes', status: 'pending', priority: 'medium', assigned_to: '', blocked_by: [{ task_id: 10, board_id: 'team-a', satisfied: false }] },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'blk-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const T = '#group-table-view';
    const rowsOf = () => ev(`[...document.querySelectorAll('${T} tbody tr')].map(tr => ({ text: tr.textContent.replace(/\\s+/g, ' ').trim() }))`);
    const order = rows => AGENTS.map(a => a.display_name).map(n => [n, rows.findIndex(r => r.text.includes(n))]).sort((x, y) => x[1] - y[1]).map(x => x[0]);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(INBOX_WORLD);
            await ev(`(() => { window.__taskCalls = []; const real = window.fetch; window.fetch = (u, o) => { const p = String(u); if (/\\/api\\/board\\/tasks\\?/.test(p)) { window.__taskCalls.push(p); if (/board=team-b/.test(p)) return Promise.resolve(new Response('no', { status: 500 })); return Promise.resolve(new Response(JSON.stringify({ tasks: ${JSON.stringify(TASKS_A)} }), { status: 200, headers: { 'Content-Type': 'application/json' } })); } return real(u, o); }; return true; })()`);
            await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); const m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js'); state.liveSessions = ${JSON.stringify(AGENTS)}; m.updateInboxTab(); return true; })()`);
            await ev(`localStorage.removeItem('coral-inbox-needs-filters'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 3`, at + 'the three waiting agents', 10000);
            await waitFor(`/wait on this|Blocks \\d/.test(document.querySelector('${T}').textContent)`, at + 'the blockers phrase', 10000);
            let rows = await rowsOf();
            check(order(rows)[0] === 'Frontend Dev', at + 'the agent that holds up three tasks is first (Blocking first), though it has waited least: ' + JSON.stringify(order(rows)));
            const fe = rows.find(r => r.text.includes('Frontend Dev'));
            if (!mobile) { check(/Blocks 3 tasks/.test(fe.text), at + 'its row says what waits on it, short in a one-line list: ' + fe.text); check(await ev(`[...document.querySelectorAll('${T} tr')].some(tr => tr.textContent.includes('Blocks 3 tasks') && [...tr.querySelectorAll('[title]')].some(e => /High priority: 3 tasks wait on this/.test(e.title)))`), at + 'and the whole sentence, a high-priority waiter first, is its tooltip'); }
            else {
                check(/Blocks 3 tasks/.test(fe.text), at + 'a phone\'s one-line row says it short: ' + fe.text);
                check(await ev(`[...document.querySelectorAll('${T} tr')].some(tr => tr.textContent.includes('Frontend Dev') && [...tr.querySelectorAll('[title]')].some(e => /High priority: 3 tasks wait on this/.test(e.title)))`), at + 'and the whole sentence is its tooltip');
            }
            const be = rows.find(r => r.text.includes('Backend Dev'));
            check(/Blocks 2 tasks/.test(be.text) && !/[\u202e\u200b]/.test(be.text), at + 'an agent the board calls by another name (its job title) still says what waits on it (its task and the one waiting on it): ' + JSON.stringify(be.text));
            check(!rows.filter(r => r.text.includes('Docs Writer')).some(r => /wait on this|waits on this|Blocks \d|Blocks “/.test(r.text)), at + 'the agent whose team could not be read says nothing');
            check(await ev(`window.__taskCalls.filter(c => /[?&]board=team-/.test(c)).length`) === 2, at + 'one query per team, not per row: ' + await ev(`window.__taskCalls.filter(c => /[?&]board=team-/.test(c)).join(' ')`));
            await shot(`inbox-blockers-${w}`);
            if (!mobile) { // the table fits its box and the agent's name keeps its room (the new column once squeezed it to nothing)
                const box = await ev(`(() => { const b = document.querySelector('${T} .dt-box'), h = [...b.querySelectorAll('thead th')].find(x => /^Agent/.test(x.textContent.trim())); return { box: b.clientWidth, sw: b.scrollWidth, agent: h ? Math.round(h.getBoundingClientRect().width) : null }; })()`);
                check(box.sw <= box.box + 1, at + 'the table fits its box: ' + JSON.stringify(box));
                check(box.agent !== null && box.agent >= 100, at + 'the Agent column keeps its room: ' + JSON.stringify(box));
            }
            // the sort: Blocking first is the default and the first of the choices; Waiting longest gives the old order back
            const sortSel = `[...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.textContent.trim() === 'Waiting longest'))`;
            const sel = await ev(`(() => { const s = ${sortSel}; return s ? { value: s.value, options: [...s.options].map(o => o.textContent.trim()) } : null; })()`);
            check(!!sel && sel.options[0] === 'Blocking first' && sel.value === 'blockers', at + 'Blocking first is the first choice and the one on: ' + JSON.stringify(sel));
            await ev(`(() => { const s = ${sortSel}; s.value = 'oldest'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`(() => { const t = [...document.querySelectorAll('${T} tbody tr')].map(r => r.textContent); return t.length === 3 && t[0].includes('Backend Dev'); })()`, at + 'Waiting longest puts the oldest first', 6000).catch(() => {});
            rows = await rowsOf();
            check(order(rows).join() === 'Backend Dev,Docs Writer,Frontend Dev', at + 'Waiting longest is the old order: ' + JSON.stringify(order(rows)));
            check(!(await ev(`document.documentElement.scrollWidth > innerWidth + 1`)), at + 'no sideways scroll');

            // a "for review" file on a real team: its task holds up two others, and it is the last open task of its goal's second task
            await ev(`localStorage.removeItem('coral-inbox-needs-filters'); true`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Review Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
                const hex = (1).toString(16).padStart(64, '0');
                const item = { id: hex, name: 'checkout-mockup.html', media_type: 'text/html', size: 30, created_at: new Date(Date.now() - 4 * 3600000).toISOString(), task_id: 5, goal_id: 7, goal_title: 'Checkout redesign', source: 'upload', available: true, session_id: 'writer-a', produced_by: 'Frontend Dev', tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex };
                const tasks = [{ id: 5, title: 'Review the mockup', status: 'review_pending', priority: 'medium', goal_id: 7, blocked_by: [] }, { id: 6, title: 'Tag batch-88', status: 'pending', priority: 'high', goal_id: 8, blocked_by: [{ task_id: 5, board_id: '${team}', satisfied: false }] }, { id: 7, title: 'Write the notes', status: 'pending', priority: 'medium', goal_id: 8, blocked_by: [{ task_id: 5, board_id: '${team}', satisfied: false }] }];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                    if (u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: !u.searchParams.has('tag') || u.searchParams.get('tag') === 'for review' ? [item] : [], has_more: false });
                    if (u.pathname === '/api/board/tasks' && u.searchParams.get('board') === '${team}' && u.searchParams.has('status')) return json({ tasks });
                    return original(url, opts); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`[...document.querySelectorAll('${T} tbody tr')].some(r => r.textContent.includes('checkout-mockup.html'))`, at + 'the for-review row', 15000);
            await waitFor(`[...document.querySelectorAll('${T} tbody tr')].some(r => r.textContent.includes('checkout-mockup.html') && /wait on this/.test(r.textContent))`, at + 'the review row says what waits on it', 10000).catch(() => {});
            const rv = (await rowsOf()).find(r => r.text.includes('checkout-mockup.html'));
            check(!!rv && /High priority: 2 tasks wait on this/.test(rv.text), at + 'a for-review file says its task holds up two tasks, a high-priority one: ' + (rv && rv.text));
            check(await ev(`[...document.querySelectorAll('${T} tbody tr')].filter(tr => tr.textContent.includes('checkout-mockup.html')).some(tr => [...tr.querySelectorAll('.inbox-blocks')].some(e => e.getBoundingClientRect().width > 0 && e.offsetParent !== null && /wait/.test(e.textContent)))`), at + 'the phrase is on screen, not only in a hidden cell');
            await shot(`inbox-blockers-review-${w}`);
            check(!(await ev(`document.documentElement.scrollWidth > innerWidth + 1`)), at + 'the review row: no sideways scroll');
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('PASS Needs you says what waits on a row, blockers first, nothing invented');
})().catch(e => { console.error(e); process.exit(1); });
