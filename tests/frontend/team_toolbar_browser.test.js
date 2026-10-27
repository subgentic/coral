// The one toolbar of every list tab of the team page (#7717): Goals, Messages, Tasks, Agents, Artifacts and Knowledge each have ONE row with the search field, the tab's state pills (one compact select when the line is narrow
// or on a phone), the Filters and More icons where the tab has them and the tab's action at the right (New goal, New task, Distill knowledge). Walked at 1280 and 390 px against a real board on the isolated dev server: at 1280 the
// field, the pills, the icons and the action share one line, 32 px high; at 390 the row is two lines at most with 44 px targets; every tab's field starts on the same left edge; nothing scrolls sideways; no count line.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const VIEWS = [['1280x800', 1280, 800, false], ['390x844', 390, 844, true]];
const TEAM = `qa-toolbar-${Date.now() % 100000}`;
// what each tab's row must hold: the pills, the Filters icon, More, and the action's words
const TABS = [['Goals', { pills: true, filters: false, action: 'New goal' }], ['Board', { pills: false, filters: true, more: true }], ['Tasks', { pills: true, filters: true, action: 'New task' }],
    ['Agents', { pills: true, filters: false }], ['Artifacts', { pills: false, filters: true, more: true }], ['Knowledge', { pills: false, filters: false, action: 'Distill knowledge' }]];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const probe = () => ev(`(() => { const p = document.querySelector('[role=tabpanel]:not([hidden])'); const vis = e => !!(e && window.__na.vis(e) && e.getBoundingClientRect().height > 0);
        const row = [...p.querySelectorAll('.list-bar-search-row')].find(vis); if (!row) return null; const pr = p.getBoundingClientRect(); const r = e => e.getBoundingClientRect(); const mid = e => (r(e).top + r(e).bottom) / 2;
        const search = row.querySelector('input.list-bar-search'), pills = row.querySelector('.team-tb-pills'), select = row.querySelector('.team-tb-select'), tog = row.querySelector('.list-bar-toggle'), more = row.querySelector('.list-bar-more-btn'), act = row.querySelector('.team-tb-action');
        const shown = [search, vis(pills) ? pills : null, vis(select) ? select : null, vis(tog) ? tog : null, vis(more) ? more : null, vis(act) ? act : null].filter(Boolean);
        const lines = [...new Set(shown.map(e => Math.round(mid(e) / 10)))].length;
        return { left: Math.round(r(row.querySelector('.list-bar-search-wrap')).left - pr.left), lines, search: vis(search), pills: vis(pills), select: vis(select), filters: vis(tog), more: vis(more), action: act ? act.textContent.trim() : '', actionShown: vis(act),
            hs: shown.map(e => Math.round(r(e).height)), minTarget: Math.min(...[search, tog, more, act, select].filter(vis).map(e => Math.round(r(e).height))), last: !(act && vis(act)) || r(act).right >= Math.max(...shown.map(e => r(e).right)) - 1,
            counts: !!p.querySelector('.team-count-line'), side: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of VIEWS) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM).catch(() => {});
            await S.run(`${label}: every list tab has one toolbar row: field, pills (or the compact select), icons and action`, async () => {
                const edges = [];
                for (const [tab, want] of TABS) {
                    await goTab(ev, settle, tab); await settle(700);
                    await shot(`toolbar-${tab.toLowerCase()}-${label}`);
                    const t = await probe(); assert.ok(t, `${tab} has a toolbar row`);
                    edges.push(t.left);
                    assert.equal(t.search, true, `${tab}: the search field is there`);
                    assert.equal(t.filters, want.filters, `${tab}: the Filters icon ${want.filters ? 'is' : 'is not'} there`);
                    assert.equal(t.more, !!want.more, `${tab}: More ${want.more ? 'is' : 'is not'} there`);
                    assert.equal(t.action, want.action || '', `${tab}: the action`);
                    if (want.pills) assert.ok(mobile ? t.select && !t.pills : t.pills && !t.select, `${tab}: ${mobile ? 'a phone has the compact select' : 'the pills are on the line'} (${JSON.stringify({ pills: t.pills, select: t.select })})`);
                    else assert.ok(!t.pills && !t.select, `${tab}: no pills`);
                    assert.ok(t.last, `${tab}: the action is the last control at the right`);
                    if (tab === 'Goals') { // the tasks that serve no goal are the table's last row, not a line under the toolbar
                        const last = await ev(`(() => { const p = document.querySelector('[role=tabpanel]:not([hidden])'); const rows = [...p.querySelectorAll('tbody tr')]; return { note: !!p.querySelector('p.goals-no-goal'), last: rows.length ? rows[rows.length - 1].textContent.replace(/\\s+/g, ' ').trim() : '' }; })()`);
                        assert.equal(last.note, false, 'no no-goal line under the toolbar'); assert.match(last.last, /^1 task has no goal/, `the last row of the table says it: ${last.last}`);
                    }
                    if (tab !== 'Artifacts') assert.equal(t.counts, false, `${tab}: no count line under the toolbar`); // (Artifacts' one status line also carries its error and its empty sentence: asked about)
                    assert.ok(t.side <= 0, `${tab}: nothing scrolls sideways (${t.side})`);
                    if (mobile) { assert.ok(t.lines <= 2, `${tab}: two lines at most (${t.lines})`); assert.ok(t.minTarget >= 43.5, `${tab}: every control is a 44 px target (${t.minTarget}): ${JSON.stringify(t.hs)}`); }
                    else { assert.equal(t.lines, 1, `${tab}: one line at a desktop width (${t.lines}): ${JSON.stringify(t.hs)}`); assert.ok(t.minTarget >= 31.5 && Math.max(...t.hs) - Math.min(...t.hs) <= 6, `${tab}: 32 px controls, the same height within 6 px: ${JSON.stringify(t.hs)}`); }
                }
                assert.ok(edges.every(e => e === edges[0]), `every tab's field starts on one left edge: ${JSON.stringify(edges)}`);
            });
            await S.run(`${label}: the Goals table's last row opens Tasks with a removable No goal filter, so the tasks shown are exactly those`, async () => {
                await goTab(ev, settle, 'Goals'); await settle(500);
                const clicked = await ev(`(() => { const p = document.querySelector('[role=tabpanel]:not([hidden])'); const rows = [...p.querySelectorAll('tbody tr')]; const b = rows[rows.length - 1].querySelector('.goals-no-goal, button'); if (!b || !/no goal/.test(b.textContent)) return false; b.click(); return true; })()`);
                assert.ok(clicked, 'the last row is the no-goal row');
                await waitFor(`!!document.querySelector('[role=tabpanel]:not([hidden]) .team-tb-chip')`, 'the Tasks tab with its No goal chip', 8000);
                // the chip is there as soon as the filter is set; the table fills when the tasks have been read (a slow runner takes a while: red since run 64, #8473): wait for the rows, then say what they are
                await waitFor(`document.querySelectorAll('[role=tabpanel]:not([hidden]) tbody tr').length >= 1`, 'the tasks the filter leaves', 15000);
                const shown = await ev(`(() => { const p = document.querySelector('[role=tabpanel]:not([hidden])'); return { chip: p.querySelector('.team-tb-chip').textContent, rows: [...p.querySelectorAll('tbody tr')].map(r => r.textContent.replace(/\\s+/g, ' ').trim()) }; })()`);
                assert.match(shown.chip, /^No goal/, 'the chip names the filter'); assert.equal(shown.rows.length, 1, `exactly the one task that serves no goal: ${JSON.stringify(shown.rows)}`); assert.match(shown.rows[0], /Fix the focus ring/);
                await ev(`document.querySelector('[role=tabpanel]:not([hidden]) .team-tb-chip').click(); true`);
                await waitFor(`!document.querySelector('[role=tabpanel]:not([hidden]) .team-tb-chip') && document.querySelectorAll('[role=tabpanel]:not([hidden]) tbody tr').length === 5`, 'the chip removed: every open task again', 6000);
            });
            await S.run(`${label}: the toolbar has a place for a selection bar: it replaces the pills, icons and action, the field stays, and taking it away restores the line`, async () => {
                await goTab(ev, settle, 'Tasks'); await settle(500);
                const state = () => ev(`(() => { const p = document.querySelector('[role=tabpanel]:not([hidden])'), row = p.querySelector('.list-bar-search-row'); const vis = s => { const e = row.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; };
                    return { selecting: row.classList.contains('team-toolbar-selecting'), bar: vis('.team-tb-selection'), field: vis('.list-bar-search'), pills: vis('.team-tb-pills') || vis('.team-tb-select'), action: vis('.team-tb-action'), filters: vis('.list-bar-toggle'), lines: new Set([...row.children].filter(e => getComputedStyle(e).display !== 'none').map(e => Math.round((e.getBoundingClientRect().top + e.getBoundingClientRect().bottom) / 20))).size }; })()`);
                const before = await state();
                await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_toolbar.js'); const n = document.createElement('span'); n.textContent = '2 selected'; m.mountSelection(document.querySelector('[role=tabpanel]:not([hidden]) .list-bar-search-row'), n); return true; })()`);
                const during = await state();
                assert.deepEqual([during.selecting, during.bar, during.field, during.pills, during.action, during.filters], [true, true, true, false, false, false], 'selecting: the bar and the field only: ' + JSON.stringify(during));
                if (!mobile) assert.equal(during.lines, 1, 'one line while selecting');
                await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_toolbar.js'); m.mountSelection(document.querySelector('[role=tabpanel]:not([hidden]) .list-bar-search-row'), null); return true; })()`);
                const after = await state();
                assert.deepEqual(after, before, 'the line is as it was: ' + JSON.stringify({ before, after }));
            });
        }
        console.log('PASS team toolbar');
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
    S.finish(); // finish() exits the process, so the board goes first
})().catch(e => { console.error(e); process.exit(1); });
