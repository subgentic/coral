// Inbox polish (#8681, UI/UX walkthrough #8679): the Filters panel of an Inbox folder does not push the list down (at 1280 two fields a line with each label above its box; at 390 a sheet over the list that shuts on
// Escape, a tap outside and Done, with the focus going in and coming back to the icon, and the page behind not locked); the page does not repeat its folder name at 390 (the title is for screen readers, the count
// is one line, "5 goals"); and the goal's Tasks button at 390 reads as a button (a border, a chevron, the counts beside the label). Real isolated board and goal; drives Chrome over CDP against the dev server.
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const fs = require('node:fs');
const path = require('node:path');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const board = 'inbox-polish-' + Date.now().toString(36);
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'settings')`); };
    const firstRowTop = () => ev(`(() => { const r = [...document.querySelectorAll('#group-table-view button.dt-primary')].find(b => b.getClientRects().length); return r ? Math.round(r.getBoundingClientRect().top + scrollY) : null; })()`);
    const panelOpen = () => ev(`!document.querySelector('.inbox-folder-toolbar .list-bar-menu').hidden`);
    const toggle = () => ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').click(); true`);
    const shot = async (name, theme) => { // the review shots, when a folder is given (CORAL_SCREENSHOT_DIR)
        const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out')); if (!dir) return;
        await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`); await settle(200);
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    };
    const activeId = () => ev(`(() => { const a = document.activeElement; return a ? (a.id || a.className || a.tagName) : ''; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await load('/');
        await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator' });
        const made = await api('POST', `/api/board/${board}/goals`, { subscriber_id: 'orch', title: 'Polish the Inbox', outcome: 'The Inbox reads clean.', done_when: 'The walkthrough has no items.' });
        const goalId = made.body.id || (made.body.goal && made.body.goal.id);
        await api('POST', `/api/board/${board}/tasks`, { created_by: 'orch', assigned_to: 'Operator', title: 'Polish task', body: 'x', priority: 'medium', goal_id: goalId });
        for (const [label, w, h, mobile] of [['1280', 1280, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await load('/inbox/goals');
            await ev(`try { localStorage.removeItem('coral-inbox-goals-filters'); } catch {} true`);
            await waitFor(`document.querySelectorAll('#group-table-view button.dt-primary').length >= 1 && !!document.querySelector('.inbox-folder-toolbar')`, 'the Goals page', 15000); await settle(300);

            // the folder name
            const head = await ev(`(() => { const h = document.querySelector('.group-table-head h2'), l = document.querySelector('.gt-count-line'), c = document.querySelector('.group-table-head .session-group-count');
                const box = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), shown: e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' }; };
                return { h2: h && h.textContent, h2box: box(h), line: l && l.textContent, lineShown: !!l && getComputedStyle(l).display !== 'none', countShown: !!c && getComputedStyle(c).display !== 'none' }; })()`);
            if (mobile) {
                check(`${label}: the page title is only for screen readers (in the page, one pixel)`, head.h2 === 'Goals' && head.h2box.w <= 1 && head.h2box.h <= 1, JSON.stringify(head));
                check(`${label}: the count is one line naming what is counted ("N goals"), the bare number is gone`, /^\d+ goals?$/.test(head.line) && head.lineShown && !head.countShown, JSON.stringify(head));
            } else check(`${label}: the title and its number stay, the count line is not shown`, head.h2 === 'Goals' && head.h2box.w > 20 && head.countShown && !head.lineShown, JSON.stringify(head));

            await shot(`inbox-polish-closed-${label}-dark`, 'dark');
            // the Filters panel
            const top0 = await firstRowTop();
            const lock0 = await ev(`getComputedStyle(document.body).overflow + '|' + getComputedStyle(document.documentElement).overflow`);
            await toggle(); await settle(300);
            check(`${label}: the focus moves into the panel when it opens`, await ev(`!!document.activeElement && !!document.activeElement.closest('.inbox-folder-toolbar .list-bar-menu')`), await activeId());
            const top1 = await firstRowTop();
            const geo = await ev(`(() => { const m = document.querySelector('.inbox-folder-toolbar .list-bar-menu'), r = m.getBoundingClientRect(); const f = [...m.querySelectorAll('.list-bar-field, .list-bar-sort')].filter(e => e.getClientRects().length).map(e => { const b = e.getBoundingClientRect(), l = e.querySelector('.list-bar-field-label'), x = l && l.getBoundingClientRect(), i = e.querySelector('input, select'), y = i && i.getBoundingClientRect(); return { top: Math.round(b.top), left: Math.round(b.left), labelAbove: !!x && !!y && x.bottom <= y.top + 2 }; });
                const sr = document.querySelector('.inbox-folder-toolbar .list-bar-search-row').getBoundingClientRect(); return { belowRow: r.top >= sr.bottom - 1, pos: getComputedStyle(m).position, h: Math.round(r.height), vh: innerHeight, f, over: document.documentElement.scrollWidth - innerWidth, lock: getComputedStyle(document.body).overflow + '|' + getComputedStyle(document.documentElement).overflow, done: !!m.querySelector('.list-bar-done') && getComputedStyle(m.querySelector('.list-bar-done')).display !== 'none' }; })()`);
            await shot(`inbox-polish-filters-${label}-${mobile ? 'dark' : 'light'}`, mobile ? 'dark' : 'light');
            check(`${label}: each field has its label above its box`, geo.f.length >= 4 && geo.f.every(x => x.labelAbove), JSON.stringify(geo.f));
            if (mobile) {
                check(`${label}: the panel is a sheet under the search row and over the list: the first row has not moved, the sheet is at most 60% of the screen and nothing is wider than it`, geo.pos === 'absolute' && geo.belowRow && top1 === top0 && geo.h <= geo.vh * 0.6 + 1 && geo.over <= 0, JSON.stringify({ top0, top1, geo: { belowRow: geo.belowRow, pos: geo.pos, h: geo.h, vh: geo.vh, over: geo.over } }));
                check(`${label}: the sheet has a Done button, the page behind keeps its scroll (opening it changes no overflow)`, geo.done && geo.lock === lock0, JSON.stringify({ done: geo.done, before: lock0, open: geo.lock }));
                await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`); await settle(200);
                check(`${label}: Escape shuts the sheet and the focus is back on the Filters icon`, !(await panelOpen()) && /toggle/.test(await activeId()), await activeId());
                await toggle(); await settle(200);
                await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-done').click(); true`); await settle(200);
                check(`${label}: Done shuts it and the focus is back on the icon`, !(await panelOpen()) && /toggle/.test(await activeId()), await activeId());
                await toggle(); await settle(200);
                await ev(`document.querySelector('.group-table-node, #group-table-view').dispatchEvent(new MouseEvent('click', { bubbles: true })); true`); await settle(200);
                check(`${label}: a tap outside shuts it`, !(await panelOpen()));
            } else {
                check(`${label}: two fields a line, and the panel pushes the list down by at most 150 px (it was 180-250)`, geo.pos !== 'absolute' && new Set(geo.f.map(x => x.top)).size <= 2 && geo.f.some(x => x.left > geo.f[0].left + 100) && top1 - top0 <= 150, JSON.stringify({ push: top1 - top0, h: geo.h, f: geo.f }));
                await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`); await settle(200);
                check(`${label}: Escape shuts it and the focus is back on the icon`, !(await panelOpen()) && /toggle/.test(await activeId()), await activeId());
            }

            // the goal's Tasks button (a phone's way into the list)
            if (mobile) {
                await load(`/inbox/goals/${board}/${goalId}`);
                await waitFor(`!!document.querySelector('#inbox-page .goal-tasks-open')`, 'the goal page', 15000); await settle(300);
                const b = await ev(`(() => { const e = document.querySelector('#inbox-page .goal-tasks-open'), r = e.getBoundingClientRect(), s = getComputedStyle(e), c = e.querySelector('.goal-tasks-chevron').getBoundingClientRect(), n = e.querySelector('.goal-tasks-counts').getBoundingClientRect(), t = e.querySelector('.goal-tasks-label').getBoundingClientRect(); const p = e.parentElement.getBoundingClientRect();
                    return { h: Math.round(r.height), full: Math.abs(r.width - p.width) < 4, border: parseFloat(s.borderTopWidth) >= 1 && s.borderTopStyle !== 'none', chevronRight: c.right > r.right - 24, countsAfterLabel: n.left > t.right, aria: e.getAttribute('aria-label'), text: e.textContent }; })()`);
                await shot('inbox-polish-goal-390-dark', 'dark'); await shot('inbox-polish-goal-390-light', 'light');
                check(`${label}: the Tasks button is a full-width bordered row, 44 px, with the label, the counts at the right and a chevron at the edge`, b.h >= 44 && b.full && b.border && b.chevronRight && b.countsAfterLabel && /^Tasks\d+ open, \d+ done$/.test(b.text), JSON.stringify(b));
                check(`${label}: it keeps its accessible name ("Tasks, N open, M done")`, /^Tasks, \d+ open, \d+ done$/.test(b.aria), b.aria);
            }
        }
    } finally { await removeBoards?.(ev, [board]).catch?.(() => {}); await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Inbox polish checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
