// A pop-out agent window (/agent/<id>) with no sign-in session goes to the /auth sign-in page, once, returning to its own path and query, with no "Coral now requires sign-in" dialog on the way and no
// bounce back (#7398; QA's check for the review: the pop-out is a separate page that does not start the dashboard's navigation). every /api call answers 401 dashboard_auth_required while the page is a pop-out;
// the sign-in page itself loads normally. Expects CORAL_TEST_URL + CDP_PORT from the runner. Drives Chrome over CDP.
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime } = client;
    const ev = async expression => {
        const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
        return r.result.value;
    };
    const { waitFor } = require('./helpers/wait').bind(ev);
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: shows that nothing moves after the redirect (no condition to wait for)
    try {
        await Promise.all([Page.enable(), Runtime.enable()]);
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const real = window.fetch.bind(window); const n = +(sessionStorage.getItem('qa-navs') || 0) + 1; sessionStorage.setItem('qa-navs', String(n));
            window.__dialogSeen = false; new MutationObserver(() => { if (document.getElementById('signed-out-panel') || [...document.querySelectorAll('dialog')].some(d => /requires sign-in/i.test(d.textContent))) { window.__dialogSeen = true; sessionStorage.setItem('qa-dialog', '1'); } }).observe(document, { childList: true, subtree: true });
            window.fetch = (u, o) => { const s = String(u); if (location.pathname.startsWith('/agent/') && s.includes('/api/')) return Promise.resolve(new Response(JSON.stringify({ error: 'sign in', code: 'dashboard_auth_required' }), { status: 401, headers: { 'Content-Type': 'application/json' } })); return real(u, o); }; })();` });
        for (const path of ['/agent/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', '/agent/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee?x=1&y=two#frag']) {
            console.log(path);
            await Page.navigate({ url: BASE + '/auth' }); await Page.loadEventFired();
            await ev(`sessionStorage.clear(); true`);
            await Page.navigate({ url: BASE + path }); await Page.loadEventFired();
            await waitFor(`location.pathname === '/auth'`, `the pop-out ${path} goes to the sign-in page`, { timeout: 10000, diag: `({ href: location.href, text: document.body ? document.body.innerText.slice(0, 160) : null, ready: typeof window.__coralReady, scripts: document.scripts.length })` });
            const want = '/auth?return_to=' + encodeURIComponent(path);
            const got = await ev(`location.pathname + location.search`);
            assert.equal(got, want, 'the sign-in page url keeps the pop-out\'s own path, query and hash');
            assert.ok(decodeURIComponent(new URL(await ev(`location.href`)).searchParams.get('return_to')).startsWith('/agent/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), `return_to is the pop-out's own path: ${got}`);
            await sleep(1500); // sleep-ok: shows that nothing moves after the redirect (a negative has no condition to wait for)
            assert.equal(await ev(`location.pathname`), '/auth', 'it stays on the sign-in page (no bounce)');
            assert.equal(await ev(`sessionStorage.getItem('qa-dialog')`), null, 'the sign-in dialog was never shown');
            assert.ok(Number(await ev(`sessionStorage.getItem('qa-navs')`)) <= 2, 'one redirect: the pop-out and the sign-in page, no loop');
        }
        console.log('PASS signed-out pop-out windows go to /auth once, returning to their own path, with no dialog');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
