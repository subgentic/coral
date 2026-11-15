// #17538: Settings > Storage shows the data folder path with a Copy button so the operator can back it up locally.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const settle = ms => new Promise(r => setTimeout(r, ms));
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);

        // open Settings > Storage and cleanup
        await ev(`window.showSettingsModal('cleanup'); true`);
        await settle(1500);

        // the local backup section should be visible with the data dir path
        const backup = await ev(`(() => {
            const el = document.getElementById('settings-local-backup');
            if (!el || el.hidden) return null;
            const code = el.querySelector('code');
            const btn = el.querySelector('button');
            const note = el.querySelector('p');
            return { path: code?.textContent || '', btnText: btn?.textContent || '', note: note?.textContent || '' };
        })()`);
        assert.ok(backup, 'the local backup section is visible');
        assert.ok(backup.path.length > 0, 'the data folder path is shown');
        assert.ok(backup.path.includes('.coral') || backup.path.includes('coral'), 'the path looks like a Coral data folder');
        assert.equal(backup.btnText, 'Copy path', 'the Copy path button is present');
        assert.match(backup.note, /back up.*copy.*folder/i, 'the note explains how to back up');

        // the heading exists
        const heading = await ev(`(() => {
            const h = document.getElementById('settings-local-backup-title');
            return h ? h.textContent : null;
        })()`);
        assert.ok(heading, 'the Local backup heading exists');
        assert.match(heading, /local backup/i, 'the heading says Local backup');

        console.log('PASS Settings > Storage: local backup section (#17538)');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
