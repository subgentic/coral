// Account booleans override boot independently; missing/failed reads keep boot behavior.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 800, mobile: false, inbox: 'native', needs: true, hubPages: true, bootExtra: '"goal_preview":true' });
        for (const account of [{ needs_native: true, goal_preview: true }, { needs_native: true, goal_preview: false }, { needs_native: false, goal_preview: true }, {}, { needs_native: false, goal_preview: false }, { needs_native: 'true', goal_preview: 'true' }, { needs_native: 1, goal_preview: 1 }, null, 'failed']) {
            const delay = account?.needs_native === true && account?.goal_preview === true ? 300 : 0;
            // sleep-ok: delay the account response to prove startup awaits it before routing native Needs you
            const { identifier } = await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const old = window.fetch; window.fetch = (u, o) => new URL(String(u), location.href).pathname === '/api/account' ? (${JSON.stringify(account === 'failed')} ? Promise.reject(new Error('offline')) : new Promise(resolve => setTimeout(() => resolve(new Response(JSON.stringify(${JSON.stringify(account)}), { headers: { 'Content-Type': 'application/json' } })), ${delay}))) : old(u, o); })();` });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await waitFor(`!!window.__coralReady`, 'dashboard ready');
            await coralReady(ev, 'startup', 'settings');
            const flags = await ev(`import((window.__coralStatic || '/static/') + 'server_base.js').then(m => ({ needs: m.nativeNeeds(), goals: m.goalPreviewOn() }))`);
            assert.deepEqual(flags, { needs: typeof account?.needs_native === 'boolean' ? account.needs_native : true, goals: typeof account?.goal_preview === 'boolean' ? account.goal_preview : true }, JSON.stringify(account));
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.getElementById('group-table-title')?.textContent === 'Needs you' || !!document.querySelector('#group-table-view iframe')`, 'Needs you content');
            assert.equal(await ev(`!!document.querySelector('#group-table-view iframe')`), account?.needs_native === false, 'explicit account boolean wins; otherwise boot keeps native table');
            await Page.removeScriptToEvaluateOnNewDocument({ identifier });
        }
        console.log('PASS independent account override/boot fallback and Needs you startup routing');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
