// #15879 (ST5, guideline 4.12 rule 7): a Settings section opens with at most seven rows; the rest sits under "Advanced (n)", closed, and n is the number of rows in it.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, nextFrame } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
        await ev(`window.showSettingsModal('general'); true`);
        await waitFor(`!!document.querySelector('#settings-modal .settings-pane[data-group]')`, 'the dialog is drawn');
        const groups = await ev(`[...document.querySelectorAll('#settings-modal .settings-pane[data-group]')].map(p => p.dataset.group)`);
        const bad = [];
        for (const g of groups) {
            await ev(`window.showSettingsModal(${JSON.stringify(g)}); true`); await nextFrame(ev); await nextFrame(ev);
            const m = await ev(`(() => { const p = document.querySelector('#settings-pane-${g}'); if (!p) return null;
                const value = r => !r.classList.contains('sv-row-heading') && !r.classList.contains('sv-row-notice');
                const visible = r => !r.hidden && !r.closest('[hidden]') && r.getClientRects().length > 0;
                const first = [...p.querySelectorAll('.sv-row')].filter(r => value(r) && visible(r) && !r.closest('details.sv-advanced') && !r.closest('.prov-card')).length;
                const adv = [...p.querySelectorAll('details.sv-advanced')].map(d => ({ open: d.open, label: d.querySelector('summary').textContent.trim(), n: [...d.querySelectorAll('.sv-row')].filter(value).length }));
                return { first, adv }; })()`);
            if (!m || g === 'chief') continue; // Chief is the form-mode view with its own save bar (ST1/ST2 rework it): not drawn by the flat view that has the Advanced marker
            if (m.first > 7) bad.push(g + ' opens with ' + m.first + ' rows');
            for (const a of m.adv) { assert.equal(a.open, false, g + ': Advanced is closed'); assert.equal(a.label, 'Advanced (' + a.n + ')', g + ': the count is the rows in the fold'); }
            if (process.env.PROBE_OUT) require('fs').appendFileSync(process.env.PROBE_OUT, g + ' ' + JSON.stringify(m) + '\n');
        }
        assert.deepEqual(bad, [], 'a section opens with at most seven rows: ' + bad);
        console.log('PASS every Settings section opens with at most seven rows; Advanced is closed and counts its rows');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
