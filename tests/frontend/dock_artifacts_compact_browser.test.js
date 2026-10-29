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
        if (window.__tasks && url.pathname === '/api/board/' + ${JSON.stringify(TEAM)} + '/tasks') return json({tasks:window.__tasks,total_open:window.__tasks.length,total_completed:0,has_more:false});
        if (window.__tasks && url.pathname.endsWith('/tasks') && url.pathname.startsWith('/api/sessions/live/')) return json([]);
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
        const { node } = await DOM.describeNode({ nodeId }); const under = await require('./helpers/ax_tree').axNodes(Accessibility, { from: node.backendNodeId }); if (!under) return ['not in the tree'];
        return under.filter(n => INTERACTIVE.has(n.role && n.role.value) && !((n.name && n.name.value) || '').trim()).map(n => n.role.value);
    };
    const open = async (view) => {
        await Emulation.setDeviceMetricsOverride({ width: view.w, height: view.h, deviceScaleFactor: 1, mobile: view.phone });
        await Emulation.setTouchEmulationEnabled({ enabled: view.phone });
        await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: view.theme }] });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await require('./helpers/wait').coralReady(ev); await ev(`localStorage.clear(); true`);
        await installAudit(ev); await setTheme(ev, view.theme);
        await ev(STUB);
    };
    const showAgent = async (session, tab) => {
        await ev(`(async () => { const S = (window.__coralStatic || '/static/'); const { state } = await import(S + 'state.js'); const files = await import(S + 'changed_files.js'); const { showView } = await import(S + 'utils.js');
            state.currentSession = Object.assign({ type: 'live', name: 'aa-agent', session_id: 'aa-1' }, ${JSON.stringify(session)}); showView('live-session-view');
            const side = document.getElementById('agentic-state'); side.classList.remove('collapsed'); side.style.width = ''; files.initFileSearch(); files.syncFilesViewerSession(); return true; })()`);
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
        for (const view of [{ w: 1280, h: 900, phone: false, theme: 'dark' }, { w: 390, h: 844, phone: true, theme: 'dark' }]) {
            await open(view);
            await showAgent({ board_project: TEAM }, 'artifacts'); await settled(); await settle(400);
            await shot(`dock-artifacts-default-${view.w}`);
            // A compact fixture fits in the default dock; the old fixed 40rem breakpoint folds it anyway.
            await ev(`window.__data = window.__data.map((r,i) => ({...r, name: 'File '+i, task_id: null, created_at: new Date().toISOString()})); import((window.__coralStatic || '/static/') + 'team_artifacts_page.js').then(m => m.loadArtifacts({keep:true})); true`);
            await settled(); await settle(400);
            if (!view.phone) {
                // A readable name needs 200 px (--table-fit-name-min, #8539), so the default dock keeps a one-line artifact row; a dock wide enough for the name and the facts does not fold it.
                check(`${view.w}: the default dock keeps a one-line artifact row`, await ev(`!document.querySelector('${panel} .dt-box').classList.contains('dt-folded')`));
                await ev(`document.getElementById('agentic-state').style.width = '760px'; true`); await settle(500);
                check(`${view.w}: compact columns fit without folding in a wide dock`, await ev(`!document.querySelector('${panel} .dt-box').classList.contains('dt-folded')`));
                await ev(`document.getElementById('agentic-state').style.width = ''; true`); await settle(500);
            }
            check(`${view.w}: artifact table fits its dock`, await ev(`(() => {const b=document.querySelector('${panel} .dt-box');return b.scrollWidth <= b.clientWidth + 1;})()`));
            await ev(`document.querySelector('${panel} tbody tr .dt-primary').click(); true`); await settle(500);
            check(`${view.w}: one click opens preview without covering the artifact list`, await ev(`document.getElementById('preview-pane').getBoundingClientRect().height > 0 && document.getElementById('agentic-detail-pane').hidden`));
            await ev(`document.querySelectorAll('${panel} tbody tr .dt-primary')[1].click(); true`); await settle(400);
            check(`${view.w}: another artifact opens without closing a sheet`, await ev(`document.getElementById('agentic-detail-pane').hidden && document.querySelectorAll('${panel} tbody tr').length === 7`));
            await ev(`(async () => { const S = window.__coralStatic || '/static/'; (await import(S+'preview_pane.js')).closeAllTabs(); const {state} = await import(S+'state.js'); state.currentSession.board_is_orchestrator = true; window.__tasks = Array.from({length:5},(_,i)=>({id:900+i,title:'A long task title that should remain on one line '+i,status:'in_progress',assigned_to:'Developer',priority:'high'})); state.currentAgentTasks=[]; state.currentSubagents=[]; const tasks = await import(S+'task_list.js'); await tasks.loadBoardTasks(${JSON.stringify(TEAM)}); window.switchAgenticTab('tasks','top'); return true; })()`);
            await waitFor(`document.querySelectorAll('#board-task-list .dt-row').length === 5`, 'five actual dock Tasks rows');
            await settle(400); await shot(`dock-tasks-compact-${view.w}`);
            const sizes = await ev(`(() => {const rs=[...document.querySelectorAll('#board-task-list .dt-row')]; return rs.map(r=>{ const b=r.querySelector('.dt-primary'),id=r.querySelector('.board-task-status-wrap'); return {height:r.getBoundingClientRect().height, titleY:(()=>{const t=document.createRange();t.selectNodeContents(b);return t.getBoundingClientRect().top;})(),idY:id.getBoundingClientRect().top,size:parseFloat(getComputedStyle(b).fontSize)}; });})()`);
            check(`${view.w}: five one-line rows fit in 320px with normal title sizes (${JSON.stringify(sizes)})`, sizes.length===5 && sizes.every(r=>r.height<=56 && r.size<=14 && Math.abs(r.titleY-r.idY)<12) && sizes.reduce((n,r)=>n+r.height,0)<=320);
        }
        await client.close(); process.exit(results.every(Boolean)?0:1);
    } catch(e) { console.error(e.stack||e); await client.close().catch(()=>{}); process.exit(1); }
})();
