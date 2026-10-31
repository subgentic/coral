// A new install opens on the Inbox (#11443, #11482 gate): a start at the bare address, with the welcome items on, lands on Needs you once per tab, at 1280 and at 390. It is the first URL of the page that
// counts, not the live one (by the time the settings have loaded the app is already on /agents, so the landing never fired). A link to /agents stays on Agents, and with the setting off the start is Agents.
// Real page loads against the isolated dev server (the setting is put on the server and put back).
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const guard = await guardSettings(); // the suite turns inbox_welcome on and off: it is put back as found, or removed if it was not there (--fail-on-leak)
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const put = v => ev(`fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inbox_welcome: '${v}' }) }).then(r => r.status)`);
    const start = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings'); await ev(`new Promise(r => setTimeout(r, 800))`); return ev(`location.pathname`); }; // sleep-ok: the landing is a step after the settings are read
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        try {
            for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
                const at = `${w} px: `;
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
                check(await put('on') === 200, at + 'the setting is put on');
                await ev(`sessionStorage.clear(); true`);
                const landed = await start('/');
                check(landed === '/inbox/needs', at + 'a bare start with welcome items lands on Needs you: ' + landed);
                const again = await start('/'); // the same tab: once only
                check(again === '/agents', at + 'a second start in the same tab opens Agents, as it always did: ' + again);
                await ev(`sessionStorage.clear(); true`);
                const linked = await start('/agents');
                check(linked === '/agents', at + 'a link to /agents stays on Agents: ' + linked);
                await ev(`sessionStorage.clear(); true`);
                check(await put('off') === 200, at + 'the setting is put off');
                const off = await start('/');
                check(off === '/agents', at + 'without welcome items the start is Agents: ' + off);
            }
        } finally { await guard.restore().catch(() => {}); }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('welcome_first_screen_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
