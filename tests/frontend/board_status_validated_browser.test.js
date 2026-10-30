// #9337: the sidebar's background poll of a board's status sends the last answer's validator and, on a 304, keeps the data it has (no body, no parse); a forced
// refresh (the team view's open, Refresh) always asks for the whole status. Drives Chrome over CDP through agent_view_harness.js with the status stubbed.
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, sleep, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`(() => {
            window.__seen = []; const real = window.fetch;
            window.fetch = (u, o = {}) => {
                const p = new URL(String(u), location.origin).pathname;
                if (!/\\/api\\/board\\/[^/]+\\/status$/.test(p)) return real(u, o);
                const inm = (o.headers && (o.headers['If-None-Match'] || o.headers.get && o.headers.get('If-None-Match'))) || '';
                window.__seen.push(inm);
                if (inm === 'W/"v1"') return Promise.resolve(new Response(null, { status: 304, headers: { ETag: 'W/"v1"' } }));
                return Promise.resolve(new Response(JSON.stringify({ agents: [{ name: 'A', subscriber_id: 'a', session_id: 's1', availability: 'available', available: true }], summary: {}, unassigned_tasks: [] }), { status: 200, headers: { 'content-type': 'application/json', ETag: 'W/"v1"' } }));
            };
            return true; })()`);
        const team = 'valid-team';
        const first = await ev(`(async () => { const m = await import(${S} + 'team_availability.js'); const a = await m.refreshTeamAvailability(${JSON.stringify(team)}); window.__first = a; return !!a && a.agents.length === 1; })()`);
        check('the first background poll gets the whole status, with no validator', first === true && JSON.stringify(await ev(`window.__seen`)) === '[""]', JSON.stringify(await ev(`window.__seen`)));
        await sleep(5300); // sleep-ok: the poll's own minimum interval (5 s) is the thing being waited out
        const second = await ev(`(async () => { const m = await import(${S} + 'team_availability.js'); const b = await m.refreshTeamAvailability(${JSON.stringify(team)}); return b === window.__first; })()`);
        check('the next poll sends the validator and, on a 304, hands back the data it already had', second === true && (await ev(`window.__seen`))[1] === 'W/"v1"', JSON.stringify(await ev(`window.__seen`)));
        const forced = await ev(`(async () => { const m = await import(${S} + 'team_availability.js'); const c = await m.refreshTeamAvailability(${JSON.stringify(team)}, true); return !!c && c !== window.__first && c.agents.length === 1; })()`);
        check('a forced refresh asks for the whole status, with no validator', forced === true && (await ev(`window.__seen`))[2] === '', JSON.stringify(await ev(`window.__seen`)));
    } finally { await client.close(); }
    process.exit(results.every(Boolean) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
