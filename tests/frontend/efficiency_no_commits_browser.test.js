// Analytics > Tokens per commit with no commit in the range (#14095, the Operator: "I'm seeing 0 tokens per commit for the last 24 hours, which seems suspicious"): Coral sees the commits made in a session's own folder
// and in the worktrees it made, not commits made anywhere else, so when sessions used tokens and no commit was recorded the page must say "No commits recorded from these sessions" and what Coral can see, never
// "No commits" as though none were made. With no usage either, the plain words stay. GET /api/analytics/efficiency is stubbed. 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const EMPTY = usage => ({ metric: 'tokens_per_commit', group_by: 'all', range: '24h', min_sample: 10, total: { n: 0, tokens: 0, cost_usd: 0 }, average: { value: null, usual: null }, groups: [], unmeasured: [], usage });

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const run = async (name, fn) => { try { await fn(); results.push(true); console.log('PASS ' + name); } catch (e) { results.push(false); console.log('FAIL ' + name + ': ' + (e && e.message)); process.exitCode = 1; } };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}px: `;
            const visit = async usage => { // a fresh page for each answer: the view reads once when it opens
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
                await ev(`(() => { const R = window.fetch.bind(window);
                    window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                        if (url.pathname === '/api/analytics/efficiency') return Promise.resolve(new Response(JSON.stringify(${JSON.stringify(EMPTY(usage))}), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                        return R(u, o); }; return true; })()`);
                await ev(`window.switchNavTab('tokens'); true`);
                await waitFor(`!!document.querySelector('#cost-nav-list .row-btn[data-view="per-commit"]')`, at + 'the Analytics page', 10000);
                for (let i = 0; i < 24; i++) { await ev(`document.querySelector('#cost-nav-list .row-btn[data-view="per-commit"]')?.click(); true`); if (await ev(`!document.getElementById('cost-spend-section').hidden`)) break; await new Promise(r => setTimeout(r, 250)); /* sleep-ok: the page's actions are registered a moment after the list */ }
                await waitFor(`!!document.querySelector('#cost-spend-section .eff-switch')`, at + 'the group switch', 8000);
                if (mobile) await ev(`(() => { const s = document.querySelector('#cost-spend-section .eff-pick'); s.value = 'provider'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                else await ev(`[...document.querySelectorAll('#cost-spend-section .eff-seg-btn')].find(b => b.textContent === 'Provider').click(); true`); // the grouped views are the ones that read the efficiency route (All is the spend page's own view)
                return () => ev(`document.getElementById('cost-spend-section').textContent.replace(/\\s+/g, ' ')`);
            };
            let text = await visit({ sessions: 14, tokens: 38000000 });
            await run(at + 'sessions used tokens and no commit was recorded: the page says commits were not recorded from these sessions, and what Coral can see', async () => {
                await waitFor(`/No commits recorded from these sessions/.test(document.getElementById('cost-eff-per-commit') ? document.getElementById('cost-eff-per-commit').textContent : '')`, 'the honest line', 10000);
                const t = await text();
                assert.match(t, /No commits recorded from these sessions in the last 24 hours/, t.slice(0, 300));
                assert.match(t, /each session’s own folder and in the worktrees it made/, 'what Coral can see');
                assert.match(t, /not counted/, 'what it cannot');
                assert.ok(!/No commits in the last 24 hours/.test(t), 'never the plain claim that none were made');
                assert.ok(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), 'no sideways scroll');
            });
            text = await visit({ sessions: 0, tokens: 0 });
            await run(at + 'with no usage either the plain words stay', async () => {
                await waitFor(`/No commits in the last 24 hours/.test(document.getElementById('cost-spend-section').textContent)`, 'the plain line', 10000);
                assert.ok(!/recorded from these sessions/.test(await text()));
            });
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) process.exitCode = 1; else console.log('PASS efficiency with no commit: honest words with usage, plain words without');
})().catch(e => { console.error(e); process.exitCode = 1; });
