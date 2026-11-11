// #15465: Restart starts a fresh conversation (the context is cleared and the instructions are sent again), but the old chat stays above the new one, so it looked as if
// the agent kept its context. The agent's menu items say what each does (Restart: a fresh conversation; Wake: continues it), and the line between the old chat and the new one says
// "New conversation: context cleared, instructions sent again". The server's side is mocked as in restart_same_settings_browser.
// Drives Chrome over CDP through agent_view_harness.js; run_cdp_suites.mjs finds CDP suites by that name.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();

    const MOCK = `(() => {
        window.__srv = { restarts: 0, bodies: [], tag: '' };
        const prev = window.fetch;
        const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
        window.fetch = (url, opts = {}) => {
            const u = String(url);
            const method = (opts.method || 'GET').toUpperCase();
            const rm = u.match(/\\/api\\/sessions\\/live\\/([^/?]+)\\/restart$/);
            if (rm && method === 'POST') {
                window.__srv.restarts++;
                window.__srv.bodies.push(JSON.parse(opts.body));
                const m = window.__m;
                const old = m.agents[JSON.parse(opts.body).session_id];
                const fresh = 'rs-new' + window.__srv.restarts + '-' + window.__srv.tag; // an id of its own per run: the page keeps a recent agent's chat by id
                delete m.agents[old.session_id];
                const qa = window.__qaState; window.__qaState = null;
                m.add(old.name, 'N', 2, { sleeping: false, session_id: fresh });
                window.__qaState = qa;
                T.ws.handleCoralMessage({ type: 'coral_diff', changed: [m.entry(m.agents[fresh])], removed: [old.session_id] });
                return Promise.resolve(json({ ok: true, session_id: fresh, session_name: old.name, agent_name: old.name }));
            }
            if (/\\/api\\/sessions\\/live\\/[^/?]+\\?session_id=/.test(u)) return Promise.resolve(json({ ok: true }));
            return prev(url, opts);
        };
    })()`;

    const rendered = () => ev(`window.__rendered()`);

    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE });
        await Page.loadEventFired();
        await install();
        await ev(`localStorage.clear(); localStorage.setItem('coral-live-view-mode', 'chat')`);
        await ev(MOCK);
        await ev(`(() => {
            const m = window.__m;
            for (const id of Object.keys(m.agents)) delete m.agents[id];
            m.add('rc', 'O', 3, { sleeping: false, session_id: 'rc-old' });
            T.state.liveSessions = Object.values(m.agents).map(a => m.entry(a));
            T.render.renderLiveSessions(T.state.liveSessions);
            window.__srv.tag = 'c';
        })()`);
        await ev(`window.selectLiveSession('rc', 'claude', 'rc-old', 'local')`);
        await waitFor(`JSON.stringify(window.__rendered()) === '["O0","O1","O2"]'`, 'the agent\'s conversation', 5000);

        // The menu says what each Restart does.
        await waitFor(`!!document.querySelector('#live-sessions-list .session-group-item[data-session-id="rc-old"]')`, 'the agent\'s row', 5000);
        await ev(`(() => { const row = document.querySelector('#live-sessions-list .session-group-item[data-session-id="rc-old"]'); const b = row.querySelector('[data-on-click="kebab-toggle"]'); if (b) b.click(); return !!b; })()`);
        const titles = await ev(`(() => [...document.querySelectorAll('[data-on-click^="agent-restart"][data-session-id="rc-old"]')].map(b => [b.dataset.onClick, b.title]))()`);
        assert.equal(titles.length, 2, 'both Restart items are in the menu: ' + JSON.stringify(titles));
        for (const [, t] of titles) assert.equal(t, 'Starts a fresh conversation; the instructions are sent again', 'each Restart item says it starts a fresh conversation: ' + JSON.stringify(titles));

        // After a restart the line between the old chat and the new one says the context was cleared.
        await ev(`document.querySelector('[data-on-click="agent-restart-same"][data-session-id="rc-old"]').click()`);
        await waitFor(`window.__srv.restarts === 1`, 'the restart to be asked', 5000);
        await waitFor(`JSON.stringify(window.__rendered()) === '["O0","O1","O2","N0","N1"]'`, 'the earlier conversation above the new one', 5000, 'window.__rendered()');
        const line = await ev(`document.querySelector('#live-history-messages > .chat-earlier .chat-earlier-line')?.textContent`);
        assert.equal(line, 'New conversation: context cleared, instructions sent again');
        console.log('   ✓ the Restart items and the divider say the conversation is fresh');
        console.log('\nAll restart-context checks passed');
    } finally {
        await client.close();
    }
})().catch(err => {
    console.error(err);
    process.exit(1);
});
