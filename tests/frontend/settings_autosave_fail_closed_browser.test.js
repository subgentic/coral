// Settings autosave fails closed (#17364, Security INFO on #17319): a control autosaves only inside a pane that says so (data-autosaves). A new control outside such a pane, in the Chief pane beside its host,
// in the Security pane, or in a pane nobody marked, must not autosave by default. The probe is an empty required field: where autosave runs it answers "Not saved" under the row, where it does not nothing is
// drawn. The control (the same field in the Appearance pane) proves the probe sees autosave. 1280 px, a real isolated server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.showSettingsModal('general')`);
        await waitFor(`document.getElementById('settings-modal')?.style.display === 'flex'`, 'Settings open', 10000);
        await ev(framesJs(2));
        const probe = where => ev(`(async () => {
            const host = ${where}; if (!host) return 'no such place';
            const row = document.createElement('div'); row.className = 'sv-row'; const i = document.createElement('input'); i.type = 'text'; i.required = true; i.id = 'probe-' + Math.random().toString(36).slice(2); i.value = 'a'; row.append(i); host.append(row);
            i.focus(); i.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); i.value = ''; i.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
            await new Promise(r => setTimeout(r, 400));
            const s = row.querySelector('.settings-save-status'); const out = s ? s.textContent : ''; row.remove(); return out; })()`);
        assert.match(await probe(`document.getElementById('settings-pane-general')`), /Not saved/, 'the probe sees autosave in a marked pane (the control)');
        const bad = [];
        for (const [what, where] of [['the Chief pane, beside its host', `document.getElementById('settings-pane-chief')`], ['the Security pane', `document.getElementById('settings-pane-security')`], ['a pane nobody marked', `(() => { let p = document.getElementById('probe-pane'); if (!p) { p = document.createElement('section'); p.id = 'probe-pane'; p.className = 'settings-pane'; document.getElementById('settings-pane-general').after(p); } return p; })()`]]) {
            const r = await probe(where);
            if (r !== '') bad.push(`${what}: autosaved (${JSON.stringify(r)})`);
        }
        assert.deepEqual(bad, [], 'a control with no mark must not autosave:\n  ' + bad.join('\n  '));
    } finally { await client.close(); }
    console.log('PASS autosave fails closed: only marked panes autosave');
})().catch(e => { console.error(e.message || e); process.exit(1); });
