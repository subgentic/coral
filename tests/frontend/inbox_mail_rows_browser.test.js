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
            // the marker's `since` is in the future: every seeded task counts as read, so the plain row is measured
            const readAs = since => ev(`localStorage.setItem('coral.inbox.read.v1', JSON.stringify({ since: ${since}, items: {} })); true`);
            const showTasks = async n => { await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`); await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`); await waitFor(`document.querySelectorAll('${T} tr.dt-mailed').length === 3`, at + n, 10000); };
            await readAs('Date.now() + 1e10');
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tr.dt-mailed').length === 3`, at + 'the three tasks as mail rows', 10000);
            r = await rows();
            for (const x of r) {
                assert.ok(x.h === 56 && !x.ask && !x.dot && x.sameLine && x.leadW >= 44 && x.open, at + 'a task is one 56 px line exactly, no dot ' + JSON.stringify(x));
                assert.ok(x.bold <= 500, at + 'no unread bold where nothing is unread ' + JSON.stringify(x));
            }
            assert.deepEqual(r.map(x => x.snippet), ['Queued', 'In progress', 'In review'], at + 'the state is the first words');
            // a task nobody has opened is as tall as a read one: the dot adds no height (so the list does not jump as rows are opened)
            const readHeights = r.map(x => x.h);
            await readAs('0');
            await showTasks('the three tasks again, unread');
            r = await rows();
            for (const x of r) assert.ok(x.h === 56 && x.dot && x.bold >= 600 && x.sameLine, at + 'an unread task is still one 56 px line, with the dot and the title at 600 ' + JSON.stringify(x));
            assert.deepEqual(r.map(x => x.h), readHeights, at + 'an unread row is exactly as tall as a read one');
            await readAs('Date.now() + 1e10');
            await showTasks('the three tasks read again');
            // at 200% text the title and the first words stack (a line each), neither cut to a few letters, and the time keeps its space (#9646)
            await ev(`document.documentElement.style.fontSize = '200%'; true`);
            await waitFor(`document.querySelector('${T} .dt-mail-line') && getComputedStyle(document.querySelector('${T} .dt-mail-line')).flexDirection === 'column'`, at + 'the line stacks at 200% text', 4000);
            const big = await ev(`(() => [...document.querySelectorAll('${T} tr.dt-mailed')].map(tr => { const t = tr.querySelector('.dt-mail-title').getBoundingClientRect(), n = tr.querySelector('.dt-mail-snippet').getBoundingClientRect(), tm = tr.querySelector('.dt-mail-time').getBoundingClientRect(); return { stacked: n.top >= t.bottom - 1, titleW: Math.round(t.width), snippetW: Math.round(n.width), timeIn: tm.right <= innerWidth - 11 && tm.left >= 0, over: document.documentElement.scrollWidth - innerWidth }; }))()`);
            assert.ok(big.every(x => x.stacked && x.titleW >= 120 && x.snippetW >= 120 && x.timeIn && x.over <= 1), at + 'title and snippet stack and keep room, the time keeps its space ' + JSON.stringify(big));
            await shot(`inbox-mail-tasks-${w}-200`);
            await ev(`document.documentElement.style.fontSize = ''; true`);
            await waitFor(`getComputedStyle(document.querySelector('${T} .dt-mail-line')).flexDirection === 'row'`, at + 'and back to one line at 100%', 4000);
            const edge = await ev(`(() => { const b = document.querySelector('${T} .dt-box').getBoundingClientRect(), tr = document.querySelector('${T} tr.dt-mailed').getBoundingClientRect(), sb = document.querySelector('${T} .dt-sortbar'); return { left: Math.round(b.left), right: Math.round(innerWidth - b.right), tr: [Math.round(tr.left), Math.round(tr.right)], sort: !!sb && getComputedStyle(sb).display !== 'none', border: getComputedStyle(document.querySelector('${T} .dt-box')).borderLeftWidth }; })()`);
            const CLIP = `(() => [...document.querySelectorAll('${T} tr.dt-mailed')].map(tr => { const t = tr.querySelector('.dt-mail-time').getBoundingClientRect(), r = tr.getBoundingClientRect(), w = tr.querySelector('.dt-mail-time').scrollWidth; return { gap: Math.round(innerWidth - t.right), rowRight: Math.round(r.right), clipped: w > Math.ceil(t.width) }; }))()`;
            const clip = await ev(CLIP);
            assert.ok(clip.every(x => x.gap >= 12 && x.rowRight <= w && !x.clipped), at + 'the time keeps the 12 px right padding and is never cut, under the selection tint too ' + JSON.stringify(clip));
            assert.ok(edge.left === 0 && edge.right === 0 && edge.border === '0px' && !edge.sort, at + 'the rows run edge to edge, no card, no Sort row ' + JSON.stringify(edge));
            assert.ok(r.every(x => /^(now|\d+m|\d+:\d\d\s?[AP]M|Yesterday|[A-Z][a-z]{2}( \d+(, \d{4})?)?)$/.test(x.time)), at + 'short times ' + JSON.stringify(r.map(x => x.time)));
            assert.deepEqual(r.map(x => x.title), ['Pick the release date', 'Check <img src=x onerror="window.__pwn=1"> the logo', 'Approve the budget'], at + 'the titles, as text');
            assert.equal(await ev(`window.__pwn`), undefined, at + 'a title is text, never markup');
            // the team after a title two rows share (a Goals or Tasks row has no room for it otherwise); Needs you always names it (#9654)
            const dup = await ev(`(async () => { const DT = await import((window.__coralStatic || '/static/') + 'data_table.js'); const host = document.createElement('div'); host.id = 'zz-dup'; host.style.cssText = 'position:fixed;inset:0;z-index:50;background:var(--bg-primary);overflow:auto'; document.body.append(host);
                const rows = [{ t: 'Ship it', team: 'alpha' }, { t: 'Ship it', team: 'beta' }, { t: 'Only one', team: 'alpha' }];
                host.append(DT.dataTable({ label: 'dup', rows, rowKey: r => r.team + r.t, open: () => {}, columns: [{ key: 'title', label: 'Title', primary: true, cell: r => r.t }], mail: r => ({ lead: { text: r.t }, title: r.t, team: r.team, snippet: 'Queued', time: '1m' }) }).el);
                const out = [...host.querySelectorAll('tr.dt-mailed')].map(tr => [tr.querySelector('.dt-mail-title').textContent, (tr.querySelector('.dt-mail-team') || {}).textContent || '']); host.remove(); return out; })()`);
            assert.deepEqual(dup, [['Ship it', ' - alpha'], ['Ship it', ' - beta'], ['Only one', '']], at + 'two rows with one title say their team after it, a unique one does not ' + JSON.stringify(dup));
            // a narrow Needs you row cuts the agent's name before the team: the computer ends the team, and it is what tells two same-named teams apart; measured on what is drawn, at 100% and 200% text (#9664)
            const FIT = `(async () => { const DT = await import((window.__coralStatic || '/static/') + 'data_table.js'); document.getElementById('zz-fit')?.remove(); const host = document.createElement('div'); host.id = 'zz-fit'; host.style.cssText = 'position:fixed;inset:0;z-index:50;background:var(--bg-primary);overflow:auto'; document.body.append(host);
                const rows = [{ n: 'Orchestrator of the whole release team', team: 'alpha (Berlin office laptop A)' }, { n: 'Orchestrator of the whole release team', team: 'alpha (Berlin office laptop B)' }];
                host.append(DT.dataTable({ label: 'fit', rows, rowKey: r => r.team, open: () => {}, columns: [{ key: 'n', label: 'Agent', primary: true, cell: r => r.n }], mail: r => ({ lead: { text: r.n }, title: r.n, team: r.team, teamAlways: true, ask: 'Wants to run a command', time: '12m', unread: true, mark: 'attention' }) }).el);
                return [...host.querySelectorAll('tr.dt-mailed')].map(tr => { const t = tr.querySelector('.dt-mail-team'), n = tr.querySelector('.dt-mail-title'); const ln = getComputedStyle(tr.querySelector('.dt-mail-line')); return { team: t.textContent, teamCut: t.scrollWidth > t.clientWidth + 1, teamW: Math.round(t.clientWidth), agentW: Math.round(n.clientWidth), dir: ln.flexDirection, wrap: ln.flexWrap }; }); })()`;
            const fit100 = await ev(FIT);
            await shot(`inbox-mail-fit-${w}-100`);
            assert.ok(fit100.every(x => !x.teamCut) && new Set(fit100.map(x => x.team)).size === 2, at + 'the team is whole on a narrow Needs you row, the two teams read differently ' + JSON.stringify(fit100));
            await ev(`document.documentElement.style.fontSize = '200%'; true`);
            const fit200 = await ev(FIT);
            await shot(`inbox-mail-fit-${w}-200`);
            await ev(`document.documentElement.style.fontSize = ''; document.getElementById('zz-fit')?.remove(); true`);
            assert.ok(fit200.every(x => !x.teamCut), at + 'and at 200% text ' + JSON.stringify(fit200));
            assert.ok(fit200.every(x => x.dir === 'row' && x.wrap === 'wrap'), at + 'a line with a team wraps at 200% text (a row with its team on its own line), it does not stack as a column: ' + JSON.stringify(fit200));
            await shot(`inbox-mail-tasks-${w}`);
            // a tap on the avatar selects (no gesture): the row takes the tint, the avatar is a check, the bar says how many; a tap on a row while selecting toggles it; the last one off ends selecting
            const sel = () => ev(`(() => { const trs = [...document.querySelectorAll('${T} tr.dt-mailed')]; const tick = e => e && getComputedStyle(e).display !== 'none'; return { on: trs.map(t => t.classList.contains('dt-selected')), pressed: trs.map(t => t.querySelector('button.dt-mail-lead').getAttribute('aria-checked')), tick: trs.map(t => tick(t.querySelector('.dt-mail-tick'))), bar: (document.querySelector('.team-tb-selection .dt-bar-count') || {}).textContent || '', lead: Math.round(trs[0].querySelector('button.dt-mail-lead').getBoundingClientRect().height), page: getComputedStyle(document.getElementById('inbox-page')).display }; })()`);
            await ev(`document.querySelectorAll('${T} tr.dt-mailed button.dt-mail-lead')[0].click(); true`);
            await waitFor(`document.querySelectorAll('${T} tr.dt-mailed.dt-selected').length === 1`, at + 'the avatar selects a task', 4000);
            let q = await sel();
            const clip2 = await ev(CLIP);
            assert.ok(clip2.every(x => x.gap >= 12 && !x.clipped), at + 'and still, with a row selected ' + JSON.stringify(clip2));
            assert.deepEqual([q.on, q.pressed, q.tick, q.bar], [[true, false, false], ['true', 'false', 'false'], [true, false, false], '1 selected'], at + 'one selected: tint, pressed, a check, the bar ' + JSON.stringify(q));
            assert.ok(q.lead >= 44 && q.page === 'none', at + 'a 44 px select button, and the list is still on screen ' + JSON.stringify(q));
            assert.ok(await ev(`[...document.querySelectorAll('.team-tb-selection .dt-bar .btn, .team-tb-selection .dt-bar-action, .team-tb-selection .dt-bar-clear')].every(b => b.getBoundingClientRect().height >= 44)`), at + 'the selection bar\'s Mark done and Clear are 44 px targets');
            await shot(`inbox-mail-selected-${w}`);
            await ev(`document.querySelectorAll('${T} tr.dt-mailed button.dt-mail-open')[1].click(); true`);
            await waitFor(`document.querySelectorAll('${T} tr.dt-mailed.dt-selected').length === 2`, at + 'a tap on a row while selecting toggles it', 4000);
            await ev(`for (const b of document.querySelectorAll('${T} tr.dt-mailed button.dt-mail-lead')) if (b.getAttribute('aria-checked') === 'true') b.click(); true`);
            await waitFor(`document.querySelectorAll('${T} tr.dt-mailed.dt-selected').length === 0 && !document.querySelector('.team-tb-selection')`, at + 'unselecting the last ends selecting', 4000);
            await ev(`document.querySelector('${T} tr.dt-mailed button.dt-mail-open').click(); true`);
            await waitFor(`document.getElementById('inbox-page').getClientRects().length > 0 && !!document.querySelector('#inbox-page .ibx-reply-input')`, at + 'a tap opens the task', 10000);
            console.log('PASS ' + at + 'mail rows: Needs you and Tasks');
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
