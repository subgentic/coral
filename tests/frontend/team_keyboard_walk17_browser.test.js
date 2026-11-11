// Keyboard fixes from walk 17 (#15296), failing first: the Board tab has a skip link to "Message the team" as its first stop (it was 50 stops through the messages, and text typed meanwhile went nowhere);
// the Answer dialog gives the keyboard back to the button that opened it (it went to the search box); the phone's view switcher is named by the view, not "Current view".
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const TEAM = `kbd17-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = `(window.__coralStatic || '/static/')`;
    const key = async (k, code, vk) => { await client.Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...(k === 'Enter' ? { text: '\r' } : {}) }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); await settle(120); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM); await openTeam(ev, waitFor, TEAM); await settle(400);

        // the Board tab: the first Tab is the skip link
        await ev(`document.getElementById('team-tab-messages').click(); document.getElementById('team-tab-messages').focus(); true`);
        await waitFor(`(() => { const c = document.getElementById('mb-post-input'); return !!c && c.getClientRects().length > 0; })()`, 'the Board composer shows', 8000);
        await ev(`document.getElementById('team-tab-messages').focus(); true`);
        await key('Tab', 'Tab', 9);
        assert.equal(await ev(`document.activeElement.textContent`), 'Skip to Message the team', 'the first Tab from the Board tab is a skip link to the composer');
        await key('Enter', 'Enter', 13);
        assert.equal(await ev(`document.activeElement.id`), 'mb-post-input', 'Enter on it lands on Message the team');
        assert.equal(await ev(`document.activeElement.getAttribute('aria-label')`), 'Message the team');
        // another tab keeps the ordinary Tab
        await ev(`document.getElementById('team-tab-tasks').click(); document.getElementById('team-tab-tasks').focus(); true`); await settle(300);
        await key('Tab', 'Tab', 9);
        assert.notEqual(await ev(`document.activeElement.id`), 'mb-skip-composer', 'the skip link belongs to the Board');

        // the Answer dialog gives the keyboard back to its opener
        await ev(`(() => { for (const id of ['qa-opener', 'qa-search']) { const b = document.createElement(id === 'qa-opener' ? 'button' : 'input'); b.id = id; b.textContent = 'Answer'; document.body.append(b); } document.getElementById('qa-opener').focus(); return true; })()`);
        await ev(`import(${S} + 'operator_ask_dialog.js').then(m => { m.openAskDialog({ kind: 'wait', asker: 'Orchestrator', board: ${JSON.stringify(TEAM)}, board_label: 'x', text: 'Do you accept it?' }, () => document.getElementById('qa-search').focus()); return true; })`);
        await waitFor(`!!document.querySelector('dialog[open]')`, 'the Answer dialog opens', 8000);
        await key('Escape', 'Escape', 27);
        await waitFor(`!document.querySelector('dialog[open]')`, 'Escape closes it', 4000);
        assert.equal(await ev(`document.activeElement.id`), 'qa-opener', 'the keyboard is back on the button that opened the dialog, not the search box');

        // the view switcher is named by the view
        const nm = await ev(`(() => { const b = document.getElementById('nav-select'); return b.getAttribute('aria-label'); })()`);
        assert.equal(nm, null, 'the view switcher has no fixed name: it is named by the view it shows');
        console.log('PASS Board Tab goes to the composer, the Answer dialog returns focus, the view switcher is named by the view');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
