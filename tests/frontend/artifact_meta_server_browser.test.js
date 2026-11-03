// An artifact mentioned in a team's text is looked up on that team's computer (#12581, coral-hub #156077): learnArtifactNames (the names on board links) and artifactLinkPolicy (the Inbox's links) asked a bare
// /api/artifacts/<hex>/meta, which through the Hub is the Hub's own path and 404s, so mentions stayed plain text. They take the text's server and go through serverFetch. The fetch is stubbed and records the
// URLs; the page is the local server's with a remote server named, as the other server-prefix suites do. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const HEX = 'ab'.repeat(32), HEX2 = 'cd'.repeat(32);

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        const r = await ev(`(async () => {
            const sb = await import(${S} + 'server_base.js'), names = await import(${S} + 'artifact_names.js'), inbox = await import(${S} + 'inbox_coral.js'), refs = await import(${S} + 'artifact_refs.js');
            const urls = []; const real = window.fetch.bind(window);
            window.fetch = (u, o) => { const url = String(u); if (/\\/api\\/artifacts\\/[0-9a-f]{64}\\/meta/.test(url)) { urls.push(url); return Promise.resolve(new Response(JSON.stringify({ name: 'plan.md' }), { status: 200, headers: { 'Content-Type': 'application/json' } })); } return real(u, o); };
            names.learnArtifactNames(new Set(['${HEX}']), 'srv1');
            await inbox.artifactLinkPolicy('see coral://artifacts/${HEX2}', 'srv1');
            refs.linkedText('coral://artifacts/${'ef'.repeat(32)}', { server: 'srv1' });
            await new Promise(r => setTimeout(r, 200)); // sleep-ok: the stubbed lookups answer within a tick; they are recorded when asked
            return { urls, want: (hex) => sb.serverUrl('/api/artifacts/' + hex + '/meta', 'srv1') };
        })().then(x => ({ urls: x.urls, wants: ['${HEX}', '${HEX2}', '${'ef'.repeat(32)}'].map(h => x.want(h)) }))`);
        assert.equal(r.urls.length, 3, 'three lookups were made: ' + JSON.stringify(r.urls));
        for (const want of r.wants) assert.ok(r.urls.includes(want), `the lookup goes to the text's server (${want}): ` + JSON.stringify(r.urls));
        assert.ok(r.urls.every(u => u.startsWith('/api/remote/') || !u.startsWith('/api/artifacts/')), 'no lookup is a bare /api/artifacts path: ' + JSON.stringify(r.urls));
    } finally { await client.close(); }
    console.log('PASS artifact mentions are looked up on the text\'s own server');
})().catch(e => { console.error(e); process.exit(1); });
