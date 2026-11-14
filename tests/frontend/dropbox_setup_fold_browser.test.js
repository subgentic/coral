// #15882 (ST8): the Dropbox backup is a block of its own and its set-up (what to back up, how long to keep, free up space) is one closed fold. The status, the counts and the edits switch stay in the block.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, nextFrame } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            const tag = w + ' px';
            await ev(`window.showSettingsModal('cleanup'); true`);
            await waitFor(`!!document.getElementById('settings-dropbox')`, tag + ': the block is drawn', 8000);
            await waitFor(`!/Loading/.test(document.getElementById('settings-dropbox-status').textContent)`, tag + ': the status has read Dropbox', 8000); // (it hides the backup part until then)
            await ev(`document.querySelectorAll('#settings-pane-cleanup details.sv-advanced').forEach(d => { d.open = true; }); document.getElementById('settings-dropbox-backup').hidden = false; true`); // as when connected
            await nextFrame(ev); await nextFrame(ev);
            const m = await ev(`(() => { const b = document.getElementById('settings-dropbox'), f = document.getElementById('settings-dropbox-setup'), vis = id => { const e = document.getElementById(id); return !!e && e.checkVisibility(); };
                return { fold: !!f && f.tagName === 'DETAILS', open: f && f.open, summary: f && f.querySelector('summary').textContent.trim(), inFold: id => 0,
                    counts: vis('settings-dropbox-backup'), autosync: vis('settings-dropbox-autosync'), types: vis('settings-dropbox-types'), age: vis('settings-dropbox-age'), keep: vis('settings-dropbox-keep-for'), offload: vis('settings-dropbox-offload-for'),
                    ruled: getComputedStyle(b).borderTopWidth, nested: ['settings-dropbox-types', 'settings-dropbox-age', 'settings-dropbox-keep-for', 'settings-dropbox-offload-for'].every(id => !!f && f.contains(document.getElementById(id))), counts_in: f ? f.contains(document.getElementById('settings-dropbox-counts')) || f.contains(document.getElementById('settings-dropbox-autosync')) : null }; })()`);
            assert.equal(m.fold, true, tag + ': the set-up is a fold'); assert.equal(m.open, false, tag + ': closed by default'); assert.equal(m.summary, 'Backup set-up');
            assert.equal(m.nested, true, tag + ': what to back up, how old, how long to keep and free up space are inside it'); assert.equal(m.counts_in, false, tag + ': the counts and the edits switch are not');
            assert.deepEqual([m.counts, m.autosync], [true, true], tag + ': the counts and the edits switch show with the fold closed');
            assert.deepEqual([m.types, m.age, m.keep, m.offload], [false, false, false, false], tag + ': the set-up fields wait behind the fold');
            assert.equal(m.ruled, '1px', tag + ': the block has a rule above it');
            await ev(`document.getElementById('settings-dropbox-setup').open = true; true`); await nextFrame(ev);
            assert.deepEqual(await ev(`['settings-dropbox-types', 'settings-dropbox-age', 'settings-dropbox-keep-for', 'settings-dropbox-offload-for'].map(id => document.getElementById(id).checkVisibility())`), [true, true, true, true], tag + ': opened, the fields show');
        }
        console.log('PASS the Dropbox backup is its own block with its set-up folded');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
