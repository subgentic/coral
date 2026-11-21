// coral-hub #259026 (#20437): through the Hub, Saved messages get Done and Remove (and Save on a message) only for the bookmark write routes the Hub reports open (account.saved_routes: { save, done, remove }); a route it does not report is not offered and not sent. The computer stays the authority (owner-only there). Open, partly open and closed. The stubbed Hub (helpers/hub_world). Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 900, mobile: false, inbox: 'native', needs: true, hubPages: true });
        const S = `(window.__coralStatic || '/static/')`;
        for (const routes of [{}, { done: true }, { done: true, remove: true, save: true }]) {
            const { identifier } = await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const real = window.fetch; window.fetch = (u, o) => new URL(String(u), location.href).pathname === '/api/account' ? Promise.resolve(Response.json({ tasks_native: true, saved_native: true, saved_expand: true, saved_routes: ${JSON.stringify(routes)} })) : real(u, o); })()` });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await coralReady(ev, 'startup', 'settings');
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'state.js').then(({ state }) => { state.servers = [{ id: 'm1', label: 'Owner one', owner: true, status: 'online', coral_version: '2.0.62', effective_mode: 'interact' }];
                const real = window.fetch; window.__writes = [];
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.href), m = url.pathname.match(/^\\/api\\/remote\\/([^/]+)(\\/api\\/.*)$/); if (!m) return real(u, o); const [, server, path] = m;
                    if (path === '/api/saved') return Promise.resolve(Response.json({ items: [{ id: 1, kind: 'board', key: '7', ref: 'alpha', team: 'alpha', title: 'Saved ' + server, snippet: 'a saved line', saved_at: '2026-11-08T10:00:00Z', server: 'm1' }], open: 1, done: 0 }));
                    if (/^\\/api\\/saved\\/1$/.test(path) && (o.method === 'PATCH' || o.method === 'DELETE')) { window.__writes.push(o.method); return Promise.resolve(Response.json({ ok: true })); }
                    return real(u, o); }; return true; })`);
            await ev(`import(${S} + 'inbox_sidebar.js').then(m => m.openInboxGroup('saved'))`);
            await waitFor(`import(${S} + 'saved.js').then(m => m.savedView().shown.length === 1)`, 'the saved message loads');
            const tag = JSON.stringify(routes);
            const open = await ev(`import(${S} + 'saved_routes.js').then(m => ({ save: m.savedRouteOpen('save'), done: m.savedRouteOpen('done'), remove: m.savedRouteOpen('remove') }))`);
            assert.deepEqual(open, { save: routes.save === true, done: routes.done === true, remove: routes.remove === true }, 'each route is open only when the Hub says so ' + tag);
            assert.equal(await ev(`!![...document.querySelectorAll('#group-table-view button')].find(b => /^(Mark done|Reopen, move)/.test(b.getAttribute('aria-label') || ''))`), routes.done === true, 'the Done button shows only when its route is open ' + tag);
            await ev(`(() => { const root = document.getElementById('live-history-messages') || document.getElementById('mb-messages'); const b = document.createElement('button'); b.className = 'chat-save-btn'; b.id = 'probe-save'; root.append(b); return true; })()`);
            await waitFor(`document.getElementById('probe-save').hidden === ${routes.save === true ? 'false' : 'true'}`, 'the Save button follows the Hub\u2019s save route ' + tag, 8000);
            const res = await ev(`import(${S} + 'saved.js').then(async m => { const it = m.savedView().shown[0]; return { done: await m.savedSetDone(it, true), remove: await m.savedRemove(it), writes: window.__writes.slice() }; })`);
            assert.equal(res.done, routes.done === true, 'Done goes through only when its route is open ' + tag);
            assert.equal(res.remove, routes.remove === true, 'Remove goes through only when its route is open ' + tag);
            assert.deepEqual(res.writes, [...(routes.done ? ['PATCH'] : []), ...(routes.remove ? ['DELETE'] : [])], 'no write is sent for a closed route ' + tag);
            await Page.removeScriptToEvaluateOnNewDocument({ identifier });
        }
        console.log('PASS hub saved writes');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
