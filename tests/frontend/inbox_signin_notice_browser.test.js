// The Inbox says so when Claude is signed out (#15093): a notice at the top of Needs you, only while the server says Claude is not signed in AND an agent launched with Claude is on this computer (the Operator:
// not just Claude installed). Open terminal to sign in, Check again (asks the CLI itself), Dismiss for a day; it goes when Claude is signed in. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const NOTICE = `document.querySelector('#group-table-view .inbox-signin-notice')`;
    const shown = `(() => { const n = ${NOTICE}; return !!n && !n.hidden && n.getClientRects().length > 0; })()`;
    const claudeRow = { session_id: 'sess-claude-1', name: 'claude', agent_type: 'claude', display_name: 'Claude one' };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`localStorage.removeItem('coral-inbox-signin-dismissed'); true`);
            const set = signedIn => ev(`import(${S} + 'signin_line.js').then(m => { m.setClaudeSignedIn(${signedIn}); return true; })`);
            const agents = rows => ev(`import(${S} + 'state.js').then(m => { m.state.liveSessions = ${JSON.stringify(rows)}; return true; })`);
            await ev(`window.switchNavTab && window.switchNavTab('hub-inbox'); true`);
            await waitFor(`!!document.querySelector('#group-table-view')`, `${at}the Inbox`, 15000);

            console.log(`${at}1. Signed out but no Claude agent here: nothing`);
            await agents([]); await set(false); await new Promise(r => setTimeout(r, 800)); // sleep-ok: the absence of a notice has nothing to wait for; the mutation check (agent test removed) fails here
            assert.ok(!(await ev(shown)), at + 'no notice without an agent launched with Claude');

            console.log(`${at}2. Signed out with a Claude agent: the notice, with its three buttons`);
            await agents([claudeRow]); await set(true); await set(false);
            await waitFor(shown, `${at}the notice`, 8000);
            const n = await ev(`(() => { const b = [...${NOTICE}.querySelectorAll('button')]; return { names: b.map(x => x.textContent), tall: b.every(x => x.getBoundingClientRect().height >= (${mobile} ? 44 : 24)), role: ${NOTICE}.getAttribute('role'), over: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
            assert.deepEqual(n.names, ['Open terminal to sign in', 'Check again', 'Dismiss for a day'], at + JSON.stringify(n));
            assert.ok(n.tall && n.role === 'status' && !n.over, at + 'sized, a status, no sideways scroll: ' + JSON.stringify(n));

            console.log(`${at}3. Check again asks the CLI, and the notice goes when it is signed in`);
            await ev(`window.__asked = []; const f = window.fetch.bind(window); window.fetch = (u, o) => { if (String(u).includes('/api/system/cli-check')) { window.__asked.push(String(u)); return Promise.resolve(new Response(JSON.stringify({ signed_in: window.__ans }), { status: 200, headers: { 'Content-Type': 'application/json' } })); } return f(u, o); }; window.__ans = false; true`);
            await ev(`${NOTICE}.querySelector('button:nth-of-type(2)').click(); true`);
            await waitFor(`/still not signed in/.test(${NOTICE}.textContent)`, `${at}still-not-signed-in is said`, 6000);
            assert.ok(await ev(`window.__asked.some(u => /type=claude/.test(u) && /signin=1/.test(u))`), at + 'it asked the CLI for Claude');
            await ev(`window.__ans = true; ${NOTICE}.querySelector('button:nth-of-type(2)').click(); true`);
            await waitFor(`!${shown}`, `${at}the notice goes once signed in`, 6000);

            console.log(`${at}4. Dismiss for a day hides it, and it stays away`);
            await set(false); await waitFor(shown, `${at}back`, 8000);
            await ev(`${NOTICE}.querySelector('button:nth-of-type(3)').click(); true`);
            await waitFor(`!${shown}`, `${at}dismissed`, 4000);
            assert.ok(await ev(`!!localStorage.getItem('coral-inbox-signin-dismissed')`), at + 'the dismissal is remembered');
            await set(true); await set(false);
            await waitFor(shown, `${at}a sign-in clears the dismissal, so a later sign-out says so again`, 8000);
        }
        console.log('PASS inbox signin notice');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
