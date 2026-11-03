// The theme editor and the default prompts follow the written rules (#12897, from #12888 F6): sentence case in their words, and ONE primary action in the editor's footer (Save and apply), Preview a quiet button.
// At 1440 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`Promise.resolve(window.showThemeConfigurator()).then(() => true)`);
            await waitFor(`!!document.querySelector('#theme-configurator-modal .theme-save-bar')`, `${tag}: the theme editor`, 8000);
            const ed = await ev(`(() => { const m = document.getElementById('theme-configurator-modal'); const q = s => [...m.querySelectorAll(s)];
                return { title: m.querySelector('h3').textContent.trim(), foot: q('.modal-actions .btn').map(b => ({ t: b.textContent.trim(), primary: b.classList.contains('btn-primary') })) }; })()`);
            check(`${tag}: the editor's title is in sentence case`, ed.title === 'Customize theme', ed.title);
            check(`${tag}: its footer is Cancel, Reset, Preview, Save and apply`, JSON.stringify(ed.foot.map(b => b.t)) === JSON.stringify(['Cancel', 'Reset', 'Preview', 'Save and apply']), JSON.stringify(ed.foot));
            check(`${tag}: exactly one primary, the last: Save and apply`, ed.foot.filter(b => b.primary).length === 1 && ed.foot[ed.foot.length - 1].primary, JSON.stringify(ed.foot));
            const words = await ev(`[...document.querySelectorAll('#theme-configurator-modal button, #default-prompts-modal button, .settings-theme-btn')].map(b => b.textContent.trim()).filter(Boolean)`);
            check(`${tag}: no button in the editor says Title Case`, words.every(t => !/^[A-Z][a-z]+ [A-Z][a-z]+/.test(t)), JSON.stringify(words));
            const tpl = await ev(`fetch('/').then(r => r.text()).then(t => (t.match(/Reset to [A-Za-z]+<\\/button>/g) || []).concat(t.match(/Edit [Dd]efault [Pp]rompts/g) || []))`);
            check(`${tag}: the default prompts say Reset to default and Edit default prompts`, tpl.length >= 5 && tpl.every(t => /Reset to default<|Edit default prompts/.test(t)), JSON.stringify(tpl));
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} theme dialog rule checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
