// Coral Hub links in Settings > Coral Hub and remote access (#20704, from the two-Hub walk #20701 F1 and F2). The second link stays off on main, so the routes are stood in at the page's fetch:
//   F1: this computer's own connection is down but a Hub is still linked (the first link was removed): the card says where the links are and offers 'Add a Hub', not 'Connect to Coral Hub' as if none were linked;
//   with no link at all it is as before. F2: each link row names the Hub by its address, as text (a Hub on a private network is plain http), never 'a Hub'; an address that is not a bare origin is not shown as one.
// 1280 px, light theme; the screenshots go to CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const LINK_B = { link_id: 'lnk-0000000b', hub_origin: 'https://hub-b.example.com', label: 'bob', state: 'active', max_mode: 'interact' };
const LINK_C = { link_id: 'lnk-0000000c', hub_origin: 'http://127.0.0.1:8081', label: '', state: 'active', max_mode: 'view' };
const LINK_X = { link_id: 'lnk-0000000d', hub_origin: 'https://h.example.com/<b>x</b>', label: '', state: 'active', max_mode: 'view' };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const text = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
    const set = async (st, links) => { await ev(`(async () => { window.__st = ${JSON.stringify(st)}; window.__links = ${JSON.stringify(links)}; const p = document.getElementById('settings-cloud')._cloudPanel; p.linksAt = 0; await window.__cc.loadCloudStatus(); await p.loadLinks(); return true; })()`); };
    const rows = () => ev(`[...document.querySelectorAll('#settings-cloud-links .settings-cloud-link-name')].map(n => n.textContent)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(async () => {
            await window.__coral.buildAllLazy(); const real = window.fetch;
            window.__st = { configured: true, state: 'idle', hub_url: 'https://hub.example', max_mode: 'view', max_mode_saved: false, allow_hub_auto_accept: true, redact_tokens: true, hub_cross_team_settings: true }; window.__links = [];
            const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
            window.fetch = async (url, opts = {}) => { const u = String(url);
                if (u.endsWith('/api/cloud/status')) return json(window.__st);
                if (u.endsWith('/api/cloud/links')) return json({ links: window.__links, max_links: 3, adding: [] });
                if (u.includes('/api/system/hub-operator')) return json({ linked: false, disabled: false });
                if (u.includes('/api/auth/setup-code/show')) return json({ error: 'none' }, 409);
                return real(url, opts); };
            const cc = await import(${S} + 'cloud_connect.js'); window.__cc = cc; cc.initCloudConnect(); await cc.loadCloudStatus();
            await window.showSettingsModal('network');
            return true; })()`);
        await waitFor(`document.getElementById('settings-pane-network') && !document.getElementById('settings-pane-network').hidden && /Ready to connect/.test(document.getElementById('settings-cloud-status').textContent)`, 'the idle card with no link', 8000);
        await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none' && document.getElementById('settings-cloud-connect').getClientRects().length > 0`, 'Settings on screen', 8000);

        // no link at all: as before
        assert.equal(await text('#settings-cloud-connect'), 'Connect to Coral Hub', 'no link: the button offers to connect');
        assert.match(await text('#settings-cloud-status'), /^Ready to connect to https:\/\/hub\.example/, 'no link: the status is as before');

        // F1: the first link is gone, Hub B is still linked
        await set({ ...(await ev(`window.__st`)) }, [LINK_B]);
        await ev(`document.getElementById('settings-cloud').scrollIntoView({ block: 'start' }); true`);
        await shot('hub-links-after-first-removed');
        await waitFor(`document.getElementById('settings-cloud-connect').textContent === 'Add a Hub'`, 'the button says Add a Hub while a Hub is linked', 6000);
        assert.equal(await text('#settings-cloud-status'), 'This computer is linked to one Coral Hub, listed below.', 'the status says where the link is');
        assert.equal(await text('#settings-pane-network .settings-editions-btn'), 'Add a Hub…', 'the Status group offers the same');
        assert.equal(await ev(`!document.getElementById('settings-cloud-links').hidden`), true, 'the link list is on screen');
        assert.deepEqual(await rows(), ['bob · https://hub-b.example.com · Linked'], 'F2: the row names the Hub by its address');

        // F2: addresses as text: a private-network Hub is shown, an address with markup in it is not an address (and is never markup)
        await set(await ev(`window.__st`), [LINK_B, LINK_C, LINK_X]);
        const names = await rows();
        assert.deepEqual(names, ['bob · https://hub-b.example.com · Linked', 'http://127.0.0.1:8081 · Linked', 'a Hub · Linked'], 'F2: each row says which Hub; only a bare origin is an address');
        assert.equal(await ev(`document.querySelectorAll('#settings-cloud-links b, #settings-cloud-links a').length`), 0, 'nothing from a Hub is markup or a link');
        assert.equal(await text('#settings-cloud-status'), 'This computer is linked to 3 Coral Hubs, listed below.');

        // the last link removed: back to Connect
        await set(await ev(`window.__st`), []);
        await waitFor(`document.getElementById('settings-cloud-connect').textContent === 'Connect to Coral Hub'`, 'no link left: Connect again', 6000);
        assert.match(await text('#settings-cloud-status'), /^Ready to connect/);
        assert.equal(await ev(`document.getElementById('settings-cloud-links').hidden`), true);
        assert.equal(await text('#settings-pane-network .settings-editions-btn'), 'Connect to Coral Hub…');
        console.log('PASS Settings says where the Hub links are when this computer\'s own connection is down, offers Add a Hub, and names each Hub by its address');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
