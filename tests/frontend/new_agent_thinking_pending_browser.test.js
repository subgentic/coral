// New Agent offers no Thinking level the account's models lack, not even for a moment (#7476, Codex Test's finding in #7468): the first model list is the built-in one (refreshing: true) and carries Minimal;
// the account's own list, which arrives later, does not. Until it does the Thinking control keeps its place, empty, and is then drawn once with the levels that exist. The levels are recorded at every change of the page
// (a MutationObserver sees each state before it can be painted); the second answer is held back by the test.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, N, openNewAgent } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNA(ev);
            await ev(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('coral-models:v1:')) localStorage.removeItem(k);
                window.__asked = 0; window.__release = null; window.__seen = [];
                const R = window.fetch;
                const body = (refreshing, levels, efforts) => new Response(JSON.stringify({ agent_type: 'claude', fetched_at: '2026-10-25T00:00:00Z', refreshing, source: refreshing ? 'builtin' : 'account', models: [{ value: 'claude-big', display_name: 'Big', efforts }], thinking: levels }), { status: 200, headers: { 'content-type': 'application/json' } });
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                    if (url.pathname === '/api/agents/models' && (url.searchParams.get('type') || 'claude') === 'claude') {
                        window.__asked++;
                        if (window.__asked === 1) return Promise.resolve(body(true, ['minimal', 'low', 'medium', 'high'], ['minimal', 'low', 'medium', 'high']));
                        return new Promise(res => { window.__release = () => res(body(false, ['low', 'medium', 'high'], ['low', 'medium', 'high'])); });
                    }
                    return R(u, o); };
                const rec = () => { const g = document.querySelector('.acf-thinking-wrap .seg-group'); window.__seen.push(g ? [...g.querySelectorAll('.seg-btn')].map(b => b.textContent.trim()).join('|') : '-'); };
                new MutationObserver(rec).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
                return true; })()`);
            await openNewAgent(ev, waitFor);
            await ev(`(() => { const i = window.__na.find('input', ${N.folder}); i.value = '/work/payments-app'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            const next = () => ev(`window.__na.find('button', ${N.next}).click(); true`);
            await next(); await waitFor(`/Step 2 of 3/.test(window.__na.dialog().textContent)`, 'step 2', 4000);
            await next(); await waitFor(`/Step 3 of 3/.test(window.__na.dialog().textContent)`, 'step 3', 4000);
            await waitFor(`window.__asked >= 2 && !!window.__release`, 'the second list request, held', 8000);
            const held = await ev(`(() => { const g = document.querySelector('.acf-thinking-wrap .seg-group'); const wrap = document.querySelector('.acf-thinking-wrap'); const r = g.getBoundingClientRect(); return { hidden: wrap.hidden, buttons: g.querySelectorAll('.seg-btn').length, h: Math.round(r.height), w: Math.round(r.width), seen: window.__seen.slice() }; })()`);
            const tag = `${w}px`;
            assert.equal(held.hidden, false, `${tag}: the Thinking control is in place while the list loads`);
            assert.equal(held.buttons, 0, `${tag}: no level is offered while the list is the built-in one`);
            assert.ok(held.h >= 30 && held.w >= 100, `${tag}: the control keeps its space (${held.w}x${held.h})`);
            assert.ok(!held.seen.some(s => /Minimal/.test(s)), `${tag}: Minimal was never drawn: ${JSON.stringify([...new Set(held.seen)])}`);
            await ev(`window.__release(); true`);
            await waitFor(`document.querySelectorAll('.acf-thinking-wrap .seg-group .seg-btn').length === 4`, 'the levels once the list is known', 6000);
            const done = await ev(`(() => ({ names: [...document.querySelectorAll('.acf-thinking-wrap .seg-group .seg-btn')].map(b => b.textContent.trim()), seen: [...new Set(window.__seen)] }))()`);
            assert.deepEqual(done.names, ['Default', 'Low', 'Medium', 'High'], `${tag}: the account's levels`);
            assert.ok(!done.seen.some(s => /Minimal/.test(s)), `${tag}: Minimal never appeared at any point: ${JSON.stringify(done.seen)}`);
            await ev(`window.hideLaunchModal(); true`);
        }
        console.log('PASS New Agent offers no Thinking level the account lacks, at any moment');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
