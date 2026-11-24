// Needs you's Team filter lists a team once (2.1.12 shoot, #21231): with a second computer the rows name their team with its computer ("alpha · This computer"), and the reviews' own facet is the plain "alpha". The
// filter offered both, and the plain one matched no row, so choosing it hid the permissions and questions. Now the plain name is not a second choice, and a choice with a computer reaches the review query as
// the team's name. Two computers, one waiting agent each; the review facets are stood in at /api/team-artifacts. Isolated dev server, 1280.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady('startup', 'liveList', 'settings');
        await ev(`try { for (const k of Object.keys(localStorage)) if (k.startsWith('coral-inbox-') || k.startsWith('coral-saved-filters')) localStorage.removeItem(k); } catch {} true`);
        await ev(`(async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; st.hub = true; st.servers = [{ id: 'box-2', label: 'Box Two', status: 'online' }];
            window.__teamQueries = []; const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o) => { const url = new URL(String(u && u.url || u), location.href), path = url.pathname.replace(/^\\/api\\/remote\\/box-2/, '');
                if (path === '/api/team-artifacts' && url.searchParams.get('tag') === 'for review') { window.__teamQueries.push(url.searchParams.get('team') || ''); return json({ artifacts: [], limit: 50, offset: 0, has_more: false, truncated: false, total: 0, all: 0, facets: { team: [{ v: 'alpha', n: 1 }], by: [], goal: [] } }); }
                return R(u, o); }; return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`document.querySelectorAll('.view-list-item').length > 3`, 'the folders', 10000);
        await ev(`(async () => { const S = window.__coralStatic || '/static/'; const ago = m => new Date(Date.now() - m * 60000).toISOString();
            window.__m.add('Local Dev', 'A', 4, { sleeping: false, board_project: 'alpha', session_id: 'ld-id' }); window.__m.add('Remote Dev', 'B', 4, { sleeping: false, board_project: 'alpha', session_id: 'rd-id', server: 'box-2' });
            window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, waiting_for_input: true, waiting_kind: 'permission', waiting_since: ago(5) }));
            (await import(S + 'inbox_tab.js')).updateInboxTab(); return true; })()`);
        await ev(`document.querySelector('.view-list-item[data-key="needs"]').click(); true`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 2`, 'two waiting agents', 10000);
        await ev(`(() => { const t = document.querySelector('.inbox-folder-toolbar .list-bar-toggle'); if (t && t.getAttribute('aria-expanded') !== 'true') t.click(); return true; })()`); await settle(300);
        await waitFor(`!!document.getElementById('inbox-needs-team')`, 'the Team filter', 6000);
        const choices = await ev(`[...document.querySelectorAll('#inbox-needs-team option')].map(o => [o.value, o.textContent.trim()]).filter(([v]) => v)`);
        check(!choices.some(([v]) => v === 'alpha') && choices.length === 2 && choices.every(([v]) => / · /.test(v)), 'the team is offered once per computer, never as a plain second choice: ' + JSON.stringify(choices));
        await ev(`(() => { const s = document.getElementById('inbox-needs-team'); s.value = [...s.options].find(o => /This computer/.test(o.value)).value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(600);
        const rows = await ev(`document.querySelectorAll('#group-table-view tbody tr').length`);
        check(rows >= 1, 'choosing the team keeps its waiting agent in the list: ' + rows);
        check((await ev('window.__teamQueries')).every(t => !/ · /.test(t)), 'the review query is asked for the team\'s name, not its label: ' + JSON.stringify(await ev('window.__teamQueries')));
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS Needs you offers a team once and keeps its rows when chosen');
})().catch(e => { console.error(e); process.exit(1); });
