// The artifact preview's toolbar keeps its Comments toggle (and tag editor) when it is drawn again (#10145; a regression of #9941: the kind of the artifact becoming known redrew the toolbar and dropped what _render had appended after
// the first draw, so a phone could not open the comments sheet). Opened from a live agent's page the way the chat opens one, 390 and 1280 px; the artifact and its comments are the stub of the comments suites.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { STUB, HEX } = require('./helpers/comments_scale');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 800, false]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`window.__m.add('tb-agent', 'T', 3, { sleeping: false }); window.selectLiveSession('tb-agent', 'claude', 'tb-agent-id', 'local'); true`); await sleep(800); // sleep-ok: the selection settles
            await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => { m.state.selectedTeam = 'tb-team'; return true; })`);
            await ev(STUB({ filename: 'release-notes.md', content: '# Release notes\n\nThe build is green.\n', mediaType: 'text/markdown', comments: [{ id: 1, parent_id: null, anchor: { whole: true }, body: 'Please check.', author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: '2026-10-22T00:00:00Z' }] }));
            await ev(`window.openFilePreview('coral://artifacts/${HEX}'); true`); // the entry point a person's click reaches
            await waitFor(`/Release notes/.test((document.getElementById('preview-body') || {}).textContent || '')`, 'the artifact drawn', 10000);
            await sleep(600); // sleep-ok: the kind becomes known after the file is read; the toolbar is drawn again then
            const bar = await ev(`(() => { const b = document.getElementById('preview-toolbar'), t = b && b.querySelector('.ac-toggle'), dl = b && b.querySelector('[data-artifact-download]'); return { toggle: !!t && !t.hidden && t.getBoundingClientRect().height > 0, h: t ? Math.round(t.getBoundingClientRect().height) : 0, download: !!dl, one: b ? b.querySelectorAll('.ac-toggle').length : 0 }; })()`);
            check(`${tag}: after the artifact's kind is known the toolbar still has the Comments toggle and the Download`, bar.toggle && bar.download && bar.one === 1, JSON.stringify(bar));
            if (mobile) { // the sheet: a phone's way to the comments is this toggle
                await ev(`document.querySelector('#preview-toolbar .ac-toggle').click(); true`);
                await waitFor(`document.querySelector('#preview-toolbar .ac-toggle').getAttribute('aria-expanded') === 'true'`, 'the comments open', 6000);
                check(`${tag}: and it opens the comments`, await ev(`/Please check/.test(document.querySelector('.ac-panel').textContent)`));
            }
        }
    } finally { await client.close(); }
    if (results.some(x => !x)) { console.error(`${results.filter(x => !x).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} toolbar checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
