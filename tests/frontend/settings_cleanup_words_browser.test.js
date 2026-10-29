// Settings > Storage and cleanup (#7041, UI/UX's #7036 finding 5): "Automatic cleanup [0] days [Saved diffs]" never said that 0 is off, and its select looked live while it did nothing; the two
// selects (what Free space prunes, what Automatic cleanup prunes) were named only for a screen reader, so a sighted person read "Saved diffs" with no question. Now: 0 reads "Off" and the kind
// select is off with it; each select has a visible label, and the cleanup's days field says "Older than". Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`window.showSettingsModal('cleanup').then(() => true)`); // the dialog is shown at the end of this, after awaited requests: the retention field's loaded flag can come first, and its labels have no boxes until the dialog is shown (Windows CI, #7282)
            await waitFor(`document.getElementById('settings-modal').getClientRects().length > 0`, 'the settings dialog shown', 10000);
            await waitFor(`document.getElementById('settings-retention-enabled') && document.getElementById('settings-retention-enabled').dataset.loaded === '1'`, 'automatic cleanup loaded', 10000);
            const tag = `${w} px`;
            const off = await ev(`(() => ({ status: document.getElementById('settings-retention-status').textContent.trim(), on: document.getElementById('settings-retention-enabled').checked, pairs: document.querySelectorAll('#settings-pane-cleanup [id$="-days"]:not(#settings-artifact-store-max)').length }))()`);
            assert.equal(off.on, false, `${tag}: the hourly prune starts off`);
            
            assert.equal(off.status, 'Prunes what is older than the days above, once an hour.', `${tag}: off says what the switch does`);
            assert.equal(off.pairs, 1, `${tag}: one Older than field serves Prune and the hourly run`);
            await ev(`(() => { const d = document.getElementById('settings-prune-days'); d.value = '7'; const c = document.getElementById('settings-retention-enabled'); c.click(); return true; })()`);
            assert.ok(!/^Prunes what is older/.test(await ev(`document.getElementById('settings-retention-status').textContent.trim()`)), `${tag}: on at 7 days says it is on, not what the switch does`);
            assert.match(await ev(`document.getElementById('settings-retention-status').textContent.trim()`), /7 days/, `${tag}: it says the days`);
            // each control says what it is where a person can see it
            for (const id of ['settings-prune-days', 'settings-prune-kind', 'settings-retention-enabled']) {
                const labelled = await ev(`(() => { const c = document.getElementById('${id}'); return [...c.labels, ...(c.getAttribute('aria-labelledby') || '').split(' ').map(i => document.getElementById(i)).filter(Boolean)].filter(l => l.getClientRects().length && l.textContent.trim()).map(l => l.textContent.trim().replace(/\\s+/g, ' ')); })()`);
                assert.ok(labelled.length > 0, `${tag}: #${id} has a visible label: ` + JSON.stringify(labelled));
                if (id === 'settings-prune-days') assert.ok(labelled.some(t => /older than/i.test(t)), `${tag}: the days say "Older than": ` + JSON.stringify(labelled));
                if (id.endsWith('-kind')) assert.ok(labelled.some(t => /what to prune/i.test(t)), `${tag}: #${id} is labelled "What to prune": ` + JSON.stringify(labelled));
                if (id === 'settings-retention-enabled') assert.ok(labelled.some(t => /every hour/i.test(t)), `${tag}: the switch says every hour: ` + JSON.stringify(labelled));
            }
        }
        console.log('PASS settings cleanup words');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
