// The Analytics tab Inbox vs chat (#12158, the Operator's approved proposal): the share of what the Operator does that is in the Inbox, and whether it is rising. The read is stubbed with counts (GET
// /api/analytics/inbox-vs-chat). Pinned: the tab is in the sidebar after Operator interaction; four KPIs; the share by day (#12991: a dot a day, a gap for a day with no action, the day's counts on hover and tap, the subtitle says daily) and a bar a day; the kinds and teams tables; the answers with no side said and
// left out; the record's honesty sentence; before the record began a plain sentence and nothing to compare; a refused read says one line; and a phone does not scroll sideways. Isolated dev server.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const TEAM = 'coral-go-team';
const NOTE = 'These counts come from a record that detects edits made outside Coral but cannot prevent them: it is a record for you, not an audit. Edits made outside Coral are shown unless the whole record was rewritten.';
const today = new Date().toISOString().slice(0, 10);
const dayAgo = back => new Date(Date.parse(today + 'T00:00:00Z') - back * 86400000).toISOString().slice(0, 10);
const COUNTS = days => ({ days: Array.from({ length: days }, (_, i) => ({ day: dayAgo(days - 1 - i), inbox: 2 + i, chat: 20 - i, unknown: i % 3 === 0 ? 1 : 0 })), inbox: { approve: 40, comment: 22, answer_prompt: 6 }, chat: { typed: 120, answer_prompt: 31 },
    unknown: { answer_prompt: 5 }, apart: { wake: 4, stop: 1 }, teams: [{ team: TEAM, inbox: 60, chat: 140 }, { team: 'research', inbox: 8, chat: 11 }], phone: { phone: 12, other: 30 }, record_since: dayAgo(days - 1), note: NOTE });

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const run = async (name, fn) => { try { await fn(); results.push(true); console.log('PASS ' + name); } catch (e) { results.push(false); console.log('FAIL ' + name + ': ' + (e && e.message)); process.exitCode = 1; } };
    const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent.replace(/\\s+/g, ' ').trim() || ''`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { window.__reqs = []; window.__ivc = { status: 200, body: { days_asked: 30, generated_at: new Date().toISOString(), counts: ${JSON.stringify(COUNTS(20))} } };
            const R = window.fetch.bind(window);
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), p = url.pathname;
                const ok = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
                if (p === '/api/analytics/inbox-vs-chat') { window.__reqs.push(p + url.search); return window.__ivc.status === 200 ? ok(window.__ivc.body) : ok({ error: 'forbidden' }, window.__ivc.status); }
                if (p === '/api/board/projects') return ok([{ board_id: '${TEAM}', board_label: '${TEAM}' }]);
                return R(u, o); };
            window._coralSetLiveSessions([{ session_id: 'a-1', name: 'a-1', agent_type: 'claude', board_project: '${TEAM}', display_name: 'Backend Dev', working_directory: '/tmp/x' }]); return true; })()`);
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`document.querySelectorAll('#cost-nav-list .row-btn').length >= 5`, 'the list of views', 10000);
        const open = async () => { await ev(`[...document.querySelectorAll('#cost-nav-list .row-btn')].find(b => /Inbox vs chat/.test(b.textContent)).click(); true`); };

        await run('the tab is in the sidebar, after Operator interaction', async () => {
            const names = await ev(`[...document.querySelectorAll('#cost-nav-list .row-btn')].map(b => b.textContent.trim())`);
            assert.ok(names.indexOf('Inbox vs chat') === names.indexOf('Operator interaction') + 1, JSON.stringify(names));
        });
        await open();
        await waitFor(`document.querySelectorAll('#cost-inbox-chat .atab-kpi').length === 4 && !!document.querySelector('#cost-inbox-chat svg path.atab-line')`, 'the tab drawn', 10000);

        await run('four KPIs say the share now, at the start and the two counts', async () => {
            const k = await ev(`[...document.querySelectorAll('#cost-inbox-chat .atab-kpi')].map(x => x.textContent.replace(/\\s+/g, ' ').trim())`);
            assert.match(k[0], /Inbox share, last 7 days/, JSON.stringify(k)); assert.match(k[0], /\d+%/, JSON.stringify(k)); assert.match(k[1], /Inbox share, at the start/, JSON.stringify(k));
            assert.match(k[2], /Actions in the Inbox/, JSON.stringify(k)); assert.match(k[3], /Actions in a chat or terminal/, JSON.stringify(k));
            const now = +/(\d+)%/.exec(k[0])[1], then = +/(\d+)%/.exec(k[1])[1];
            assert.ok(now > then, `the share climbs in the sample: ${now}% against ${then}%`);
            assert.match(await text('#cost-inbox-chat .atab-trend .atab-say'), /of your actions on .* were in the Inbox, against \d+% on .*Higher is more in the Inbox\./);
        });
        await run('a bar a day, the kinds in words, the teams with their share, the unknowns said and left out, the honest sentence', async () => {
            const bars = await ev(`new Set([...document.querySelectorAll('#cost-inbox-chat svg .atab-bar')].map(h => h.getAttribute('x'))).size`);
            assert.equal(bars, 20, 'a bar a day since the record began, saw ' + bars);
            const kinds = await text('#cost-inbox-chat');
            for (const w of ['Typed to an agent', 'Approved', 'Commented on a file or a goal', 'Answered a question, plan or permission']) assert.ok(kinds.includes(w), w);
            assert.match(kinds, /coral-go-team\s*\d+\s*\d+\s*\d+%/, kinds.slice(kinds.indexOf('By team'), kinds.indexOf('By team') + 160));
            assert.match(kinds, /5 answers to a question, plan or permission have no side yet.*left out of the share/);
            assert.match(kinds, /Not in the share, because the Inbox cannot do them: 4 wake, 1 stop\./);
            assert.match(kinds, /This computer 71% · \S+ \(reported by the page\) 29%/);
            assert.ok(kinds.endsWith(NOTE) || kinds.includes(NOTE), 'the record\'s honesty sentence is on the tab');
        });
        await run('the share is a point a day: a gap for a day with no action, the counts on hover and on tap, the subtitle says daily', async () => {
            const gap = dayAgo(3), D = n => dayAgo(n);
            // seeded relative to now (the analytics time-bomb lesson): 6 days, two with no action, the rest with known counts
            const days = [{ day: D(5), inbox: 1, chat: 3 }, { day: D(4), inbox: 6, chat: 2 }, { day: gap, inbox: 0, chat: 0 }, { day: D(2), inbox: 3, chat: 1 }, { day: D(1), inbox: 0, chat: 0 }, { day: D(0), inbox: 9, chat: 1 }];
            const body = JSON.stringify({ days_asked: 30, generated_at: new Date().toISOString(), counts: { ...COUNTS(6), days, record_since: D(5) } });
            await ev(`window.__ivc.body = ${body}; [...document.querySelectorAll('#cost-inbox-chat select')][0].dispatchEvent(new Event('change', { bubbles: true })); true`);
            if (process.env.IVC_SHOTS) { // opt-in evidence: the card in both themes at 1440 and 390 (the before/after for review)
                await waitFor(`!!document.querySelector('#cost-inbox-chat .atab-trend svg path.atab-line')`, 'the line', 10000);
                for (const [w, h, mob] of [[1440, 900, false], [390, 844, true]]) for (const theme of ['light', 'dark']) {
                    await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 2, mobile: mob });
                    await ev(`[...document.querySelectorAll('#cost-inbox-chat select')][0].dispatchEvent(new Event('change', { bubbles: true })); true`);
                    if (mob) await ev(`[...document.querySelectorAll('#cost-nav-list .row-btn')].find(b => /Inbox vs chat/.test(b.textContent))?.click(); true`); // a phone shows the list first
                    await waitFor(`(document.querySelector('#cost-inbox-chat .atab-trend svg path.atab-line')?.getBoundingClientRect().width || 0) > 50`, 'the chart drawn at this width', 10000);
                    await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); document.querySelector('#cost-inbox-chat .atab-trend').closest('.atab-card').scrollIntoView(); true`);
                    await new Promise(r => setTimeout(r, 600)); // sleep-ok: the repaint
                    const clip = await ev(`(() => { const r = document.querySelector('#cost-inbox-chat .atab-trend').closest('.atab-card').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, scale: 1 }; })()`);
                    require('node:fs').writeFileSync(`${process.env.IVC_SHOTS}-${w}-${theme}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png', clip })).data, 'base64'));
                }
                await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
            }
            await waitFor(`document.querySelectorAll('#cost-inbox-chat .atab-trend svg .atab-dot').length === 4`, 'a dot for each of the 4 days with actions', 10000);
            assert.match(await text('#cost-inbox-chat .atab-card:has(.atab-trend) h3'), /Inbox share.*each day/, 'the subtitle says daily');
            assert.ok(!/7-day share/.test(await text('#cost-inbox-chat .atab-card:has(.atab-trend) h3')), 'no 7-day claim on the chart');
            assert.equal(await ev(`document.querySelectorAll('#cost-inbox-chat .atab-trend svg path.atab-line')[0].getAttribute('d').split('M').length - 1`), 3, 'the gap days break the line into three pieces');
            const titles = await ev(`[...document.querySelectorAll('#cost-inbox-chat .atab-trend svg .atab-hit title')].map(t => t.textContent)`);
            assert.equal(titles.length, 6, 'a hover text for each day');
            assert.match(titles[0], /25% in the Inbox \(1 of 4 actions\)/); assert.match(titles[2], /: no actions$/); assert.match(titles[5], /90% in the Inbox \(9 of 10 actions\)/);
            assert.match(await text('#cost-inbox-chat .atab-trend .atab-day-say'), /90% in the Inbox \(9 of 10 actions\)/, 'the latest day is selected at first');
            await ev(`document.querySelectorAll('#cost-inbox-chat .atab-trend svg .atab-hit')[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); true`);
            await waitFor(`/75% in the Inbox \\(6 of 8 actions\\)/.test(document.querySelector('#cost-inbox-chat .atab-trend .atab-day-say').textContent)`, 'a tap selects that day', 5000);
            // the day buttons keep keyboard focus (#13000): the view is redrawn on each press, and focus is restored by the button's name
            const focused = () => ev(`(() => { const a = document.activeElement; return a ? (a.getAttribute('aria-label') || a.tagName) + (a.disabled ? ' (disabled)' : '') : ''; })()`);
            await ev(`document.querySelectorAll('#cost-inbox-chat .atab-trend svg .atab-hit')[5].dispatchEvent(new MouseEvent('click', { bubbles: true })); true`); // the last day: room to step back twice before the first day
            await waitFor(`/90% in the Inbox/.test(document.querySelector('#cost-inbox-chat .atab-trend .atab-day-say').textContent)`, 'the last day selected', 4000);
            const names = await ev(`[...document.querySelectorAll('#cost-inbox-chat .atab-days button')].map(b => b.getAttribute('aria-label'))`);
            assert.deepEqual(names, ['Previous day', 'Next day'], 'the day buttons have names of their own');
            await ev(`document.querySelector('#cost-inbox-chat .atab-days button[aria-label="Previous day"]').focus(); true`);
            for (let i = 0; i < 2; i++) {
                await ev(`document.activeElement.click(); true`); // what Enter or Space on a focused button does
                await waitFor(`document.activeElement && document.activeElement.getAttribute('aria-label') === 'Previous day'`, `focus stays on Previous day after press ${i + 1}`, 4000);
            }
            for (let i = 0; i < 6 && !/disabled/.test(await focused()); i++) await ev(`document.querySelector('#cost-inbox-chat .atab-days button[aria-label="Previous day"]:not(:disabled)')?.click(); true`);
            await waitFor(`!!document.querySelector('#cost-inbox-chat .atab-days') && document.querySelector('#cost-inbox-chat .atab-days').contains(document.activeElement) && !document.activeElement.disabled`, 'at the first day focus moves to the other button, not to the page', 4000);
            await ev(`window.__ivc.body = { days_asked: 30, generated_at: new Date().toISOString(), counts: ${JSON.stringify(COUNTS(20))} }; [...document.querySelectorAll('#cost-inbox-chat select')][0].dispatchEvent(new Event('change', { bubbles: true })); true`);
            await waitFor(`document.querySelectorAll('#cost-inbox-chat .atab-trend svg .atab-dot').length >= 20`, 'back to the 20-day sample', 10000);
        });
        await run('a team chosen asks for that team, and a Hub-refused read says one line', async () => {
            await ev(`window.__reqs.length = 0; true`);
            await ev(`(() => { const s = document.querySelector('#cost-inbox-chat select'); const teamSel = [...document.querySelectorAll('#cost-inbox-chat select')].find(x => [...x.options].some(o => o.value === '${TEAM}')); teamSel.value = '${TEAM}'; teamSel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`window.__reqs.some(r => /team=${TEAM}/.test(r))`, 'the team in the request', 8000);
            await ev(`window.__ivc.status = 403; true`);
            await ev(`[...document.querySelectorAll('#cost-inbox-chat select')][0].dispatchEvent(new Event('change', { bubbles: true })); true`);
            await waitFor(`/for the person at this computer only/.test(document.getElementById('cost-inbox-chat').textContent)`, 'the refusal line', 8000);
            await ev(`window.__ivc.status = 200; true`);
        });
        await run('before the record began there is a plain sentence and nothing to compare', async () => {
            await ev(`window.__ivc.body = { days_asked: 30, generated_at: new Date().toISOString(), counts: ${JSON.stringify({ ...COUNTS(0), record_since: '', days: [], inbox: {}, chat: {}, unknown: {}, teams: [], phone: { phone: 0, other: 0 }, apart: {} })} }; true`);
            await open(); await ev(`[...document.querySelectorAll('#cost-inbox-chat select')][0].dispatchEvent(new Event('change', { bubbles: true })); true`);
            await waitFor(`/Activity record, which begins on the day the first action is recorded/.test(document.getElementById('cost-inbox-chat').textContent)`, 'the pending sentence', 8000);
            assert.equal(await ev(`document.querySelectorAll('#cost-inbox-chat svg path.atab-line').length`), 0, 'no line to draw');
            await ev(`window.__ivc.body = { days_asked: 30, generated_at: new Date().toISOString(), counts: ${JSON.stringify(COUNTS(20))} }; true`);
        });
        await run('a phone does not scroll sideways and its tables are inside their own boxes', async () => {
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
            await ev(`[...document.querySelectorAll('#cost-inbox-chat select')][0].dispatchEvent(new Event('change', { bubbles: true })); true`);
            await waitFor(`document.querySelectorAll('#cost-inbox-chat .atab-kpi').length === 4`, 'the tab on a phone', 10000);
            assert.ok(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), 'no sideways scroll of the page');
        });
    } finally { await client.close(); }
    if (results.some(r => !r)) process.exitCode = 1; else console.log('PASS inbox vs chat: the tab, the share, the tables, the honest sentence, a phone');
})().catch(e => { console.error(e); process.exitCode = 1; });
