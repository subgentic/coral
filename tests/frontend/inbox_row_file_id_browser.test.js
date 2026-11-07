// A Needs you row says the file's version line the server tells ("version N of <name> (file <id>)", #14145) on its visible second line (after the question), from the row's own file_id and version_line, and nothing when the row has no valid file id.
// The team's artifact list is answered by the page (as needs_row_newest_browser does). 1280 and 390 px. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H3 } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

const FILE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const LINE = `version 3 of release-plan.md (file ${FILE})`;
const NASTY = `version 3 of rel\u202eease-plan.md (file ${FILE})`, MARKED = `version 3 of rel<U+202E>ease-plan.md (file ${FILE})`; // the name is an agent's text: the hidden character is written out on the row

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            for (const [label, fields, expectLine] of [['a row with a file id', { file_id: FILE, version_line: LINE }, true], ['a row with a made-up id', { file_id: 'not-an-id', version_line: 'version 9 of x (file not-an-id)' }, false], ['a row with none', {}, false], ['a row whose name hides a reordering character', { file_id: FILE, version_line: NASTY }, 'marked'], ['a row with an id and no sender', { file_id: FILE, version_line: LINE, produced_by: '' }, true]]) {
                const at = `${w} px, ${label}: `;
                const team = 'fileid-' + Date.now().toString(36);
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
                await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
                await ev(`(() => { const original = window.fetch;
                    const item = { id: '${H3}', name: 'release-plan.md', media_type: 'text/markdown', size: 10500, created_at: new Date(Date.now() - 3600000).toISOString(), source: 'upload', available: true, tags: ['for review'], produced_by: 'Plan Writer', question: 'Ship it?', ...${JSON.stringify(fields)} };
                    window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), method = (opts.method || 'GET').toUpperCase();
                        if (method === 'GET' && u.pathname === '/api/board/${team}/artifacts') return Promise.resolve(new Response(JSON.stringify({ project: '${team}', artifacts: [item], has_more: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                        return original(url, opts); };
                    return true; })()`);
                await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
                await waitFor(`document.querySelectorAll('${T} tbody tr').length === 1`, at + 'the one review row', 15000);
                const from = await ev(`(([...document.querySelectorAll('${T} tbody tr')].find(r => r.querySelector('.inbox-review-name')) || {}).textContent || '')`); // the data row, not the agent's group head
                if (expectLine === 'marked') {
                    check(from.includes(MARKED) && !from.includes('\u202e'), at + `the hidden character is written out, never raw: ${JSON.stringify(from)}`);
                } else {
                    check(from.includes(LINE) === expectLine, at + `the version line ${expectLine ? 'is' : 'is not'} on the row: ${JSON.stringify(from)}`);
                }
                await removeBoards(ev, [team]).catch(() => {});
            }
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('inbox_row_file_id_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
