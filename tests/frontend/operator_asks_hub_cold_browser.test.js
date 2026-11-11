// A cold native Hub Needs page must wait for the linked-computer inventory before reading operator asks.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 800, mobile: false, inbox: 'native', needs: true, hubPages: true });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
            window.__noComputers = true; window.__askReads = [];
            const fetch = window.fetch;
            window.fetch = (u, o = {}) => {
                const p = new URL(String(u), location.href);
                if (p.pathname === '/api/operator-asks' || /\\/api\\/remote\\/[^/]+\\/api\\/operator-asks$/.test(p.pathname)) {
                    window.__askReads.push(p.pathname);
                    if (p.pathname !== '/api/operator-asks') return Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
                }
                return fetch(u, o);
            };
        })()` });
        for (const width of [1280, 390]) {
            if (width === 390) await ev(`window.__noComputers = true; window.__askReads = []; true`);
            await Emulation.setDeviceMetricsOverride({ width, height: 800, deviceScaleFactor: 1, mobile: width === 390 });
            await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'dashboard');
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => { m.state.servers = []; m.state.serversKnown = false; return true; })`);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.getElementById('group-table-title')?.textContent === 'Needs you'`, `${width}px native Needs`, 15000);
            await ev(`import((window.__coralStatic || '/static/') + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
            assert.deepEqual(await ev('window.__askReads.slice()'), [], `${width}px cold Needs makes no question reads before inventory`);
            assert.equal(await ev(`import((window.__coralStatic || '/static/') + 'needs_incomplete.js').then(m => m.incompleteNote())`), '', `${width}px cold Needs has no false gap`);
            const emptyWords = await ev(`document.getElementById('group-table-view').innerText`);
            assert.match(emptyWords, /Loading Needs you/, `${width}px cold Needs says it is loading`);
            assert.doesNotMatch(emptyWords, /You are all caught up/, `${width}px cold Needs does not claim to be empty`);
            await ev(`import((window.__coralStatic || '/static/') + 'operator_ask_dialog.js').then(m => m.openAskDialog({ board: 'team-a', asker: 'Writer', kind: 'ask', id: 19, at: new Date().toISOString(), text: 'May I continue?' })).then(() => true)`);
            const dialogState = await ev(`(() => { const d = document.querySelector('.inbox-ask-dialog'), box = d?.querySelector('textarea'), send = d?.querySelector('.inbox-ask-send'), alert = d?.querySelector('[role=alert]'); return { open: !!d?.open, readOnly: !!box?.readOnly, sendDisabled: !!send?.disabled, alert: alert?.textContent || '', described: d?.getAttribute('aria-describedby') === alert?.id }; })()`);
            assert.equal(dialogState.open, true, `${width}px serverless ask dialog opened`);
            assert.equal(dialogState.readOnly, true, `${width}px serverless ask reply field stays read-only`);
            assert.equal(dialogState.sendDisabled, true, `${width}px serverless ask Send stays disabled`);
            assert.match(dialogState.alert, /computer is not loaded yet/, `${width}px explanation appears after the dialog opens`);
            assert.equal(dialogState.described, true, `${width}px dialog describes its source warning`);
            await ev(`document.querySelector('.inbox-ask-dialog .inbox-ask-buttons .btn').click(); true`);
            await ev(`window.__noComputers = false; window._coralLoadLiveSessions().then(() => true)`);
            await waitFor(`window.__askReads.some(p => p.startsWith('/api/remote/'))`, `${width}px inventory triggers scoped reads`, 10000);
            assert.equal(await ev(`window.__askReads.includes('/api/operator-asks')`), false, `${width}px never reads the Hub root`);
            console.log(`   ok cold Hub Needs at ${width}px`);
        }
        console.log('PASS cold Hub Needs waits for the linked-computer list and reads only computer-scoped questions');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
