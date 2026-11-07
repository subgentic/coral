// The file's id and version line through the REAL entry paths (#14178): the Inbox review row opens the viewer with the row's line, and choosing another version replaces it; the Team Artifacts page's details sheet says the line as a
// fact, and its Open shows it in the viewer header. Stubbed lists (the page answers them); the versions come from artifact_versions_stub. The Inbox path at 1280 and 390 px, the Team Artifacts page at 1280.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H1, H2, H3, STUB, FILE, lineOf } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const vis = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && e.getClientRects().length > 0; })()`;
    const head = () => ev(`(document.querySelector('#artifact-viewer .artifact-viewer-versionline') || {}).textContent || ''`);
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });

        // ---- the Inbox review row, at both widths
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w} px, the Inbox row: `;
            const team = 'fvs-' + Date.now().toString(36);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(() => true)`);
            await ev(`(() => { const original = window.fetch;
                const item = { id: '${H3}', name: 'release-plan.md', media_type: 'text/markdown', size: 10500, created_at: new Date(Date.now() - 3600000).toISOString(), source: 'upload', available: true, tags: ['for review'], produced_by: 'Plan Writer', question: 'Ship it?', file_id: '${FILE}', version_line: ${JSON.stringify(lineOf(3))} };
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), method = (opts.method || 'GET').toUpperCase();
                    if (method === 'GET' && u.pathname === '/api/board/${team}/artifacts') return Promise.resolve(new Response(JSON.stringify({ project: '${team}', artifacts: [item], has_more: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                    return original(url, opts); };
                return true; })()`);
            await ev(STUB);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1`, at + 'the one review row', 15000);
            const from = await ev(`(([...document.querySelectorAll('#group-table-view tbody tr')].find(r => r.querySelector('.inbox-review-name')) || {}).textContent || '')`); // the data row, not the agent's group head
            check(from.includes(lineOf(3)), at + `the row says the line: ${JSON.stringify(from)}`);
            await ev(`document.querySelector('#group-table-view .inbox-review-name').click(); true`);
            await waitFor(`!!document.getElementById('artifact-viewer') && !document.getElementById('artifact-viewer').hidden && !!document.querySelector('#artifact-viewer .av-current')`, at + 'the viewer opens with its versions', 10000);
            await waitFor(`document.querySelector('#artifact-viewer .artifact-viewer-versionline')?.textContent === ${JSON.stringify(lineOf(3))}`, at + 'the header says v3', 6000);
            await ev(`document.querySelector('#artifact-viewer .av-current').click(); true`);
            await waitFor(vis('#artifact-viewer .av-list'), at + 'the version list', 3000);
            await ev(`document.querySelector('#artifact-viewer .av-option[data-version="2"]').click(); true`);
            await waitFor(`document.querySelector('#artifact-viewer .artifact-viewer-versionline')?.textContent === ${JSON.stringify(lineOf(2))}`, at + 'choosing v2 replaces the line', 8000);
            check(!(await head()).includes('version 3'), at + 'a v2 is never labelled v3');
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
            await removeBoards(ev, [team]).catch(() => {});
        }

        // ---- the Team Artifacts page (the agent's tab), 1280
        {
            const at = '1280 px, Team Artifacts: ';
            await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`(async () => {
                const { state } = await import(${S} + 'state.js'); const files = await import(${S} + 'changed_files.js');
                state.currentSession = { type: 'live', name: 'test-ui', session_id: 'ui-a', board_project: 'design-team' };
                const { showView } = await import(${S} + 'utils.js'); showView('live-session-view');
                const side = document.getElementById('agentic-state'); side.classList.remove('collapsed'); side.style.width = '680px';
                window.__items = [{ id: '${H3}', name: 'release-plan.md', media_type: 'text/markdown', size: 10500, task_id: 11, task_title: 'Plan', created_at: '2026-10-02T15:00:00Z', uri: 'coral://artifacts/${H3}', available: true, source: 'completion', provenance: 'uploaded', produced_by: 'Plan Writer', session_id: 'w-1', file_id: '${FILE}', version_line: ${JSON.stringify(lineOf(3))} },
                    { id: '${'e'.repeat(64)}', name: 'notes.md', media_type: 'text/markdown', size: 900, task_id: 12, task_title: 'Notes', created_at: '2026-10-02T15:10:00Z', uri: 'coral://artifacts/${'e'.repeat(64)}', available: true, source: 'completion', provenance: 'uploaded', produced_by: 'Plan Writer', session_id: 'w-1' }];
                const real = window.fetch;
                window.fetch = async (url, options) => { const u = String(url);
                    if (u.includes('/api/board/') && u.includes('/artifacts?')) return window.__listFetched = (window.__listFetched || 0) + 1, new Response(JSON.stringify({ session_id: new URL(u, location.origin).searchParams.get('session_id') || undefined, project: decodeURIComponent(u.split('/')[3]), artifacts: window.__items, has_more: false, truncated: false }), { headers: { 'Content-Type': 'application/json' } });
                    return real(url, options); };
                files.initFileSearch(); files.syncFilesViewerSession();
            })()`);
            await ev(STUB);
            await ev(`localStorage.removeItem('coral-agentic-tab-top'); document.getElementById('agentic-tab-artifacts').click(); true`);
            const ROWS = '#agentic-panel-artifacts-view tbody tr';
            try { await waitFor(`document.querySelectorAll('${ROWS}').length === 2`, at + 'both rows', 15000); }
            catch (e) { const d = await ev(`(() => { const p = document.getElementById('agentic-panel-artifacts-view'); const tab = document.getElementById('agentic-tab-artifacts'); return JSON.stringify({ panel: !!p, hidden: p && p.hidden, text: p && p.innerText.slice(0, 300), tabSelected: tab && tab.getAttribute('aria-selected'), rows: document.querySelectorAll('tbody tr').length, view: document.querySelector('.view.active, [data-view][aria-current]')?.id || null, listFetched: window.__listFetched || 0 }); })()`).catch(x => String(x)); throw new Error(e.message + ' | page: ' + d); }
            const rowOf = name => `[...document.querySelectorAll('${ROWS}')].find(r => r.querySelector('.dt-primary').textContent === ${JSON.stringify(name)})`;
            await ev(`(${rowOf('release-plan.md')}).querySelector('.artifact-details').click(); true`);
            await waitFor(`!document.getElementById('agentic-detail-pane').hidden && document.querySelector('#agentic-detail-pane .detail-title').textContent === 'release-plan.md'`, at + 'the sheet opens', 6000);
            const facts = await ev(`[...document.querySelectorAll('#agentic-detail-pane .detail-facts > *')].map(c => c.textContent)`);
            check(facts.some(f => f.includes(lineOf(3))), at + `the sheet says the line as a fact: ${JSON.stringify(facts)}`);
            await ev(`(${rowOf('notes.md')}).querySelector('.artifact-details').click(); true`);
            await waitFor(`document.querySelector('#agentic-detail-pane .detail-title').textContent === 'notes.md'`, at + 'the other sheet', 6000);
            const none = await ev(`[...document.querySelectorAll('#agentic-detail-pane .detail-facts > *')].map(c => c.textContent).join(' | ')`);
            check(!/version \d+ of/.test(none), at + `a row with no id says no line: ${JSON.stringify(none)}`);
            await ev(`(${rowOf('release-plan.md')}).querySelector('.artifact-details').click(); true`);
            await waitFor(`document.querySelector('#agentic-detail-pane .detail-title').textContent === 'release-plan.md'`, at + 'its sheet again', 6000);
            await ev(`[...document.querySelectorAll('#agentic-detail-pane .detail-foot .btn')].find(b => b.textContent === 'Open').click(); true`); // the sheet's own Open: the Team Artifacts path into the viewer
            await waitFor(`!!document.getElementById('artifact-viewer') && !document.getElementById('artifact-viewer').hidden`, at + 'Open shows the viewer', 8000);
            await waitFor(`document.querySelector('#artifact-viewer .artifact-viewer-versionline')?.textContent === ${JSON.stringify(lineOf(3))}`, at + 'the header says the line', 8000);
            await ev(`document.querySelector('#artifact-viewer .av-current').click(); true`);
            await waitFor(vis('#artifact-viewer .av-list'), at + 'the version list', 4000);
            await ev(`document.querySelector('#artifact-viewer .av-option[data-version="1"]').click(); true`);
            await waitFor(`document.querySelector('#artifact-viewer .artifact-viewer-versionline')?.textContent === ${JSON.stringify(lineOf(1))}`, at + 'choosing v1 replaces the line', 8000);
            check(!(await head()).includes('version 3'), at + 'v1 is never labelled v3');
        }
    } finally { try { client.close(); } catch { /* closed */ } }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('file_version_surfaces: ok');
})().catch(e => { console.error(e); process.exit(1); });
