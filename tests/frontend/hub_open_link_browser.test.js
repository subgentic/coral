// The Hub-served agent page opens the artifact its address names (coral-hub #262502): /agents/@<server>/<session>?open=coral://artifacts/<hex> on a cold load puts that artifact in the viewer, as
// the local page does (#15253). Stubbed two-computer Hub (helpers/hub_world.js) with the artifact stub of the comments suites, 1280 and 390 px.
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { STUB, HEX } = require('./helpers/comments_scale');
const { coralReady } = require('./helpers/wait');

const URI = `coral://artifacts/${HEX}`;
const SID = '00000000-0000-4000-8000-000000262502'; // a session id is a UUID: the address refuses any other
const FIXTURE = { filename: 'release-notes.md', content: '# Release notes\n\nThe build is green.\n', mediaType: 'text/markdown', comments: [] };

(async () => {
    const { client, Page, Emulation, ev } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await setupHubWorld({ client, Page, Emulation, width: w, height: h, mobile });
            // the Hub stub's first agent gets a UUID session id (the address refuses the stub's 'hub-agent-0')
            await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const f = window.fetch; window.fetch = async (u, o) => { const r = await f(u, o); if (new URL(String(u), location.href).pathname !== '/api/sessions/live') return r;
                const j = await r.clone().json(); for (const s of j.sessions || []) if (s.session_id === 'hub-agent-0') { s.session_id = '${SID}'; s.name = '${SID}'; } return new Response(JSON.stringify(j), { headers: { 'content-type': 'application/json' } }); }; })();` });
            await Page.addScriptToEvaluateOnNewDocument({ source: STUB(FIXTURE) }); // after the Hub's own stub: it answers the artifact's reads and passes the rest on
            await Page.navigate({ url: `${BASE}/agents/@m1/${SID}?open=${encodeURIComponent(URI)}` }); await Page.loadEventFired();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            const seen = await ev(`(async () => { for (let i = 0; i < 80; i++) { const b = document.getElementById('preview-body'); if (b && /Release notes/.test(b.textContent || '')) return 'drawn'; await new Promise(r => setTimeout(r, 100)); } // sleep-ok: polling for the viewer
                return JSON.stringify({ path: location.pathname, search: location.search, sel: !!(window.state && 0), body: (document.getElementById('preview-body') || {}).textContent || null }); })()`);
            check(`${tag}: the Hub's agent address opens the artifact in the viewer`, seen === 'drawn', String(seen).slice(0, 300));
        }
    } catch (e) { console.error(e); results.push(false); }
    client.close();
    process.exit(results.length && results.every(Boolean) ? 0 : 1);
})();
