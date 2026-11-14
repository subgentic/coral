// UI audit #5589, fifth batch (findings 18 and 20), on the real server and dialog, at 1280 and 390 px:
//   18  Settings > Agents reads in groups: the defaults (permission mode, folder, thinking), the models (default, custom), the
//       switches, and last the CLI paths;
//   20  Settings > Storage and cleanup: the unit of a limit is beside its field, not in its label, and is read with it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async (name, w) => { if (!process.env.CORAL_SCREENSHOT_DIR) return; fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); await new Promise(r => setTimeout(r, 300)); // sleep-ok: a screenshot settles layout, there is no event for it
        fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            const open = async group => { await ev(`(async () => { await window.showSettingsModal(${JSON.stringify(group)}); return true; })()`); await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none'`, 'Settings'); };

            console.log(`1. (${w}) Providers: a card each, model, thinking, then the Advanced fold; Agents: defaults, then the switches`);
            await open('providers');
            const rowNames = pane => ev(`[...document.querySelectorAll('#settings-pane-${pane} .sv-row, #settings-pane-${pane} .prov-card-title')].map(r => { const c = (r.querySelector('.sv-label, .sv-heading, dt label, dt') || (r.matches('.prov-card-title') ? r : document.createElement('i'))).cloneNode(true); return c.textContent.trim().replace(/\\s+/g, ' ').slice(0, 40); })`).then(l => l.filter(Boolean)); // fields, headings, card titles and the live parts, in page order
            const prov = await rowNames('providers');
            const rows = ['Default model', 'Default thinking', 'Orchestrator model', 'Orchestrator thinking', 'CLI path'];
            const want = ['Claude', ...rows, 'Codex', ...rows, 'Antigravity', ...rows, 'Pi', ...rows];
            assert.deepEqual(prov.slice(0, want.length), want, JSON.stringify(prov)); assert.ok(prov.includes('Custom models'), 'Custom models follow the cards');
            await open('agents');
            const names = await rowNames('agents');
            assert.deepEqual(names.slice(0, 4), ['Custom permission modes', 'Defaults', 'Default permission mode', 'Default working directory'], 'Agents opens with the defaults, no model or CLI rows: ' + JSON.stringify(names));
            assert.ok(names.includes('Behaviour') && !names.some(n => /CLI path$|Orchestrator|default thinking$/i.test(n)), 'the switches follow, the provider rows are gone: ' + JSON.stringify(names));
            await open('providers');
            await ev(`(() => { for (const id of ['settings-cli-path-claude', 'settings-cli-path-codex', 'settings-cli-path-agy', 'settings-cli-path-pi']) { const e = document.getElementById(id); if (e) e.value = ''; } return true; })()`); // for the picture only (the dialog is closed unsaved): the test server's own folders are not shown
            await shot('agents-order', w);
            await ev(`window.hideSettingsModal(true); true`); // the folders above were edited for the picture: this close discards them

            console.log(`2. (${w}) Storage: the unit beside its field, read with it`);
            await open('cleanup');
            const st = await ev(`['settings-artifact-store-max', 'settings-received-max'].map(id => { const i = document.getElementById(id); const u = i.closest('.sv-control').querySelector('.sv-unit'); const l = document.querySelector('label[for=' + id + ']').textContent.trim(); const ir = i.getBoundingClientRect(), ur = u.getBoundingClientRect();
                return { id, label: l, unit: u.textContent, described: (i.getAttribute('aria-labelledby') || '').split(' ').includes(u.id), beside: ur.left >= ir.right - 1 && Math.abs((ur.top + ur.height / 2) - (ir.top + ir.height / 2)) < 20, w: Math.round(ir.width) }; })`);
            assert.deepEqual(st.map(x => [x.label, x.unit]), [['Artifact store limit', 'GiB'], ['Received files limit', 'GiB']], JSON.stringify(st));
            assert.ok(st.every(x => x.described && x.beside && x.w <= 120), 'unit described, beside, field not full width: ' + JSON.stringify(st));
            await shot('storage-units', w);
            await ev(`window.hideSettingsModal(); true`);
        }
        console.log('   ✓');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
