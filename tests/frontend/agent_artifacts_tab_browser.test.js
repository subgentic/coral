// The agent's Artifacts tab on the team Artifacts pattern (#7622, over #5283): the team page's table (Name, Type, Size, Task, Created) scoped to the agent in the dock's panel, with the team's search, Filters and Sort ('N of M'), kept per agent;
// a row opens its document as a sheet over the panel itself (the chat stays beside it) with the actions pinned under it (Open, Download, Copy link, Keep, Delete as a danger button); Escape and Close give the focus back to the row; a narrow panel folds
// Type, Size and Task under the name; an agent with no team has the table with no search (its route has no query). Desktop and 390 px, both themes; names (the accessibility tree) and 4.5:1 contrast. The board route is stood in for by a page-side stub
// that applies the contract and records every request. Drives Chrome over CDP through the harness.
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { assertPinnedBar } = require('./helpers/pinned_bar');
const { setTheme, installAudit, auditRegion } = require('./helpers/contrast');

const HEX = n => n.toString(16).padStart(2, '0').repeat(32);
const TEAM = 'aa-team-' + Date.now().toString(36);
const DATA = ['alpha.png', 'bravo.pdf', 'charlie.txt', 'delta.zip', 'echo.png', 'zebra-plan.md', 'foxtrot.txt'].map((name, i) => ({ id: HEX(i + 1), name, media_type: ['image/png', 'application/pdf', 'text/plain', 'application/zip', 'image/png', 'text/markdown', 'text/plain'][i], size: (i + 1) * 300,
    task_id: i ? 100 + i : null, task_title: 'Task ' + (i + 1), created_at: new Date(Date.UTC(2026, 9, 10 - i, 10)).toISOString(), uri: 'coral://artifacts/' + HEX(i + 1), available: true, inline: false, reference_count: 1, source: 'task', produced_by: 'Dev One' }));

