// The open file and thread are in the address (#15253, walks 5-8 "reload loses the open file"): an artifact opened in an agent's viewer puts ?open=coral://artifacts/<hex> in the address, the thread on show
// adds &thread=<id>, closing the viewer takes both away, and a reload (or a copied link) opens the same artifact and the same thread again. A link that names anything else (a script scheme, a second
// scheme, a thread that is not digits) opens nothing. 1280 and 390 px; the artifact and its comments are the stub of the comments suites; the reload re-seeds the same mock agent.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { STUB, HEX } = require('./helpers/comments_scale');
const { coralReady } = require('./helpers/wait');

const AID = '00000000-0000-4000-8000-0000000015a1'; // a session id is a UUID: the address refuses any other
const URI = `coral://artifacts/${HEX}`;
const COMMENTS = [
    { id: 7, parent_id: null, anchor: { whole: true }, body: 'Please check the first line.', author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: '2026-10-22T00:00:00Z' },
    { id: 9, parent_id: null, anchor: { whole: true }, body: 'And the second.', author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: '2026-10-22T00:01:00Z' },
];
const FIXTURE = { filename: 'release-notes.md', content: '# Release notes\n\nThe build is green.\n', mediaType: 'text/markdown', comments: COMMENTS };

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const S = `(window.__coralStatic || '/static/')`;
    const q = () => ev(`(() => { const p = new URLSearchParams(location.search); return { path: location.pathname, open: p.get('open'), thread: p.get('thread') }; })()`);
    const drawn = () => waitFor(`/Release notes/.test((document.getElementById('preview-body') || {}).textContent || '')`, 'the artifact drawn', 10000);
    // The same mock agent on every document: the reload is a new page, and its preload script seeds the agent again before the dashboard starts.
    const seedSource = `window.__qaSeed = [{ name: 'tb-agent', prefix: 'T', n: 3, sleeping: false, session_id: '${AID}' }];`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: seedSource });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`window.__m.seed(); true`); await sleep(600); // sleep-ok: the live list takes the seeded agent
            await ev(`window.selectLiveSession('tb-agent', 'claude', ${JSON.stringify(AID)}, 'local'); true`);
            await waitFor(`location.pathname.startsWith('/agents/')`, 'the agent page', 8000);
            await ev(`import(${S} + 'state.js').then(m => { m.state.selectedTeam = 'tb-team'; return true; })`);
            await ev(STUB(FIXTURE));

            let v = await q();
            check(`${tag}: before anything is opened the address names no file`, v.open === null && v.thread === null, JSON.stringify(v));
            await ev(`window.openFilePreview(${JSON.stringify(URI)}); true`);
            await drawn();
            v = await q();
            check(`${tag}: an artifact in the viewer is the address's open`, v.open === URI && v.thread === null && v.path.startsWith('/agents/'), JSON.stringify(v));

            // the comments panel: a phone opens its sheet by the toggle, a wide pane shows it beside the document
            await waitFor(`!!document.querySelector('#preview-toolbar .ac-toggle')`, 'the comments toggle', 8000);
            if (await ev(`document.querySelector('#preview-toolbar .ac-toggle').getAttribute('aria-expanded') !== 'true'`)) await ev(`document.querySelector('#preview-toolbar .ac-toggle').click(); true`);
            await waitFor(`!!document.querySelector('.ac-card[data-id="9"]')`, 'the threads listed', 8000);
            await ev(`document.querySelector('.ac-card[data-id="9"]').click(); true`);
            await waitFor(`new URLSearchParams(location.search).get('thread') === '9'`, 'the thread in the address', 6000);
            v = await q();
            check(`${tag}: the thread on show is the address's thread`, v.open === URI && v.thread === '9', JSON.stringify(v));

            // an agent sub-tab click rewrites the path (#15542): the viewer is still open, so the file and the thread stay in the address
            for (const tab of ['notes', 'info']) {
                await ev(`document.querySelector('#agentic-tab-${tab}').click(); true`);
                await waitFor(`location.pathname.endsWith('/${tab}')`, 'the sub-tab in the path', 6000);
                await sleep(200); // sleep-ok: the address is put back by the route-changed event, after the path write
                v = await q();
                check(`${tag}: the ${tab} sub-tab keeps open and thread in the address`, v.open === URI && v.thread === '9' && v.path.endsWith('/' + tab), JSON.stringify(v));
            }
            await ev(`document.querySelector('#agentic-tab-notes').click(); true`);
            await waitFor(`location.pathname.endsWith('/notes')`, 'notes again', 6000);

            // a reload (the same address) opens the same artifact and the same thread
            const here = await ev(`location.pathname + location.search`);
            const stubId = (await Page.addScriptToEvaluateOnNewDocument({ source: STUB(FIXTURE) })).identifier; // in place before the dashboard starts: it asks for the artifact at once
            await Page.navigate({ url: BASE + here }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`window.__m.seed(); true`);
            await drawn();
            await waitFor(`!!document.querySelector('.ac-card.ac-active[data-id="9"]')`, 'the thread open again', 10000);
            v = await q();
            check(`${tag}: a reload shows the same artifact with the same thread open, and the address is the same`, v.open === URI && v.thread === '9', JSON.stringify(v));

            // closing the viewer takes the file and the thread out of the address
            await ev(`(() => { const x = document.querySelector('#preview-pane .preview-tab-close'); if (x) x.click(); return !!x; })()`);
            await waitFor(`new URLSearchParams(location.search).get('open') === null`, 'the address cleared', 6000);
            v = await q();
            check(`${tag}: closing the viewer clears open and thread`, v.open === null && v.thread === null && v.path.startsWith('/agents/'), JSON.stringify(v));

            // a link that names something else opens nothing
            for (const bad of ['?open=javascript:alert(1)', '?open=data:text/html,x', '?open=coral://artifacts/zz', `?open=${encodeURIComponent(URI)}&thread=abc`]) {
                await Page.navigate({ url: BASE + '/agents/' + AID + bad }); await Page.loadEventFired(); await install();
                await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
                await ev(`window.__m.seed(); true`);
                await sleep(900); // sleep-ok: a negative: nothing may open, so there is nothing to wait for
                const open = await ev(`!!document.querySelector('#preview-tabs .preview-tab')`);
                const t = await q();
                check(`${tag}: ${bad} opens no tab`, bad.includes('thread=abc') ? t.thread === null : !open, JSON.stringify({ open, ...t }));
            }
        }
    } finally { await client.close(); }
    if (results.some(x => !x)) { console.error(`${results.filter(x => !x).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} address checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
