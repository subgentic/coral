// A deep link survives the trip to the sign-in page (#12406, coral-hub's early report: a deep link to an agent's Files tab came back without /files). The app rewrites the address as it starts (an agent it cannot read yet
// shows the Agents list), so the sign-in's return_to is the address the page was opened at while the person has not moved on; once they navigate it is the page they are on. Every request is answered 401 (signed out).
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, PRELOAD } = await connect();
    const { Network } = client;
    const failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const seen = [];
    try {
        await Page.enable(); await Network.enable();
        Network.requestWillBeSent(p => { if (/\/auth\?/.test(p.request.url)) seen.push(decodeURIComponent((/return_to=([^&]*)/.exec(p.request.url) || [])[1] || '')); });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const real = window.fetch; window.fetch = (u, o) => { const s = String(u && u.url ? u.url : u); if (s.startsWith('/api/') && !s.startsWith('/api/auth')) return Promise.resolve(new Response(JSON.stringify({ error: 'dashboard_auth_required', code: 'dashboard_auth_required' }), { status: 401, headers: { 'content-type': 'application/json' } })); return real(u, o); }; })();` });
        for (const path of ['/agents/abcd1234/files', '/agents/abcd1234/board', '/agents/abcd1234', '/inbox/goals', '/analytics']) {
            seen.length = 0;
            await Page.navigate({ url: BASE + path });
            const t0 = Date.now(); while (!seen.length && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 100)); // sleep-ok: a bounded wait for the redirect to the sign-in page
            check(seen[0] === path, `${path}: the sign-in brings the person back to the address they opened: ${JSON.stringify(seen)}`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n' + failures.join('\n')); process.exitCode = 1; } else console.log('PASS a signed-out deep link comes back to the address that was opened');
})().catch(e => { console.error(e); process.exitCode = 1; });
