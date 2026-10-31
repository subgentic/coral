// Add agent to a team on a REMOTE computer (through Coral Hub) keeps the team's folder (#11517, the operator's report): the dialog opens for the remote and starts loading the remote's settings; when they arrive the
// folder fields were reset to the remote's default_working_dir, over the team's folder that showAddAgentFlow had just put in, and the step said "no folder yet". The remote's settings answer after a delay here (the
// order that did it), with a default folder that is not the team's. A folder-less Add agent still gets the remote's default, and a local one is untouched. 1280 and 390. Drives Chrome over CDP through
// agent_view_harness.js against the isolated dev server (the Hub's list and the remote's settings are answered by the page).
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const fs = require('node:fs');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    const TEAM_DIR = '/srv/teams/checkout', REMOTE_DEFAULT = '/home/remote/work';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            // a Hub with one remote computer (id 7), its settings answered after 300 ms with a default folder of its own
            await ev(`(async () => { const { state } = await import(${S} + 'state.js'); state.hub = true; state.servers = [{ id: '7', label: 'Remote Mac', status: 'online', online: true, url: 'http://remote.example' }];
                const real = window.fetch; window.fetch = (u, o) => { const s = String(u); if (/\\/remote\\/7\\/.*api\\/settings/.test(s) || /\\/remote\\/7\\/settings/.test(s)) return new Promise(r => setTimeout(() => r(window.__remoteUnreadable ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ settings: { default_working_dir: '${REMOTE_DEFAULT}' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })), 300)); return real(u, o); }; return true; })()`);
            const open = args => ev(`import(${S} + 'modals.js').then(() => import(${S} + 'launch_dialog.js')).then(m => { m.showAddAgentFlow(${JSON.stringify(args)}); return true; })`); // modals.js builds the dialog's markup, as the page does when a button needs it
            const dirAfter = async () => { await ev(`new Promise(r => setTimeout(r, 1200))`); return ev(`(document.getElementById('launch-dir') || {}).value`); }; // sleep-ok: the remote's answer and the reset after it
            // Add agent to a team on the remote: the team's folder stays
            await open({ board: '7/checkout-team', workDir: TEAM_DIR, server: '7' });
            const kept = await dirAfter();
            check(kept === TEAM_DIR, at + `the team's folder is still the folder after the remote's settings arrive: ${JSON.stringify(kept)}`);
            await ev(`window.closeLaunchModal && window.closeLaunchModal(); true`);
            // through the Hub a remote's settings are not readable (404): its default is empty, and the team's folder must still be the folder, with no "no folder yet" said
            await ev(`window.__remoteUnreadable = true; true`);
            await open({ board: '7/checkout-team', workDir: TEAM_DIR, server: '7' });
            const hubKept = await dirAfter();
            check(hubKept === TEAM_DIR, at + `with the remote's settings unreadable the team's folder is still the folder: ${JSON.stringify(hubKept)}`);
            check(await ev(`!/no folder yet/i.test(document.getElementById('launch-modal').textContent)`), at + 'the dialog does not say "no folder yet"');
            await shot(`add-agent-remote-${w}`);
            await ev(`window.closeLaunchModal && window.closeLaunchModal(); window.__remoteUnreadable = false; true`);
            // Add agent with no folder on the remote: the remote's default, as it always was
            await open({ board: '7/checkout-team', workDir: '', server: '7' });
            const def = await dirAfter();
            check(def === REMOTE_DEFAULT, at + `with no folder the remote's default is the field: ${JSON.stringify(def)}`);
            await ev(`window.closeLaunchModal && window.closeLaunchModal(); true`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('add_agent_remote_folder_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
