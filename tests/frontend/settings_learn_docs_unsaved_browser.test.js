// Settings > Learn more with a change not saved yet (#10906, QA's review): Settings asks first. Discard changes: Settings closes and the person lands on the answer in Docs, as they pressed the link to do (they cannot press it again:
// the dialog is gone). Keep editing: Settings stays, nothing is opened, and nothing is left waiting to scroll a Docs page the person opens by hand later. 1280 px, a real isolated server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const guard = await require('./helpers/settings_guard').guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`, ANSWER = 'What the permission modes allow';
    const problems = [];
    const open = async () => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`import(${MOD} + 'state.js').then(async s => { const d = await fetch('/api/settings').then(r => r.json()); s.state.settings = d.settings; return import(${MOD} + 'modals.js'); }).then(m => m.showSettingsModal('agents')).then(() => true)`);
        await waitFor(`!!document.getElementById('settings-permission-mode') && document.getElementById('settings-permission-mode').getClientRects().length > 0`, 'the permission row', 10000);
        await ev(`(() => { const s = document.getElementById('settings-permission-mode'); s.value = s.value === 'plan' ? 'default' : 'plan'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await ev(`document.getElementById('settings-permission-mode').closest('.sv-row').querySelector('a.sv-learn').click(); true`);
        await waitFor(`!!document.getElementById('confirm-modal') && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'Settings asks before it closes', 6000);
    };
    const press = label => ev(`[...document.querySelectorAll('#confirm-modal .modal-actions .btn')].find(b => b.getClientRects().length && b.textContent.trim() === ${JSON.stringify(label)}).click(); true`);
    const answerAt = () => ev(`(() => { const h = [...document.querySelectorAll('#docs-content h2')].find(e => e.textContent.trim() === ${JSON.stringify(ANSWER)}); return h ? { inView: h.getBoundingClientRect().top >= 0 && h.getBoundingClientRect().bottom <= innerHeight, focused: document.activeElement === h } : null; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await open(); await press('Discard changes');
        try { await waitFor(`location.pathname === '/docs/how-do-i' && [...document.querySelectorAll('#docs-content h2')].some(h => h.textContent.trim() === ${JSON.stringify(ANSWER)}) && getComputedStyle(document.getElementById('settings-modal')).display === 'none'`, 'Discard: the answer opens in Docs', 6000); }
        catch (e) { problems.push('after Discard changes the person is not taken to the answer in Docs: ' + JSON.stringify(await ev(`({ path: location.pathname, settings: getComputedStyle(document.getElementById('settings-modal')).display !== 'none' })`))); }
        const d = await answerAt(); if (d && !(d.inView && d.focused)) problems.push('Discard: the answer heading is not in view and focused: ' + JSON.stringify(d));
        await open(); await press('Keep editing');
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: nothing may happen
        if (await ev(`location.pathname === '/docs/how-do-i'`)) problems.push('Keep editing opened Docs');
        if (await ev(`getComputedStyle(document.getElementById('settings-modal')).display === 'none'`)) problems.push('Keep editing closed Settings');
        // later, Docs opened by hand starts at its top: nothing was left waiting from the link that was not followed
        await ev(`import(${MOD} + 'docs_answer.js').then(m => m.takeDocsAnswer())`).then(w => { if (w) problems.push(`Keep editing left "${w}" waiting for the next Docs page to scroll to`); });
    } finally { await client.close(); await guard.restore?.(); }
    assert.deepEqual(problems, [], 'Settings > Learn more with unsaved changes:\n  ' + problems.join('\n  '));
    console.log('PASS Learn more with unsaved changes: Discard lands on the answer, Keep editing leaves nothing behind');
})().catch(e => { console.error(e); process.exit(1); });
