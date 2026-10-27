// Settings groups are headed the same way and use one control per choice (#9490, #9478 items 7, 8 and 9): every group of more than five rows is cut into headed parts (Terminal: Display and Backend; Files and Git: File search and Git;
// Security: Access and Data and privacy; the groups that already had sub-headings keep them); the terminal backend is a select, not the only radio buttons in the product; and a fact in Security ("Password set") is a word, not a chip
// (no pill border or fill). Every group, 1280 and 390, light and dark, with shots of Terminal, Files and Security. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    const S = `(window.__coralStatic || '/static/')`;
    const theme = t => ev(`(async () => { const m = await import(${S} + 'settings_core.js'); m.clearCustomThemeVars(); m.applyTheme('${t}'); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`(async () => { await window.showSettingsModal('terminal'); return true; })()`);
            await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none' && !!document.getElementById('tb-choice')`, `${at}Settings`, 10000);
            await new Promise(r => setTimeout(r, 800)); // sleep-ok: the groups fill from several answers
            const r = await ev(`(() => { const out = {}; for (const pane of document.querySelectorAll('#settings-modal .settings-pane[data-group]')) { const rows = [...pane.querySelectorAll('.sv-row')].filter(x => !x.classList.contains('sv-row-heading') && x.querySelector('input, select, textarea, button')); const heads = pane.querySelectorAll('.sv-heading, .sv-subheading, h3, h4, h5'); out[pane.dataset.group] = { rows: rows.length, heads: heads.length, text: [...heads].map(x => x.textContent.trim()).slice(0, 6) }; }
                const sel = document.getElementById('tb-choice'); return { panes: out, radios: document.querySelectorAll('#settings-modal input[type=radio]').length, tbTag: sel && sel.tagName, tbOptions: sel ? [...sel.options].map(o => o.textContent.trim()) : null }; })()`);
            assert.equal(r.radios, 0, `${at}no radio button in Settings`);
            assert.equal(r.tbTag, 'SELECT', `${at}the terminal backend is a select`);
            for (const [name, p] of Object.entries(r.panes)) if (p.rows > 5) assert.ok(p.heads >= 1, `${at}${name}: ${p.rows} rows and a sub-heading each part: ` + JSON.stringify(p));
            for (const g of ['terminal', 'files', 'security']) {
                await ev(`(async () => { await window.showSettingsModal(${JSON.stringify(g)}); return true; })()`); await new Promise(r => setTimeout(r, 600)); // sleep-ok: the group draws
                const heads = await ev(`[...document.querySelectorAll('#settings-pane-${g} :is(h3, h4, h5, .sv-heading, .sv-subheading)')].filter(e => e.getClientRects().length).map(e => e.textContent.trim())`);
                const want = { terminal: ['Display', 'Backend'], files: ['File search', 'Git'], security: ['Access', 'Data and privacy'] }[g];
                for (const t of want) assert.ok(heads.includes(t), `${at}${g}: headed "${t}": ` + JSON.stringify(heads));
                if (g === 'security') {
                    const fact = await ev(`(() => { const e = document.querySelector('#settings-modal .tb-now'); if (!e) return null; const c = getComputedStyle(e); return { text: e.textContent.trim(), border: c.borderTopWidth, bg: c.backgroundColor, radius: c.borderTopLeftRadius }; })()`);
                    if (fact) assert.ok(/^(Password set|No password)$/.test(fact.text) && fact.border === '0px' && fact.bg === 'rgba(0, 0, 0, 0)', `${at}a fact is a word, not a chip: ` + JSON.stringify(fact));
                }
                for (const t of ['dark', 'light']) { await theme(t); await new Promise(r => setTimeout(r, 450)); await shot(`settings-${g}-${t}-${w}`); } // sleep-ok: the theme's colour transition settles
            }
        }
        console.log('PASS settings headed: every long group has headed parts, no radio buttons, a fact is not a chip');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
