// Every Inbox folder page's header is ONE row (#8700, the operator's layout): the title with its count at the left, the search in the middle, the quick-filter pills where the width permits, the Filters
// icon at the right, with no row of its own for the title. When the width runs out the pills become a select in the Filters panel first, and the search narrows to its minimum; a phone (390) has the folder
// select above, so its row is the search and the icon and the title is for screen readers. Real isolated board with one goal and one task; the Needs you, Saved and chat folders are empty and keep the same header.
// 1280, 900 and 390. Drives Chrome over CDP against the dev server.
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const fs = require('node:fs');
const path = require('node:path');

const FOLDERS = [['needs', '/inbox/needs', 'Needs you'], ['tasks', '/inbox/tasks', 'Tasks'], ['goals', '/inbox/goals', 'Goals'], ['saved', '/inbox/saved', 'Saved'], ['chats', '/inbox/chats/all', 'All chats']];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const board = 'inbox-header-' + Date.now().toString(36);
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'settings')`); };
    const shot = async (name, theme) => { // the review shots, when a folder is given (CORAL_SCREENSHOT_DIR)
        const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out')); if (!dir) return;
        await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`); await settle(200);
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    };
    const header = () => ev(`(() => { const bar = document.querySelector('#group-table-view .inbox-folder-toolbar'); if (!bar) return null;
        const row = bar.querySelector('.list-bar-search-row'), mid = e => { if (!e) return null; const r = e.getBoundingClientRect(); return r.width && r.height ? Math.round(r.top + r.height / 2) : null; };
        const head = row.querySelector(':scope > .inbox-folder-head'), h2 = head && head.querySelector('h2'), cnt = head && head.querySelector('.session-group-count'), q = row.querySelector('input[type=search]'), tog = row.querySelector('.list-bar-toggle'), pills = row.querySelector('.team-tb-pills');
        const qb = q && q.getBoundingClientRect();
        return { title: h2 && h2.textContent, id: h2 && h2.id, count: cnt && cnt.textContent, rowH: Math.round(row.getBoundingClientRect().height), titleY: mid(h2), searchY: mid(q), iconY: mid(tog), pillsY: pills && pills.getClientRects().length ? mid(pills.querySelector('button')) : null,
            pillsShown: !!pills && pills.getClientRects().length > 0, headBox: (() => { const r = head.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(), searchW: qb && Math.round(qb.width), oldHead: !!document.querySelector('#group-table-view .group-table-head'), over: document.documentElement.scrollWidth - innerWidth,
            rowSelect: !!row.querySelector(':scope > .team-tb-select') && getComputedStyle(row.querySelector(':scope > .team-tb-select')).display !== 'none', order: [...row.children].filter(e => e.getClientRects().length).map(e => e.className.split(' ')[0]).join('>') }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await load('/');
        await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator' });
        const made = await api('POST', `/api/board/${board}/goals`, { subscriber_id: 'orch', title: 'One row header', outcome: 'The header is one row.', done_when: 'The operator sees one row.' });
        const goalId = made.body.id || (made.body.goal && made.body.goal.id);
        await api('POST', `/api/board/${board}/tasks`, { created_by: 'orch', assigned_to: 'Operator', title: 'Header task', body: 'x', priority: 'medium', goal_id: goalId });
        for (const [label, w, h, mobile] of [['1280', 1280, 900, false], ['900', 900, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            for (const [key, url, title] of FOLDERS) {
                await load(url);
                await waitFor(`!!document.querySelector('#group-table-view .inbox-folder-toolbar .inbox-folder-head h2')`, `the ${title} header`, 15000); await settle(400);
                const g = await header();
                const name = `${label}: ${title}`;
                if (key === 'goals' || key === 'tasks') await shot(`inbox-header-${key}-${label}-${label === '1280' ? 'light' : 'dark'}`, label === '1280' ? 'light' : 'dark');
                check(`${name}: the title is the first thing of the toolbar's row (the page's title id), and there is no row of its own`, g && g.title === title && g.id === 'group-table-title' && !g.oldHead && /^inbox-folder-head/.test(g.order || 'inbox-folder-head') , JSON.stringify(g));
                if (mobile) {
                    check(`${name}: a phone's row is the search and the icon on one line; the title is for screen readers (one pixel)`, g.headBox.w <= 1 && g.headBox.h <= 1 && Math.abs(g.searchY - g.iconY) <= 6 && g.rowH <= 64 && g.over <= 0 && !g.pillsShown && !g.rowSelect, JSON.stringify(g));
                } else {
                    const ys = [g.titleY, g.searchY, g.iconY, g.pillsY].filter(y => y != null);
                    check(`${name}: the title, the search${g.pillsShown ? ', the pills' : ''} and the icon are on one line (same centre) and the row is one line high`, ys.length >= 3 && Math.max(...ys) - Math.min(...ys) <= 6 && g.rowH <= 64 && g.over <= 0, JSON.stringify(g));
                    check(`${name}: the count is beside the title`, g.count !== null && /^\d+$/.test(g.count), JSON.stringify(g.count));
                    check(`${name}: the search keeps at least 10rem`, g.searchW >= 158, String(g.searchW));
                }
                if (mobile && (key === 'goals' || key === 'tasks')) {
                    // 200% text: the search gives way so the Filters icon stays whole inside the screen, at least a 44 px target (#8700, UI/UX's shot of #8662)
                    await ev(`document.documentElement.style.fontSize = '32px'; true`); await settle(400);
                    const z = await ev(`(() => { const row = document.querySelector('#group-table-view .inbox-folder-toolbar .list-bar-search-row'), t = row.querySelector('.list-bar-toggle').getBoundingClientRect(), q = row.querySelector('input[type=search]').getBoundingClientRect(); return { iconRight: Math.round(t.right), iconW: Math.round(t.width), iconH: Math.round(t.height), searchW: Math.round(q.width), vw: innerWidth, over: document.documentElement.scrollWidth - innerWidth }; })()`);
                    if (key === 'goals') await shot('inbox-header-goals-390-200pct-dark', 'dark');
                    check(`${name} at 200% text: the Filters icon is whole inside the screen (44 px or more) and the search shrinks to fit`, z.iconRight <= z.vw && z.iconW >= 44 && z.iconH >= 44 && z.searchW >= 100 && z.over <= 0, JSON.stringify(z));
                    await ev(`document.documentElement.style.fontSize = ''; true`); await settle(300);
                }
                if (key === 'goals' || key === 'tasks') {
                    if (!mobile) {
                        check(`${name}: the quick-filter pills are in the row between the search and the icon, on the same line`, g.pillsShown && g.pillsY != null && !g.rowSelect, JSON.stringify(g));
                        // the width runs out (the toolbar made narrow): the pills are a select in the Filters panel first, the row stays one line, the search keeps its minimum
                        await ev(`document.querySelector('#group-table-view .inbox-folder-toolbar').style.maxWidth = '560px'; true`); await settle(300);
                        const n = await header();
                        const ys = [n.titleY, n.searchY, n.iconY].filter(y => y != null);
                        check(`${name}: with less room the pills leave the row and the row is still one line with the search at its minimum or more`, !n.pillsShown && !n.rowSelect && Math.max(...ys) - Math.min(...ys) <= 6 && n.rowH <= 64 && n.searchW >= 158, JSON.stringify(n));
                        await ev(`document.querySelector('#group-table-view .inbox-folder-toolbar .list-bar-toggle').click(); true`); await settle(300);
                        const f = await ev(`(() => { const f = document.querySelector('#group-table-view .inbox-folder-toolbar .inbox-pill-field'), s = f && f.querySelector('select'); return f && s ? { shown: f.getClientRects().length > 0, options: s.options.length, value: s.value } : null; })()`);
                        check(`${name}: they are a select in the Filters panel, with the same choices`, f && f.shown && f.options >= 4, JSON.stringify(f));
                        if (key === 'goals') await shot(`inbox-header-goals-${label}-narrow-panel`, 'light');
                        await ev(`document.querySelector('#group-table-view .inbox-folder-toolbar .list-bar-toggle').click(); document.querySelector('#group-table-view .inbox-folder-toolbar').style.maxWidth = ''; true`);
                    } else {
                        await ev(`document.querySelector('#group-table-view .inbox-folder-toolbar .list-bar-toggle').click(); true`); await settle(300);
                        const f = await ev(`(() => { const f = document.querySelector('#group-table-view .inbox-folder-toolbar .inbox-pill-field'); return f ? { shown: f.getClientRects().length > 0 } : null; })()`);
                        if (key === 'goals' || key === 'tasks') await shot(`inbox-header-${key}-390-sheet-dark`, 'dark');
                        check(`${name}: the choice is a select in the Filters sheet`, f && f.shown, JSON.stringify(f));
                        await ev(`document.querySelector('#group-table-view .inbox-folder-toolbar .list-bar-toggle').click(); true`);
                    }
                }
            }
        }
    } finally { await removeBoards?.(ev, [board]).catch?.(() => {}); await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Inbox header checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
