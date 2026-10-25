// A dashboard with no sign-in session (#3418, #3939; strict mode): an /api call answering 401 dashboard_auth_required stops every poller and the live feed
// and goes to the /auth sign-in page, keeping the page it was on so sign-in returns there (#7398: it was a "Coral now requires sign-in" dialog). A 401 that
// is not "signed out" (an agent-only route's session_token_required) and a 401 from another origin change nothing, and a false 401 (the session is fine)
// reloads the page instead.
//
// Expects CORAL_TEST_URL + CDP_PORT from the runner. Drives Chrome over CDP (chrome-remote-interface). Exit 0 / 1.
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
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: shows that nothing runs while signed out (no condition to wait for)
    try {
        await Promise.all([Page.enable(), Runtime.enable()]);
        // /api/qa-locked answers like strict mode; /api/qa-agent-only is an agent-only route's own 401; while sessionStorage 'qa-locked' is '1',
        // the authenticated probe /api/settings is refused too (sessionStorage so the state survives the navigation).
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const real = window.fetch.bind(window);
            const json = (b, s) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
            window.__api = 0; window.__inflight = 0;
            // Count the terminal sockets the page opens, and run the terminal's 3 s reconnect delay in 0.2 s (this suite only).
            const RealWS = window.WebSocket; window.__termWs = 0;
            window.WebSocket = function (u, p) { if (String(u).includes('/ws/terminal')) window.__termWs++; return p === undefined ? new RealWS(u) : new RealWS(u, p); };
            window.WebSocket.prototype = RealWS.prototype; for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) window.WebSocket[k] = RealWS[k];
            const realSetTimeout = window.setTimeout.bind(window); window.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms === 3000 ? 200 : ms, ...rest);
            window.fetch = (u, o) => {
                const s = String(u);
                if (s.includes('/api/qa-locked')) return json({ error: 'sign in', code: 'dashboard_auth_required' }, 401);
                if (s.includes('/api/settings') && sessionStorage.getItem('qa-offline') === '1') return Promise.reject(new TypeError('offline'));
                if (s.includes('/api/qa-agent-only')) return json({ error: 'session_token_required', message: 'agents only' }, 401);
                if (s.includes('/api/') && sessionStorage.getItem('qa-locked') === '1' && s.includes('/api/settings')) return json({ error: 'sign in', code: 'dashboard_auth_required' }, 401);
                if (s.startsWith('/api/') || s.startsWith(location.origin + '/api/')) {
                    window.__api++; window.__inflight++;
                    const pr = real(u, o); const done = () => { window.__inflight--; }; pr.then(done, done); return pr;
                }
                return real(u, o);
            }; })();` });
        await Page.navigate({ url: BASE + '/chats?q=battle' }); await Page.loadEventFired(); // a page with a path and query (#3532)
        await coralReady();
        await ev(`sessionStorage.removeItem('qa-locked'); true`);
        const S = `(window.__coralStatic || '/static/')`;
        await ev(`(async () => { const o = await import(${S} + 'overload.js'); window.__ticks = 0; window.__poll = o.pollEvery(() => { window.__ticks++; }, 100); window.__o = o; return true; })()`);
        await waitFor(`window.__ticks >= 3`, 'a poller ticking while signed in', { timeout: 5000 });
        const here = await ev(`location.pathname + location.search + location.hash`);

        // A terminal socket for an agent that is not there: the server refuses it and the terminal keeps trying to reconnect, as it does for any dropped socket.
        await ev(`(async () => { const st = (await import(${S} + 'state.js')).state; st.currentSession = { type: 'live', name: 'qa-term', tmux_session: 'qa-term', agent_type: 'terminal', session_id: 'qa-term-sid' };
            window.connectTerminalWs('qa-term', 'terminal', 'qa-term-sid', 'local'); return true; })()`);
        await waitFor(`window.__termWs >= 3`, 'the terminal reconnecting while signed in', { timeout: 8000 });

        console.log('1. A 401 from another origin, or one that is not "signed out", changes nothing');
        await ev(`fetch('http://127.0.0.1:1/api/x').catch(() => 0); fetch('/api/qa-agent-only'); true`);
        await sleep(400); // sleep-ok: proves a negative, no panel appears for a 401 that is not signed out
        assert.equal(await ev(`!!document.getElementById('signed-out-panel')`), false, 'no panel for a 401 that is not signed out');
        console.log('   ✓ no panel');

        console.log('2. A signed-out 401 stops the page; when nothing answers the check, it stays where it is and waits');
        // The check asks /api/settings whether the session is really gone; here it gets no answer (sessionStorage 'qa-offline'), so the page neither guesses nor leaves.
        await ev(`sessionStorage.setItem('qa-offline', '1'); window.__marker = 'here'; fetch('/api/qa-locked'); fetch('/api/qa-locked'); true`);
        await waitFor(`(async () => (await import(${S} + 'overload.js')).isSignedOut())()`, 'the page signed out', { timeout: 8000 });
        assert.equal(await ev(`!!document.getElementById('signed-out-panel') || !!document.querySelector('dialog[open]')`), false, 'no dialog');
        await waitFor(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Coral is not answering. Trying again'))`, 'the line that says nothing answers', { timeout: 8000 });
        assert.equal(await ev(`document.querySelectorAll('.toast').length`), 1, 'one such line, however many times the check is asked');
        console.log('3. Every poller and the live feed wait');
        // Wait until no /api request is in flight before taking the baseline, so a poll already
        // dispatched when the page stopped doesn't land mid-measurement (#3939 flake: 23 vs 22).
        await waitFor(`(window.__inflight || 0) === 0`, 'no /api request in flight before the baseline', { timeout: 5000 });
        const ticks = await ev(`window.__ticks`);
        const sock = await ev(`(async () => { const st = (await import(${S} + 'state.js')).state; window.__sock = st.coralWs; return st.coralWs ? st.coralWs.readyState : -1; })()`);
        await sleep(2500); // sleep-ok: proves a negative, the 100 ms poller does not tick while signed out
        assert.equal(await ev(`window.__ticks`), ticks, 'a poller (100 ms) did not tick for 2.5 s while signed out');
        assert.equal(await ev(`(async () => { const st = (await import(${S} + 'state.js')).state; return st.coralWs === window.__sock && (!st.coralWs || st.coralWs.readyState >= 2); })()`), true, 'the live feed is closed and not reconnected');
        const calls = await ev(`window.__api`);
        await sleep(1500); // sleep-ok: proves a negative, the page makes no /api request while signed out
        assert.equal(await ev(`window.__api`), calls, 'no /api request from the page while signed out');
        console.log(`   ✓ poller frozen at ${ticks} ticks, feed closed (was ${sock}), no /api calls in 4 s`);

        console.log('3b. The terminal socket is closed and does not reconnect either');
        const term = await ev(`window.__termWs`);
        await sleep(1500); // sleep-ok: proves a negative, no terminal reconnect in 1.5 s (the retry delay is 0.2 s here)
        assert.equal(await ev(`window.__termWs`), term, 'no new terminal socket while signed out');
        assert.equal(await ev(`window.connectTerminalWs('qa-term', 'terminal', 'qa-term-sid', 'local') === undefined && window.__termWs`), term, 'and a new connect call does nothing');
        console.log(`   ✓ ${term} terminal sockets before, none after`);
        assert.equal(await ev(`window.__marker + ' ' + location.pathname + location.search`), 'here /chats?q=battle', 'and the page never left while nothing answered the check');

        console.log('3c. When Coral answers again, the check is asked again by itself: the sign-in page, and the line is gone');
        await ev(`sessionStorage.removeItem('qa-offline'); sessionStorage.setItem('qa-locked', '1'); true`);
        await waitFor(`location.pathname === '/auth' && document.readyState === 'complete' && document.documentElement.dataset.authReady === 'true'`, 'the sign-in page once Coral answers', { timeout: 15000 });
        console.log('   ✓ asked again, landed on ' + (await ev(`location.pathname`)));

        console.log('4. For real: a signed-out 401 lands on the sign-in page, which returns to the page it came from');
        await ev(`sessionStorage.removeItem('qa-offline'); sessionStorage.removeItem('qa-locked'); true`);
        await Page.navigate({ url: BASE + '/chats?q=other#top' }); await Page.loadEventFired(); await coralReady();
        const authNavs = []; client.Page.frameNavigated(e => { if (!e.frame.parentId && new URL(e.frame.url).pathname === '/auth') authNavs.push(e.frame.url); });
        const placeBefore = await ev(`location.pathname + location.search + location.hash`); // the page's own place when the 401 comes (its router may tidy the address)
        await ev(`sessionStorage.setItem('qa-locked', '1'); fetch('/api/qa-locked'); fetch('/api/qa-locked'); true`);
        await waitFor(`location.pathname === '/auth' && document.readyState === 'complete' && document.documentElement.dataset.authReady === 'true'`, 'the sign-in page', { timeout: 15000 });
        const auth = await ev(`({ href: location.pathname + location.search, form: !!document.getElementById('submit'), dialog: !!document.querySelector('dialog[open], #signed-out-panel'), text: document.body.innerText })`);
        assert.equal(auth.href, '/auth?return_to=' + encodeURIComponent(placeBefore), 'the sign-in page, returning to the page and its place');
        assert.equal(auth.form, true, 'it is the sign-in (or create-password) form'); assert.equal(auth.dialog, false, 'no dialog over it');
        assert.match(auth.text, /Sign in|Create a password/, 'a page with a way in (the strict page also says the app, the tray and coral open sign in by themselves: internal/auth\'s signin golden)');
        await sleep(1500); // sleep-ok: proves a negative, two 401s and the live feed's retries land on the sign-in page once
        assert.equal(authNavs.length, 1, 'one navigation to the sign-in page: ' + JSON.stringify(authNavs));
        console.log('   ✓ ' + auth.href);

        console.log('5. A false 401 (the session is fine) reloads the page instead');
        await ev(`sessionStorage.removeItem('qa-locked'); true`);
        await Page.navigate({ url: BASE + '/chats?q=battle' }); await Page.loadEventFired(); await coralReady();
        await ev(`window.__marker = 1; fetch('/api/qa-locked'); true`);
        await waitFor(`window.__marker !== 1`, 'the page reloading', { timeout: 15000 });
        await coralReady();
        assert.equal(await ev(`location.pathname + location.search`), '/chats?q=battle', 'the same page, not the sign-in page');
        assert.equal(await ev(`(async () => { const o = await import(${S} + 'overload.js'); return o.isSignedOut(); })()`), false, 'pollers are not paused');
        console.log('   ✓ reloaded on the same page');
        console.log('\nAll sign-in redirect checks passed');
    } finally {
        await client.close();
    }
})().catch(err => {
    console.error(err);
    process.exit(1);
});
