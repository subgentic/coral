// #21615: a pi agent's CLI gives Coral no usage, so the header's usage spot said nothing. It now says so in a short plain line; other agents keep the old behaviour
// (hidden with no usage, tokens and cost with some). Drives updateTokenUsage with the usage read stubbed.
'use strict';
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { BASE } = require('./test_base');
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, ev } = await connect();
    try {
        await Page.enable();
        { const loaded = Page.loadEventFired(); await Page.navigate({ url: BASE + '/' }); await loaded; await coralReady(ev); }
        const read = (type, tokens) => ev(`(async () => {
            const S = (window.__coralStatic || '/static/');
            window.__usage = ${JSON.stringify(tokens)};
            if (!window.__wrapped) { window.__wrapped = true; const inner = window.fetch; window.fetch = (u, o) => String(u && u.url || u).includes('/api/token-usage?') ? Promise.resolve(new Response(JSON.stringify({ totals: { total_tokens: window.__usage, cost_usd: window.__usage ? 0.5 : 0 } }), { headers: { 'content-type': 'application/json' } })) : inner(u, o); }
            let el = document.getElementById('session-token-usage');
            if (!el) { el = document.createElement('span'); el.id = 'session-token-usage'; el.style.display = 'none'; document.body.append(el); }
            (await import(S + 'state.js')).state.currentSession = { agent_type: ${JSON.stringify(type)} };
            el.textContent = ''; el.style.display = 'none';
            await (await import(S + 'token_usage_ui.js')).updateTokenUsage('11111111-1111-4111-8111-111111111111');
            await (await import(S + 'import_once.js')).importOnce('./no_usage_line.js'); // the zero-usage words are a lazy module: let its load and the line it draws finish
            await new Promise(r => setTimeout(r, 50)); // sleep-ok: one task turn for the .then that draws the line
            return { text: el.textContent, shown: el.style.display !== 'none' };
        })()`);
        const pi = await read('pi', 0);
        assert.deepEqual(pi, { text: 'pi reports no usage to Coral', shown: true }, 'a pi agent with no usage says so: ' + JSON.stringify(pi));
        const claude = await read('claude', 0);
        assert.equal(claude.shown, false, 'another agent with no usage still shows nothing: ' + JSON.stringify(claude));
        const piSome = await read('pi', 1234);
        assert.ok(piSome.shown && /1[.,]2k|1,?234/i.test(piSome.text) && !/reports no usage/.test(piSome.text), 'a pi agent that does have usage shows it: ' + JSON.stringify(piSome));
        console.log('PASS the usage spot says pi reports no usage to Coral; other agents are unchanged');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
