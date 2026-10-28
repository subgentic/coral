// The sidebar search belongs to its tab (#10512, Desktop recheck): words typed in the Inbox's search do not narrow the Agents list when the person goes there, and the Agents search box has one clear button (our
// own), not that and the browser's built-in one. 1280 px; stand-in agents in the page. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`window.__m.add('alpha-one', 'A', 1, { sleeping: false }); window.__m.add('beta-two', 'B', 2, { sleeping: false }); window.T.render.renderLiveSessions(window.T.state.liveSessions); true`);
        await waitFor(`document.querySelectorAll('#live-sessions-list li[data-session-id]').length >= 2`, 'the two agents', 10000);
        const rows = () => ev(`[...document.querySelectorAll('#live-sessions-list li[data-session-id]')].filter(l => l.getClientRects().length).length`);
        const before = await rows();
        // the Inbox's search takes words, then the person goes back to Agents
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`!!document.getElementById('inbox-search') && document.getElementById('inbox-search').getClientRects().length > 0`, 'the Inbox search', 10000);
        await ev(`(() => { const i = document.getElementById('inbox-search'); i.value = 'zzz-not-an-agent'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await sleep(400); // sleep-ok: the search settles
        await ev(`window.switchNavTab('agents'); true`);
        await waitFor(`document.getElementById('agent-search-input').getClientRects().length > 0`, 'the Agents search', 10000);
        await sleep(300); // sleep-ok: the list is drawn after the tab opens
        assert.equal(await ev(`document.getElementById('agent-search-input').value`), '', 'the Agents search box is empty: the Inbox words did not come with the person');
        assert.equal(await rows(), before, 'and every agent is listed, not narrowed by the Inbox words');
        // one clear button: type in the Agents search; our button shows, the browser's own is not drawn
        await ev(`(() => { const i = document.getElementById('agent-search-input'); i.value = 'alpha'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await waitFor(`!document.getElementById('agent-search-clear').hidden`, 'our clear button', 5000);
        // the built-in cancel button lives in the input's user-agent shadow tree: it has a box when it is drawn and none when it is not (getComputedStyle does not see author rules on it)
        const drawn = async id => {
            const { root } = await client.DOM.getDocument({ depth: -1, pierce: true });
            const input = (await client.DOM.querySelector({ nodeId: root.nodeId, selector: '#' + id })).nodeId;
            const { node } = await client.DOM.describeNode({ nodeId: input, depth: -1, pierce: true });
            const find = n => { for (const c of [...(n.shadowRoots || []), ...(n.children || [])]) { if ((c.attributes || []).includes('-webkit-search-cancel-button')) return c; const r = find(c); if (r) return r; } return null; };
            const btn = find(node); if (!btn) return false;
            try { const box = await client.DOM.getBoxModel({ backendNodeId: btn.backendNodeId }); return box.model.width > 0; } catch { return false; }
        };
        await client.DOM.enable();
        assert.equal(await drawn('agent-search-input'), false, 'the browser\'s own clear button is not drawn beside ours');
        console.log('PASS Sidebar search: it stays with its tab, and the Agents box has one clear button');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
