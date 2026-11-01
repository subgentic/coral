// A Needs you row for a file with several versions opens the newest version itself, never the diff between versions (#11628, the operator): the row's name and a click on the row both open "v3 of 3" with the file's own text,
// and a diff only when Compare is pressed. The row's artifact is the newest of a three-version series (the stubbed series of artifact_versions_browser). 1280 and 390. Drives Chrome over CDP through
// agent_view_harness.js against the isolated dev server (the team's artifact list is answered by the page).
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H1, H2, H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'newest-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch;
                const item = { id: '${H3}', name: 'release-plan.md', media_type: 'text/markdown', size: 10500, created_at: new Date(Date.now() - 3600000).toISOString(), source: 'upload', available: true, tags: ['for review'], uploader: 'Plan Writer', question: 'Ship it?' };
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), method = (opts.method || 'GET').toUpperCase();
                    if (method === 'GET' && u.pathname === '/api/board/${team}/artifacts') return Promise.resolve(new Response(JSON.stringify({ project: '${team}', artifacts: [item], has_more: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                    return original(url, opts); };
                return true; })()`);
            await ev(STUB); // the series (v1, v2, v3) and the file's text, for the viewer
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 1`, at + 'the one review row', 15000);
            const state = () => ev(`(() => { const d = document.querySelector('#artifact-viewer'); return { open: !!d && !d.hidden, comparing: !!d && d.classList.contains('av-comparing'), current: ((d && d.querySelector('.av-current')) || {}).textContent || '', heading: !!(d && d.querySelector('.av-heading') && d.querySelector('.av-heading').getClientRects().length), text: (d && d.textContent) || '' }; })()`);
            const opened = async how => {
                await waitFor(`(() => { const d = document.querySelector('#artifact-viewer'); return !!d && !d.hidden && !!d.querySelector('.av-current'); })()`, at + how + ': the viewer opens with its versions bar', 8000);
                await ev(`new Promise(r => setTimeout(r, 700))`); // sleep-ok: the versions bar's own reload settles, and a compare (the old behaviour) starts after it
                const s = await state();
                check(/v3 of 3/.test(s.current), at + how + `: the newest version is open: ${JSON.stringify(s.current)}`);
                check(!s.comparing && !s.heading, at + how + ': no diff between versions is shown');
                check(s.text.includes('Revoke moves into a More menu'), at + how + ': the file\'s own text (v3) is shown');
                await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
                await waitFor(`document.querySelector('#artifact-viewer').hidden`, at + how + ': closed', 4000);
            };
            await ev(`document.querySelector('${T} .inbox-review-name').click(); true`);
            await opened('the name');
            await ev(`document.querySelector('${T} tbody tr td:nth-child(2)').click(); true`); // a click on the row (not a button) opens it too
            await opened('a click on the row');
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_row_newest_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
