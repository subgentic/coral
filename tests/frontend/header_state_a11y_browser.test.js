// The agent header's status dot (#4327, #4276 finding 3): its tip and accessible name say the state in the sidebar's words and follow a
// change of state from the live feed; the header draws no word beside it (the operator, #9927),
// so a screen reader reads the state once (from the dot, in the accessibility tree). Run against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const { Accessibility, DOM } = client;
    const ok = name => console.log(`   ✓ ${name}`);
    const dot = () => ev(`(() => { const d = document.getElementById('terminal-status-dot'); const h = document.querySelector('#live-session-view .terminal-header');
        return { cls: d.className, title: d.title, role: d.getAttribute('role'), label: d.getAttribute('aria-label'), noWordElement: !document.getElementById('terminal-state-word'), headerText: (c => { const x = c.querySelector('#agent-phone-details'); if (x) x.remove(); return c.textContent.replace(/\\s+/g, ' '); })(h.cloneNode(true)) }; })()`); // the Details card is the header's child, but its facts are not the header's row (#11056)
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.__m.add('dot-bot', 'A', 2, { sleeping: false, session_id: 'dot-sid' }); true`);
        await sleep(600); // sleep-ok: the first live list renders from several answers; no single completion event
        await ev(`window.selectLiveSession('dot-bot', 'claude', 'dot-sid', 'local'); true`);
        await waitFor(`document.getElementById('terminal-status-dot').getAttribute('aria-label')`, 'the dot to be named', 8000);

        let d = await dot();
        assert.equal(d.role, 'img'); assert.equal(d.title, d.label); assert.ok(d.label && d.label.length > 2, 'a state word: ' + d.label);
        assert.ok(d.noWordElement && !new RegExp(d.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(d.headerText), 'the header draws only the dot: no state word beside it, in the header text or as an element (the operator, #9927): ' + JSON.stringify(d));
        ok('the dot has a role, a tip and an accessible name with the sidebar\'s state word, and the header draws no word beside it');

        // it follows the live feed
        for (const [patch, word] of [[{ working: true }, 'Working'], [{ working: false, waiting_for_input: true }, 'Needs input'], [{ waiting_for_input: false, stuck: true }, 'Stuck']]) {
            await ev(`(() => { const a = window.__m.agents['dot-sid']; T.ws.handleCoralMessage({ type: 'coral_diff', changed: [{ ...window.__m.entry(a), ...${JSON.stringify(patch)} }] }); return true; })()`);
            await waitFor(`document.getElementById('terminal-status-dot').getAttribute('aria-label') === ${JSON.stringify(word)}`, `the dot to say ${word}`, 5000, `document.getElementById('terminal-status-dot').getAttribute('aria-label')`);
            d = await dot();
            assert.equal(d.title, word); assert.match(d.cls, /terminal-status-dot /); assert.ok(!d.headerText.includes(word), `the header draws no "${word}" beside the dot`);
        }
        ok('the name and the tip follow a state change from the live feed (Working, Needs input, Stuck)');

        // no wider screen draws a word: not a touch screen at 900 px. A phone's chat header (<= 600 px) says the state in a word beside the dot (#10885 item 10): header_status_word_browser owns that, so 390 px is not asked here
        await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        for (const w of [900]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile: true }); await sleep(400); // sleep-ok: layout settles after the emulation change
            const x = await dot(); assert.ok(x.noWordElement && !x.headerText.includes(x.label), `${w} px: no word beside the dot`);
        }
        ok('no word beside the dot on a touch screen at 900 px');

        // the accessibility tree: the dot is one image named for the state, the word is not exposed
        await DOM.enable(); await Accessibility.enable();
        const doc = await DOM.getDocument({ depth: -1 });
        const q = async selector => { const { nodeId } = await DOM.querySelector({ nodeId: doc.root.nodeId, selector }); const { nodes } = await Accessibility.getPartialAXTree({ nodeId, fetchRelatives: false }); return nodes[0]; };
        const dn = await q('#terminal-status-dot');
        assert.equal(dn.role.value, 'image'); assert.equal(dn.name.value, 'Stuck');
        ok('in the accessibility tree the dot is an image named "Stuck"');
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        await client.close();
    }
})();
