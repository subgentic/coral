// The phone Inbox's rows read like mail (#9545, UI/UX's spec #9529): a 44 px leading target around a 32 px avatar, the title and the first words of what it says on one line, the time at the right, 56 px a row
// (Needs you, a list of agents: the ask is a second line, 64 px, the title bold, an amber dot). Tasks: a state glyph in a square, the title, the state. No unread marker anywhere else (a read state exists only for Needs you).
// A desktop keeps its table. 390 and 412 px with touch, isolated dev server, the Inbox's census world and two waiting agents.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;

const iso = ms => new Date(Date.now() - ms).toISOString();
const AGENTS = [
    { name: 'ag-one', session_id: '00000001-0000-4000-8000-000000000001', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Agent One', working_directory: '/repo/a', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run: go test ./pkg/... -run TestMailRows with a command long enough to be cut', waiting_since: iso(300000), board_project: 'team-a', sleeping: false },
    { name: 'ag-two', session_id: '00000002-0000-4000-8000-000000000002', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Agent Two', working_directory: '/repo/b', waiting_for_input: true, waiting_kind: 'permission', waiting_since: iso(120000), board_project: 'team-b', sleeping: false },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 400)); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const T = '#group-table-view';
    const rows = () => ev(`(() => [...document.querySelectorAll('${T} tr.dt-mailed')].map(tr => { const r = e => e && e.getBoundingClientRect(), q = s => tr.querySelector(s), box = r(tr);
        return { h: Math.round(box.height), lead: Math.round(r(q('.dt-mail-lead')).height), leadW: Math.round(r(q('.dt-mail-lead')).width), avatar: Math.round(r(q('.dt-mail-avatar')).width), title: q('.dt-mail-title').textContent, snippet: q('.dt-mail-snippet').textContent, ask: q('.dt-mail-ask') && q('.dt-mail-ask').textContent,
            time: q('.dt-mail-time').textContent, bold: getComputedStyle(q('.dt-mail-title')).fontWeight, dot: !!q('.dt-mail-dot'), sameLine: Math.abs(r(q('.dt-mail-title')).top - r(q('.dt-mail-snippet')).top) < 4, timeRight: Math.round(box.right - r(q('.dt-mail-time')).right), open: !!q('button.dt-mail-open') }; }))()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true], [412, 915, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(INBOX_WORLD);
            await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); const m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js'); state.liveSessions = ${JSON.stringify(AGENTS)}; m.updateInboxTab(); return true; })()`);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} .dt-table tbody tr').length === 2 && document.querySelector('${T}').getClientRects().length > 0`, at + 'the two waiting agents', 10000);
            if (!mobile) {
                assert.equal(await ev(`document.querySelectorAll('${T} tr.dt-mailed').length`), 0, at + 'a desktop keeps its table');
                console.log('PASS ' + at + 'no mail rows on a desktop');
                continue;
            }
            let r = await rows();
            await shot(`inbox-mail-needs-${w}`);
            assert.equal(r.length, 2, at + 'two mail rows ' + JSON.stringify(r));
            for (const x of r) {
                assert.ok(x.leadW >= 44 && x.lead >= 44 && x.avatar === 32, at + 'a 44 px target around a 32 px avatar ' + JSON.stringify(x));
                assert.ok(x.open && x.dot && x.bold >= 600, at + 'a button, the amber dot, the title bold ' + JSON.stringify(x));
                assert.ok(x.h >= 64 && x.h <= 72 && x.ask, at + 'Needs you is two lines, 64 px or more ' + JSON.stringify(x));
                assert.ok(x.timeRight <= 16 && /ago|min|\d/.test(x.time), at + 'the time is at the right ' + JSON.stringify(x));
            }
            assert.ok(r.some(x => /^Wants to run: go test/.test(x.ask)) && r.some(x => x.ask && x.title === 'Agent Two'), at + 'the ask is the second line, the state when there is none ' + JSON.stringify(r));
            assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, at + 'no sideways scroll');
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tr.dt-mailed').length === 3`, at + 'the three tasks as mail rows', 10000);
            r = await rows();
            for (const x of r) {
                assert.ok(x.h >= 56 && x.h <= 60 && !x.ask && !x.dot && x.sameLine && x.leadW >= 44 && x.open, at + 'a task is one 56 px line, no dot ' + JSON.stringify(x));
                assert.ok(x.bold <= 500, at + 'no unread bold where nothing is unread ' + JSON.stringify(x));
            }
            assert.deepEqual(r.map(x => x.snippet), ['Queued', 'In progress', 'In review'], at + 'the state is the first words');
            const edge = await ev(`(() => { const b = document.querySelector('${T} .dt-box').getBoundingClientRect(), tr = document.querySelector('${T} tr.dt-mailed').getBoundingClientRect(), sb = document.querySelector('${T} .dt-sortbar'); return { left: Math.round(b.left), right: Math.round(innerWidth - b.right), tr: [Math.round(tr.left), Math.round(tr.right)], sort: !!sb && getComputedStyle(sb).display !== 'none', border: getComputedStyle(document.querySelector('${T} .dt-box')).borderLeftWidth }; })()`);
            assert.ok(edge.left === 0 && edge.right === 0 && edge.border === '0px' && !edge.sort, at + 'the rows run edge to edge, no card, no Sort row ' + JSON.stringify(edge));
            assert.ok(r.every(x => /^(now|\d+m|\d+:\d\d\s?[AP]M|Yesterday|[A-Z][a-z]{2}( \d+(, \d{4})?)?)$/.test(x.time)), at + 'short times ' + JSON.stringify(r.map(x => x.time)));
            assert.deepEqual(r.map(x => x.title), ['Pick the release date', 'Check <img src=x onerror="window.__pwn=1"> the logo', 'Approve the budget'], at + 'the titles, as text');
            assert.equal(await ev(`window.__pwn`), undefined, at + 'a title is text, never markup');
            await shot(`inbox-mail-tasks-${w}`);
            // a tap on the avatar selects (no gesture): the row takes the tint, the avatar is a check, the bar says how many; a tap on a row while selecting toggles it; the last one off ends selecting
            const sel = () => ev(`(() => { const trs = [...document.querySelectorAll('${T} tr.dt-mailed')]; const tick = e => e && getComputedStyle(e).display !== 'none'; return { on: trs.map(t => t.classList.contains('dt-selected')), pressed: trs.map(t => t.querySelector('button.dt-mail-lead').getAttribute('aria-pressed')), tick: trs.map(t => tick(t.querySelector('.dt-mail-tick'))), bar: (document.querySelector('.team-tb-selection .dt-bar-count') || {}).textContent || '', lead: Math.round(trs[0].querySelector('button.dt-mail-lead').getBoundingClientRect().height), page: getComputedStyle(document.getElementById('inbox-page')).display }; })()`);
            await ev(`document.querySelectorAll('${T} tr.dt-mailed button.dt-mail-lead')[0].click(); true`);
            await waitFor(`document.querySelectorAll('${T} tr.dt-mailed.dt-selected').length === 1`, at + 'the avatar selects a task', 4000);
            let q = await sel();
            assert.deepEqual([q.on, q.pressed, q.tick, q.bar], [[true, false, false], ['true', 'false', 'false'], [true, false, false], '1 selected'], at + 'one selected: tint, pressed, a check, the bar ' + JSON.stringify(q));
            assert.ok(q.lead >= 44 && q.page === 'none', at + 'a 44 px select button, and the list is still on screen ' + JSON.stringify(q));
            await shot(`inbox-mail-selected-${w}`);
            await ev(`document.querySelectorAll('${T} tr.dt-mailed button.dt-mail-open')[1].click(); true`);
            await waitFor(`document.querySelectorAll('${T} tr.dt-mailed.dt-selected').length === 2`, at + 'a tap on a row while selecting toggles it', 4000);
            await ev(`for (const b of document.querySelectorAll('${T} tr.dt-mailed button.dt-mail-lead')) if (b.getAttribute('aria-pressed') === 'true') b.click(); true`);
            await waitFor(`document.querySelectorAll('${T} tr.dt-mailed.dt-selected').length === 0 && !document.querySelector('.team-tb-selection')`, at + 'unselecting the last ends selecting', 4000);
            await ev(`document.querySelector('${T} tr.dt-mailed button.dt-mail-open').click(); true`);
            await waitFor(`document.getElementById('inbox-page').getClientRects().length > 0 && !!document.querySelector('#inbox-page .ibx-reply-input')`, at + 'a tap opens the task', 10000);
            console.log('PASS ' + at + 'mail rows: Needs you and Tasks');
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
