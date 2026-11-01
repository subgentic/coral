// #11629 (the operator, desktop app, a medium window): the person expands the agent sidebar, opens the Inbox, presses Agents, and the sidebar is the icon rail again. Their expand or collapse is theirs across tab and route
// changes; only the window getting narrower may rail it on its own (#10306). The real page and stylesheet at 1000, 1100 and 1280 px: expand, Inbox, Agents, Docs, Agents; and the other way round (collapse stays collapsed).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const railed = () => ev(`document.querySelector('.layout').classList.contains('sidebar-collapsed')`);
    const tab = async t => { await ev(`switchNavTab(${JSON.stringify(t)}); true`); await new Promise(r => setTimeout(r, 400)); }; // sleep-ok: the dock and the columns settle after a tab
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const w of [1000, 1100, 1280]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile: false });
            for (const want of ['expanded', 'collapsed']) {
                await Page.navigate({ url: BASE + '/agents' }); await Page.loadEventFired(); await install();
                await ev(`try { Object.keys(localStorage).filter(k => k.startsWith('coral-sidebar-collapsed')).forEach(k => localStorage.removeItem(k)); } catch {} true`);
                await Page.navigate({ url: BASE + '/agents' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
                const at = `${w} px, the person ${want === 'expanded' ? 'expands' : 'collapses'} it: `;
                if (await railed() === (want === 'collapsed')) await ev('toggleSidebarRail(); true'); // to the other state first, so the click below is the person's choice
                await new Promise(r => setTimeout(r, 300)); // sleep-ok: the columns settle
                if (await railed() !== (want === 'collapsed')) await ev('toggleSidebarRail(); true');
                await new Promise(r => setTimeout(r, 300)); // sleep-ok: the columns settle
                const chosen = await railed();
                assert.equal(chosen, want === 'collapsed', at + 'the person\'s own choice is on screen first');
                for (const t of ['hub-inbox', 'agents', 'docs', 'agents']) {
                    await tab(t);
                    assert.equal(await railed(), want === 'collapsed', at + `still ${want} after ${t}`);
                }
            }
        }
        // the operator's order (QA's SHOULD): collapse on Agents, expand in the Inbox, back to Agents: it stays open, and the other way round
        for (const w of [1000, 1100, 1280]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/agents' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            const set = async (t, rail) => { await tab(t); if (await railed() !== rail) { await ev('toggleSidebarRail(); true'); await new Promise(r => setTimeout(r, 300)); } assert.equal(await railed(), rail, `${w} px: ${rail ? 'collapsed' : 'expanded'} on ${t}`); }; // sleep-ok: the columns settle
            await set('agents', true); await set('hub-inbox', false); await tab('agents');
            assert.equal(await railed(), false, `${w} px: collapsed on Agents, expanded in the Inbox: back on Agents it stays expanded`);
            await set('agents', false); await set('hub-inbox', true); await tab('agents');
            assert.equal(await railed(), true, `${w} px: expanded on Agents, collapsed in the Inbox: back on Agents it stays collapsed`);
        }
        console.log('\nPASS the sidebar keeps the person\'s expand or collapse across tabs');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
