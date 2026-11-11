// #15369: the version list says "You" for a version the person made, the same way whether it came from the server's series (role operator, or source edit: an edit in the dashboard) or from the
// Needs you row's own older uploads (the fallback list used to test the role only, so an edit by the person read as an agent's). Drawn from the page's own module; the series read finds no file, so the fallback runs.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const h = c => c.repeat(64);
        const rows = await ev(`import((window.__coralStatic || '/static/') + 'artifact_version_list.js').then(m => m.versionsOf({ hex: '${h('c')}', server: '', board: 'no-such-team-15369',
            earlier: [{ hex: '${h('a')}', created_at: '2026-11-01T10:00:00Z', produced_by: 'Docs Writer' }, { hex: '${h('b')}', created_at: '2026-11-01T11:00:00Z', source: 'edit' }],
            current: { hex: '${h('c')}', created_at: '2026-11-01T12:00:00Z', role: 'operator' } })).then(r => r.map(v => ({ n: v.n, you: v.you })))`);
        assert.deepEqual(rows, [{ n: 1, you: false }, { n: 2, you: true }, { n: 3, you: true }], 'an edit made in the dashboard and an operator upload are the person\'s; an agent\'s is not: ' + JSON.stringify(rows));
        console.log('PASS version list: "You" is the same test for the series and the fallback list');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
