// A chat's In / Out / Cache / Requests / Cost line folds behind Details on a phone (#10578, Mobile pass 35): at 390 px the chat's page opens on its title and tabs, with the usage a tap on Details away (it is a line of
// five figures above the tabs, in the way of a phone's first screen); on a desktop the line is there at once, with the cost. The chat and its usage are stubbed. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const ID = '3f2a9c1e-1111-4222-8333-444455556666';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
            const real = window.fetch;
            window.fetch = (input, init = {}) => {
                const url = new URL(String(input && input.url ? input.url : input), location.origin), u = url.pathname;
                const json = o => Promise.resolve(new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } }));
                if (u === '/api/token-usage' && url.searchParams.get('session_id') === '${ID}') return json({ totals: { total_tokens: 125000, input_tokens: 90000, output_tokens: 35000, cache_read_tokens: 4000, cache_write_tokens: 1000, num_sessions: 6, cost_usd: 1.25 } });
                if (new RegExp('^/api/sessions/history/${ID}$').test(u)) return json({ messages: [], total: 0, has_more: false });
                return real(input, init);
            };
            return true; })()` });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile, maxTouchPoints: 5 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.selectHistorySession(${JSON.stringify(ID)}).then(() => true)`);
            await waitFor(`document.getElementById('history-session-view').getClientRects().length > 0 && document.getElementById('htu-cost').textContent !== '—'`, `${w}: the chat and its usage`, 10000);
            const shown = () => ev(`document.getElementById('history-token-usage').getClientRects().length > 0`);
            if (mobile) {
                if (await shown()) problems.push(`${w}: the usage line is folded until Details is pressed`);
                await ev(`document.getElementById('history-session-details').click(); true`);
                if (!(await shown())) problems.push(`${w}: Details shows the usage line`);
                const words = await ev(`document.getElementById('history-token-usage').textContent.replace(/\\s+/g, ' ').trim()`);
                if (!/Cost:\s*\$1\.25/.test(words)) problems.push(`${w}: the cost is in it: ${words}`);
                await ev(`document.getElementById('history-session-details').click(); true`);
                if (await shown()) problems.push(`${w}: Hide details folds it again`);
            } else if (!(await shown())) problems.push(`${w}: the usage line, with the cost, is there at once`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the chat usage line on a phone:\n  ' + problems.join('\n  '));
    console.log('PASS the usage line folds behind Details on a phone and stays on a desktop');
})().catch(e => { console.error(e); process.exit(1); });
