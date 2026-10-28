// #10297 (Mobile pass 21, #10283): restarting an agent was a two-step persona dialog, and the chat came back blank with the old draft still in the box.
//  1. The agent's menu offers "Restart, same settings": one tap, no dialog, the settings it was started with (the request carries no prompt, model or flags). The
//     dialog stays behind "Restart with changes".
//  2. The conversation so far stays above the new one, with a line where the new one starts.
//  3. The draft typed to the agent being replaced is gone, from the box and from the saved drafts.
//  4. A restart opens in Chat, though the person had the Terminal on.
// The server's side is mocked: the restart route swaps the agent for a new session of the same name with a new, shorter conversation.
// Drives Chrome over CDP through agent_view_harness.js; run_cdp_suites.mjs finds CDP suites by that name.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();

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

    const run = async (label) => {
        const tag = label.startsWith('Desktop') ? 'd' : 'p';
        const id0 = 'rs-old-' + tag, id1 = 'rs-new1-' + tag, id2 = 'rs-new2-' + tag;
        console.log(`${label}: Restart, same settings is one tap and keeps the conversation, drops the draft and opens in Chat`);
        await ev(`(() => {
            const m = window.__m;
            for (const id of Object.keys(m.agents)) delete m.agents[id];
            m.add('rs', 'O', 3, { sleeping: false, session_id: ${JSON.stringify(id0)} });
            T.state.liveSessions = Object.values(m.agents).map(a => m.entry(a));
            T.render.renderLiveSessions(T.state.liveSessions);
            window.__srv.restarts = 0; window.__srv.bodies = []; window.__srv.tag = ${JSON.stringify(tag)};
        })()`);
        await ev(`window.selectLiveSession('rs', 'claude', ${JSON.stringify(id0)}, 'local')`);
        await waitFor(`JSON.stringify(window.__rendered()) === '["O0","O1","O2"]'`, 'the agent\'s conversation', 5000);

        // The words typed to the agent.
        await ev(`(() => {
            const input = document.getElementById('command-input');
            input.value = 'half a thought'; input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        assert.equal(await ev(`T.state.sessionInputText['live:${id0}']`), 'half a thought', 'the draft is saved for the agent');

        // The menu: the one-tap item, and the dialog's item for changes.
        const openMenu = id => ev(`(() => { const row = [...document.querySelectorAll('#live-sessions-list .session-group-item, #mobile-session-list .session-group-item')].find(e => e.dataset.sessionId === ${JSON.stringify(id)} && e.querySelector('[data-on-click="kebab-toggle"]')); const k = row && row.querySelector('[data-on-click="kebab-toggle"]'); if (k) k.click(); return !!k; })()`);
        await waitFor(`!!document.querySelector('#live-sessions-list .session-group-item[data-session-id="${id0}"], #mobile-session-list .session-group-item[data-session-id="${id0}"]')`, 'the agent\'s row', 5000);
        assert.ok(await openMenu(id0), 'the row has a menu button');
        const items = await ev(`(() => [...document.querySelectorAll('[data-on-click^="agent-restart"][data-session-id="${id0}"]')].map(b => [b.dataset.onClick, b.textContent.trim().replace(/\\s+/g, ' ')]))()`);
        assert.ok(items.some(i => i[0] === 'agent-restart-same' && i[1] === 'Restart, same settings'), 'Restart, same settings is in the menu: ' + JSON.stringify(items));
        assert.ok(items.some(i => i[0] === 'agent-restart' && /^Restart with changes/.test(i[1])), 'the dialog stays behind Restart with changes: ' + JSON.stringify(items));

        await ev(`document.querySelector('[data-on-click="agent-restart-same"][data-session-id="${id0}"]').click()`);
        await waitFor(`window.__srv.restarts === 1`, 'the restart to be asked', 5000);
        const body = await ev(`window.__srv.bodies[0]`);
        assert.equal(body.session_id, id0);
        for (const k of ['prompt', 'model', 'thinking', 'extra_flags', 'capabilities']) assert.equal(body[k], undefined, `a same-settings restart sends no ${k}`);
        assert.notEqual(await ev(`getComputedStyle(document.getElementById('restart-modal')).display`), 'flex', 'no dialog');

        // The conversation so far stays, then the new one.
        await waitFor(`JSON.stringify(window.__rendered()) === '["O0","O1","O2","N0","N1"]'`, 'the earlier conversation above the new one', 5000, 'window.__rendered()');
        const earlier = await ev(`(() => { const e = document.querySelector('#live-history-messages > .chat-earlier'); return e && { text: e.textContent, before: !!(e.compareDocumentPosition(document.querySelector('#live-history-messages .message-text:not(.chat-earlier *)')) & Node.DOCUMENT_POSITION_FOLLOWING) }; })()`);
        assert.ok(earlier, 'the earlier conversation is a block of its own');
        assert.match(earlier.text, /O0 lorem/);
        assert.match(earlier.text, /Restarted: a new conversation starts here/);
        assert.ok(earlier.before, 'it sits above the new conversation');

        // The draft is gone, from the box and from the saved drafts (the old session's and the new one's).
        assert.equal(await ev(`document.getElementById('command-input').value`), '', 'the box is empty');
        assert.ok(!(await ev(`T.state.sessionInputText['live:${id0}']`)), 'the old session\'s saved draft is gone');
        assert.ok(!(await ev(`T.state.sessionInputText['live:${id1}']`)), 'nothing saved for the new session');

        // A second restart keeps both earlier conversations, in order.
        await waitFor(`!!document.querySelector('#live-sessions-list .session-group-item[data-session-id="${id1}"], #mobile-session-list .session-group-item[data-session-id="${id1}"]')`, 'the new session\'s row', 5000);
        assert.ok(await openMenu(id1));
        await ev(`document.querySelector('[data-on-click="agent-restart-same"][data-session-id="${id1}"]').click()`);
        await waitFor(`window.__srv.restarts === 2`, 'the second restart to be asked', 5000);
        await waitFor(`JSON.stringify(window.__rendered()) === '["O0","O1","O2","N0","N1","N0","N1"]'`, 'both earlier conversations above the newest', 5000, 'window.__rendered()');

        // A restart opens in Chat, though the person had the Terminal on.
        await ev(`T.liveChat.setLiveViewMode('terminal')`);
        await waitFor(`T.liveChat.effectiveLiveViewMode() === 'terminal'`, 'the Terminal view', 3000);
        await waitFor(`!!document.querySelector('#live-sessions-list .session-group-item[data-session-id="${id2}"], #mobile-session-list .session-group-item[data-session-id="${id2}"]')`, 'the newest session\'s row', 5000);
        assert.ok(await openMenu(id2));
        await ev(`document.querySelector('[data-on-click="agent-restart-same"][data-session-id="${id2}"]').click()`);
        await waitFor(`window.__srv.restarts === 3`, 'the third restart to be asked', 5000);
        await waitFor(`T.liveChat.effectiveLiveViewMode() === 'chat'`, 'a restart to open in Chat', 5000);
        await ev(`T.liveChat.setLiveViewMode('chat')`);
        console.log('   ✓ one tap, conversation kept, draft gone, opens in Chat');
    };

    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE });
        await Page.loadEventFired();
        await install();
        await ev(`localStorage.clear(); localStorage.setItem('coral-live-view-mode', 'chat')`);
        await ev(MOCK);
        await run('Desktop');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true });
        await sleep(300); // sleep-ok: the phone layout settles
        await run('Phone 390x844');
        await Emulation.clearDeviceMetricsOverride();
        await Emulation.setTouchEmulationEnabled({ enabled: false });
        console.log('\nAll restart-same-settings checks passed');
    } finally {
        await client.close();
    }
})().catch(err => {
    console.error(err);
    process.exit(1);
});