const STUB = `(() => {
    const R = window.fetch; window.__req = []; window.__data = ${JSON.stringify(DATA)};
    const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o = {}) => {
        const url = new URL(String(u), location.origin); const q = url.searchParams;
        const m = url.pathname.match(/^\\/api\\/board\\/([^/]+)\\/artifacts$/);
        if (m && (o.method || 'GET').toUpperCase() === 'GET') {
            window.__req.push({ kind: 'board', project: decodeURIComponent(m[1]), query: Object.fromEntries(q.entries()) });
            let items = window.__data.slice();
            if (q.get('q')) { const t = q.get('q').toLowerCase(); items = items.filter(i => [i.name, i.task_title, i.produced_by, i.media_type].some(x => (x || '').toLowerCase().includes(t))); }
            if (q.get('kind')) { const k = q.get('kind'); items = items.filter(i => (i.media_type.startsWith('image/') ? 'image' : i.media_type === 'application/pdf' ? 'pdf' : i.media_type.startsWith('text/') ? 'text' : 'other') === k); }
            const sort = q.get('sort') || 'newest';
            items.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'oldest' ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at));
            const total = items.length, offset = Number(q.get('cursor') || q.get('offset') || 0), pageSize = window.__pageSize || items.length;
            const body = { project: decodeURIComponent(m[1]), artifacts: items.slice(offset, offset + pageSize), has_more: offset + pageSize < total, next_cursor: offset + pageSize < total ? String(offset + pageSize) : '', truncated: false };
            if (q.get('session_id')) body.session_id = q.get('session_id');
            if (q.has('sort')) { body.total = items.length; body.all = window.__data.length; }
            return json(body);
        }
        if (url.pathname === '/api/session-artifacts') { window.__req.push({ kind: 'standalone', query: Object.fromEntries(q.entries()) }); return json({ session_id: q.get('session_id'), artifacts: window.__data.slice(0, 3), has_more: false, truncated: false }); }
        if (url.pathname === '/api/system/artifact-store/kept') return json({ kept: [] });
        return R(u, o);
    };
    return true;
})()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input, Accessibility, DOM } = client;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
    const settle = (ms, quietMs = 320) => require('./helpers/wait').settle(ev, ms, quietMs); // the page's geometry still for quietMs, or ms at most (helpers/wait.js); not a fixed sleep
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR || path.join(process.env.RUNNER_TEMP || require('node:os').tmpdir(), 'out', 'shots'); await settle(350); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name.replace(/[^a-z0-9-]+/gi, '-') + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }; // sleep-ok: tab fades
    const press = async (key, code, vk) => { const t = key === 'Enter' ? '\r' : undefined; await Input.dispatchKeyEvent({ type: t ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, text: t }); await Input.dispatchKeyEvent({ type: 'keyUp', key, code, windowsVirtualKeyCode: vk }); await settle(60); };
    const type = async text => { for (const ch of text) { await Input.dispatchKeyEvent({ type: 'keyDown', key: ch, text: ch }); await Input.dispatchKeyEvent({ type: 'keyUp', key: ch }); } };
    const INTERACTIVE = new Set(['button', 'textbox', 'checkbox', 'link', 'combobox', 'searchbox']);
    const axUnnamed = async sel => {
        await DOM.enable(); await Accessibility.enable();
        const { root } = await DOM.getDocument({ depth: 0 }); const { nodeId } = await DOM.querySelector({ nodeId: root.nodeId, selector: sel }); if (!nodeId) return ['missing'];
        const { node } = await DOM.describeNode({ nodeId }); const { nodes } = await Accessibility.getFullAXTree();
        const byId = new Map(nodes.map(n => [n.nodeId, n])); const start = nodes.find(n => n.backendDOMNodeId === node.backendNodeId); if (!start) return ['not in the tree'];
        const out = []; const walk = n => { if (!n.ignored && INTERACTIVE.has(n.role && n.role.value) && !((n.name && n.name.value) || '').trim()) out.push(n.role.value); for (const c of n.childIds || []) { const k = byId.get(c); if (k) walk(k); } }; walk(start); return out;
    };
    const open = async (view) => {
        await Emulation.setDeviceMetricsOverride({ width: view.w, height: view.h, deviceScaleFactor: 1, mobile: view.phone });
        await Emulation.setTouchEmulationEnabled({ enabled: view.phone });
        await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: view.theme }] });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`); await ev(`localStorage.clear(); true`);
        await installAudit(ev); await setTheme(ev, view.theme);
        await ev(STUB);
    };
    const showAgent = async (session, tab) => {
        await ev(`(async () => { const S = (window.__coralStatic || '/static/'); const { state } = await import(S + 'state.js'); const files = await import(S + 'changed_files.js'); const { showView } = await import(S + 'utils.js');
            state.currentSession = Object.assign({ type: 'live', name: 'aa-agent', session_id: 'aa-1' }, ${JSON.stringify(session)}); showView('live-session-view');
            const side = document.getElementById('agentic-state'); side.classList.remove('collapsed'); side.style.width = window.innerWidth <= 767 ? '' : '680px'; files.initFileSearch(); files.syncFilesViewerSession(); return true; })()`);
        // a phone shows the side panel as a drawer the top bar's button opens (once: the button toggles it)
        await ev(`(() => { const side = document.getElementById('agentic-state'); if (window.innerWidth <= 767 && side.getBoundingClientRect().width === 0) (document.getElementById('popout-panel-toggle-btn') || document.getElementById('panel-toggle-btn')).click(); return true; })()`); await settle(500);
        await ev(`localStorage.removeItem('coral-agentic-tab-top'); window.switchAgenticTab('${tab}', 'top'); true`);
    };
    const settled = () => waitFor(`document.querySelectorAll('#agentic-panel-artifacts tbody tr').length > 0 && !document.querySelector('#agentic-panel-artifacts .team-count-line')?.textContent.startsWith('Loading')`, 'the agent\'s artifacts: the table');
    const last = () => ev(`window.__req[window.__req.length - 1]`);
    const panel = '#agentic-panel-artifacts';

    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const view of [{ name: 'desktop', w: 1440, h: 900, phone: false, theme: 'dark' }, { name: 'desktop', w: 1440, h: 900, phone: false, theme: 'light' }, { name: '390px', w: 390, h: 844, phone: true, theme: 'dark' }, { name: '390px', w: 390, h: 844, phone: true, theme: 'light' }]) {
            const tag = `${view.name} ${view.theme}`; console.log(tag);
            await open(view);
            // ═══ an agent on a team: the table, the search bar, scoped to the agent
            await showAgent({ board_project: TEAM }, 'artifacts'); await settled();
            let r = await last();
            check(`${tag}: the agent's list is asked for with its session, the newest first, and the board's route (${JSON.stringify(r.query)})`, r.kind === 'board' && r.query.session_id === 'aa-1' && r.query.sort === 'newest' && r.project === TEAM);
            const head = await ev(`(() => { const p = document.querySelector('${panel}'); const q = s => p.querySelector(s); const vis = e => !!e && e.getClientRects().length > 0; return { search: vis(q('.list-bar-search')), filters: vis(q('.list-bar-toggle')), more: vis(q('.list-bar-more-btn')), refresh: !!q('.team-artifacts-refresh'), rows: p.querySelectorAll('tbody tr').length, heads: [...p.querySelectorAll('thead th')].map(h => h.textContent), count: (q('.list-bar-count') || {}).textContent, countVisible: vis(q('.list-bar-count')) }; })()`);
            check(`${tag}: the tab is a table with the search, the filter icon and the More icon, no Refresh (${JSON.stringify(head)})`, head.search && head.filters && head.more && !head.refresh && head.rows === 7 && !head.countVisible && head.heads[0] === 'Name' && /^7 artifact/.test(head.count || ''));
            await ev(`document.querySelector('${panel} .list-bar-search').focus(); true`); await type('zebra'); await settle(900, 450);
            r = await last();
            check(`${tag}: a search is the server's, scoped to the agent (${JSON.stringify(r.query)}), and the count says N of M`, r.query.q === 'zebra' && r.query.session_id === 'aa-1' && (await ev(`document.querySelector('${panel} .list-bar-count').textContent`)).includes('1 of 7'));
            await ev(`(() => { const s = document.querySelector('${panel} select[aria-label="Sort artifacts"]'); s.value = 'name'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(700);
            check(`${tag}: Sort is sent (${JSON.stringify((await last()).query)})`, (await last()).query.sort === 'name' && (await last()).query.q === 'zebra');
            // the filters are kept per agent: another agent starts clean, the first one finds its search again
            await showAgent({ board_project: TEAM, session_id: 'aa-2', name: 'aa-other' }, 'artifacts'); await settle(900);
            check(`${tag}: another agent's tab starts with no search (${(await last()).query.q})`, !(await last()).query.q && (await last()).query.session_id === 'aa-2');
            await showAgent({ board_project: TEAM, session_id: 'aa-1' }, 'artifacts'); await settle(900);
            check(`${tag}: and the first agent's search is remembered (${(await last()).query.q})`, (await last()).query.q === 'zebra');
            await ev(`(() => { const q = document.querySelector('${panel} .list-bar-search'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await settle(900); await settled();

            // ═══ the tab reads itself again (no Refresh icon, #7686): the module's reload asks again
            const before = await ev('window.__req.length');
            await ev(`import((window.__coralStatic || '/static/') + 'team_artifacts_page.js').then(m => m.loadArtifacts({ keep: true })); true`); await settle(600);
            check(`${tag}: a reload asks again (${before} -> ${await ev('window.__req.length')} requests)`, (await ev('window.__req.length')) > before);

            // A dock artifact opens in preview, leaving the list available for the next click.
            await ev(`document.querySelector('${panel} tbody tr .dt-primary').click(); true`);
            await waitFor(`document.getElementById('preview-pane').getBoundingClientRect().height > 0`, 'the artifact preview opens');
            check(`${tag}: preview leaves the list available`, await ev(`document.getElementById('agentic-detail-pane').hidden && document.querySelector('${panel} tbody tr .dt-primary').getClientRects().length > 0`));
            await shot(`preview-${view.name}-${view.theme}`);
            await ev(`import((window.__coralStatic || '/static/') + 'preview_pane.js').then(m => m.closeAllTabs()); true`);

            // #8793: the dock keeps four columns on one line at every width.
            const cols = await ev(`([...document.querySelector('${panel} tbody tr').cells].map(c=>c.dataset.key))`);
            check(`${tag}: name, size, created and Details columns`, JSON.stringify(cols) === JSON.stringify(['name','size','created','details']), JSON.stringify(cols));
            if (!view.phone) {
                for (const width of [420, 620, 680, 980]) {
                    await ev(`document.getElementById('agentic-state').style.width = '${width}px'; true`);
                    await waitFor(`(() => { const box = document.querySelector('${panel} .dt-box'); return box && Math.abs(document.getElementById('agentic-state').getBoundingClientRect().width - ${width}) < 1 ; })()`, 'the artifact dock reaches its resized width');
                    await settle(300);
                    const layout = await ev(`(() => { const box = document.querySelector('${panel} .dt-box'), missing = box.querySelector('tbody tr [data-key=task]'); const folded = box.classList.contains('dt-folded'); box.classList.remove('dt-folded'); const needsFold = box.querySelector('.dt-table').getBoundingClientRect().width > box.clientWidth + 1; box.classList.toggle('dt-folded', folded); return { folded, needsFold, width: box.clientWidth, missingVisible: !!missing?.getClientRects().length, facts: [...box.querySelectorAll('tbody tr:first-child [data-key=type], tbody tr:first-child [data-key=size]')].every(c => c.classList.contains('dt-tone-tertiary')) }; })()`);
                    check(`${tag}: content fits at ${width}px, with quiet facts and no empty folded task (${JSON.stringify(layout)})`, !layout.folded && !layout.needsFold && layout.facts && !layout.missingVisible);
                    const edges = await ev(`(() => { const panel = document.querySelector('${panel}').getBoundingClientRect(), table = document.querySelector('${panel} .dt-table').getBoundingClientRect(); return { left: table.left - panel.left, right: panel.right - table.right }; })()`);
                    check(`${tag}: ${width}px table fills the dock (${JSON.stringify(edges)})`, Math.abs(edges.left) < 1 && Math.abs(edges.right) < 1);
                    if (width !== 620) await shot(`dock-artifacts-${width}-${view.theme}`);
                }
                await ev(`document.getElementById('agentic-state').style.width = '680px'; true`);
            }
            const un = await axUnnamed(`#agentic-panel-artifacts-view`);
            const au = await auditRegion(ev, [`#agentic-panel-artifacts-view`]);
            check(`${tag}: every control has a name (${JSON.stringify(un)}) and the text has 4.5:1 contrast (${JSON.stringify((au.fails || []).slice(0, 2))})`, un.length === 0 && (au.fails || []).length === 0);
            await shot(`${tag} artifacts`);

            if (!view.phone && view.theme === 'dark') {
                await ev(`window.__originalData = window.__data; window.__data = Array.from({length: 75}, (_, i) => ({...window.__originalData[i % 7], id: String(i + 100).padStart(64, '0'), name: 'Paged artifact ' + i})); window.__pageSize = 50; true`);
                await showAgent({ board_project: TEAM, session_id: 'aa-pages', name: 'paged-agent' }, 'artifacts');
                await waitFor(`document.querySelectorAll('${panel} tbody tr').length === 50`, 'the first artifact page');
                await ev(`document.querySelector('${panel} .dt-foot').scrollIntoView({block:'center'}); true`);
                await waitFor(`document.querySelectorAll('${panel} tbody tr').length === 75`, 'scrolling the shared footer reads the next artifact page');
                check(`${tag}: automatic paging uses the cursor and stops after the last page`, await ev(`window.__req.some(r => r.query?.session_id === 'aa-pages' && r.query.cursor === '50') && !document.querySelector('${panel} .dt-more')`));
                await ev(`window.__data = window.__originalData; delete window.__pageSize; true`);
            }

            // ═══ an agent with no team: the table of the files it uploaded, no search (the standalone route has no query)
            await showAgent({ board_project: null, session_id: 'solo-1', name: 'solo' }, 'artifacts'); await settled();
            r = await last();
            const solo = await ev(`(() => { const p = document.querySelector('${panel}'); const vis = e => !!e && e.getClientRects().length > 0; return { bar: vis(p.querySelector('.list-bar-search')), rows: p.querySelectorAll('tbody tr').length, more: vis(p.querySelector('.list-bar-more-btn')) }; })()`);
            check(`${tag}: an agent with no team: the standalone route, the table and the More icon, no search bar (${JSON.stringify(solo)})`, r.kind === 'standalone' && r.query.session_id === 'solo-1' && !solo.bar && solo.rows === 3 && solo.more);
        }
        const failed = results.filter(x => !x).length;
        console.log(`${results.length - failed} of ${results.length} checks passed`);
        await client.close();
        process.exit(failed ? 1 : 0);
    } catch (e) {
        console.error('FAIL', e && e.stack || e);
        await client.close().catch(() => {});
        process.exit(1);
    }
})();
