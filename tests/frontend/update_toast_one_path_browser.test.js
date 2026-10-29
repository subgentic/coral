// One way to update (#10834, the operator: the in-app update is very bad): the "Coral X available" notice no longer sends a person to GitHub's download page when Coral takes the update itself.
// Ready (downloaded and checked): no notice, the top bar's Update and relaunch and its ready notice are the way. Coming (it updates itself, the download is not here yet): the notice says Coral will ask,
// with no Download link. Cannot (not enabled, Homebrew): the Download link stays. 1280 px, a stubbed status and check on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const CHECK = { available: true, latest: '9.9.9', current: '1.0.0', release_url: 'https://github.com/subgentic/coral/releases/latest', release_notes: '- Something `new` in the list (#10735, #10787)' };
    const READY = { enabled: true, installed: '1.0.0', state: 'staged', staged: { version: '9.9.9', staged_at: new Date().toISOString(), days_ready: 0, verified: true }, relaunch: { available: true, reason: '', restarts: [], ack: 'a' } };
    const COMING = { enabled: true, installed: '1.0.0', state: 'none', not_ready_reason: 'not_promoted', relaunch: { available: false, reason: 'nothing_staged', restarts: [] } };
    const BREW = { ...COMING, install_kind: 'homebrew', upgrade_command: 'brew upgrade coral' };
    const OFF = { enabled: false };
    const SWITCH_OFF = { ...COMING, not_ready_reason: 'switch_off' }; // automatic checks are off: nothing is on its way
    const APPLY_OFF = { ...COMING, relaunch: { available: false, reason: 'apply_not_enabled', restarts: [] } }; // installing from here is not turned on
    const toast = () => ev(`(() => { const t = document.getElementById('update-toast'); return t ? { text: t.innerText.replace(/\\s+/g, ' ').trim(), download: !!t.querySelector('.update-toast-download') } : null; })()`);
    const run = async status => {
        await ev(`(() => { document.getElementById('update-toast')?.remove(); const R = window.__realFetch || (window.__realFetch = window.fetch.bind(window)); window.fetch = (u, o) => { const p = new URL(String(u), location.href).pathname; const j = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })); if (p === '/api/system/update-check') return j(${JSON.stringify(CHECK)}); if (p === '/api/system/update') return j(${JSON.stringify(status)}); return R(u, o); }; return true; })()`);
        await ev(`window.checkForUpdates(true); true`);
        await new Promise(r => setTimeout(r, 1200)); // sleep-ok: the check, the status and the notice
        return toast();
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        assert.equal(await run(READY), null, 'ready: no second notice with a GitHub link');
        const coming = await run(COMING);
        assert.ok(coming && !coming.download && /will ask before it installs/.test(coming.text), 'coming: no Download link, it says Coral will ask: ' + JSON.stringify(coming));
        assert.ok(coming && /Something new in the list/.test(coming.text) && !/#\d|`/.test(coming.text), 'the notes are plain words: no task numbers, no backticks: ' + JSON.stringify(coming));
        for (const [name, st] of [['off', OFF], ['homebrew', BREW], ['automatic checks off', SWITCH_OFF], ['apply not enabled', APPLY_OFF]]) { const t = await run(st); assert.ok(t && t.download, `${name}: the Download link stays: ` + JSON.stringify(t)); }
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
