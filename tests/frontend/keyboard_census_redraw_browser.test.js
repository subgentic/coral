// cdp-timeout: 120
// #13784: keyboard_census_desktop_browser failed once on a gate with "7 buttons of the changes list for notes.txt unreachable by Tab" (the retry passed). Cause: the census's data world (helpers/census_world.js) answered
// the Files list's GET with two stand-in rows (src/main.go, docs/README.md) but not its POST /files/refresh, which went to the real server and returned the folder's real file (notes.txt). The panel's watch and
// every follow-up read use the refresh, so at a moment that depends on load the list swapped from the two stand-in rows to notes.txt: a Tab walk that had passed the first rows met a row nobody had reached. The world
// must answer both reads with the same rows. Note: a real Files list can swap while an agent works; this census assumes a stable one, which is why its world pins the rows. Here the panel watches fast and the rows are read for several seconds: they must not change.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { execFileSync } = require('./helpers/child_process');
const { connect } = require('./agent_view_harness');
const { launchStandIn } = require('./helpers/stand_in_agent');
const { guardSettings } = require('./helpers/settings_guard');
const { coralReady } = require('./helpers/wait');
const { DATA_WORLD, httpJson } = require('./helpers/census_world');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await guardSettings(); let standIn = null, work = null;
    try {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'coral-census-r-')); execFileSync('git', ['init', '-q', work]); fs.writeFileSync(path.join(work, 'notes.txt'), 'x\n');
        standIn = await launchStandIn(httpJson, { displayName: 'Census Agent', workingDir: work });
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: 'window.__coralFilesWatchMs = 300;' }); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: DATA_WORLD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); window.selectLiveSession(${JSON.stringify(standIn.name)}, 'claude', ${JSON.stringify(standIn.sid)}, 'local'); true`);
        await waitFor(`!!document.getElementById('changed-files-list')`, 'the list', 20000);
        await ev(`(() => { const l = document.getElementById('changed-files-list'); if (!l.getClientRects().length) document.getElementById('panel-toggle-btn').click(); window.switchAgenticTab('files', 'top'); return true; })()`);
        await waitFor(`document.querySelectorAll('#changed-files-list .file-item').length >= 1`, 'the rows', 15000);
        const names = () => ev(`[...document.querySelectorAll('#changed-files-list .file-item')].map(r => r.dataset.filepath).sort().join(',')`);
        const seen = new Set();
        for (let i = 0; i < 40; i++) { seen.add(await names()); await new Promise(r => setTimeout(r, 150)); } // sleep-ok: reading the list for six seconds while the watch (every 300 ms here) reads it again
        assert.equal(seen.size, 1, 'the Files list swapped between different rows while it was watched: ' + JSON.stringify([...seen]));
        assert.ok(!/notes\.txt/.test([...seen][0]), "the census's data world answers every read of the list: the real folder's notes.txt never shows (" + [...seen][0] + ')');
        console.log('keyboard_census_redraw: the list stayed ' + [...seen][0]);
    } finally {
        if (standIn) await standIn.stop().catch(() => {}); if (work) fs.rmSync(work, { recursive: true, force: true }); await guard.restore().catch(() => {}); await client.close().catch(() => {});
    }
})().catch(e => { console.error(e); process.exit(1); });
