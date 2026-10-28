// Light, Dark or System under the gear (#10049, the desktop tester: the theme was two clicks away and the menu item said Themes, which looks like a settings page): the gear menu's first item is the choice
// of Light, Dark or System, the same setting as Settings > General > Theme (not a new one), the colour editor is behind Customize, and a first run with nothing saved follows the browser (System), not Dark.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { settle } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');

(async () => {
    const { client, Page, Emulation, ev, waitFor, install } = await connect();
    const guard = await guardSettings(); // the theme this suite saves is put back
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const media = v => Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: v }] });
    const theme = () => ev(`document.documentElement.getAttribute('data-theme')`);
    const saved = () => ev(`fetch('/api/settings').then(r => r.json()).then(j => { const s = j.settings || j; return [s.theme || '', s.custom_theme || '']; })`);
    const GROUP = '#top-bar-settings-menu [role=group][aria-label="Theme"]';
    const choice = () => ev(`(() => { const g = document.querySelector('${GROUP}'); return g ? [...g.querySelectorAll('[role=menuitemradio]')].map(b => [b.textContent.trim(), b.getAttribute('aria-checked')]) : null; })()`);
    try {
        await Page.enable();
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        console.log('1. A first run with nothing saved follows the browser');
        await media('light');
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired();
        await ev(`localStorage.removeItem('coral-theme'); true`);
        await ev(`fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: '', custom_theme: '' }) }).then(() => true)`);
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        assert.equal(await theme(), 'light', 'a light browser and nothing saved: the page is light');
        await media('dark'); await settle(ev, 300); // sleep-ok: the page follows the browser's change
        assert.equal(await theme(), 'dark', 'and dark when the browser is dark: it follows it');

        console.log('2. The gear menu opens on the choice');
        await ev(`document.querySelector('button[aria-label="Settings menu"]').click(); true`);
        await waitFor(`!!document.querySelector('${GROUP}')`, 'the theme choice in the gear menu', 6000);
        assert.deepEqual(await choice(), [['Light', 'false'], ['Dark', 'false'], ['System', 'true']], 'Light, Dark and System, System chosen on a first run');
        assert.equal(await ev(`(() => { const m = document.querySelector('#top-bar-settings-menu'); const first = [...m.children].find(e => e.getClientRects().length); return first === document.querySelector('${GROUP}') || first.contains(document.querySelector('${GROUP}')); })()`), true, 'it is the first thing in the menu');
        assert.ok(await ev(`[...document.querySelectorAll('#top-bar-settings-menu .menu-item')].some(b => b.textContent.trim() === 'Customize theme')`), 'the colour editor is behind Customize theme');
        assert.ok(!await ev(`[...document.querySelectorAll('#top-bar-settings-menu .menu-item')].some(b => b.textContent.trim() === 'Themes')`), 'and there is no longer an item called Themes');
        await shot('gear-menu-theme-dark');

        console.log('3. Choosing Light is the setting, saved');
        await ev(`[...document.querySelectorAll('${GROUP} [role=menuitemradio]')].find(b => b.textContent.trim() === 'Light').click(); true`);
        await settle(ev, 400); // sleep-ok: the choice is applied and saved
        assert.equal(await theme(), 'light', 'the page is light now, whatever the browser says');
        assert.deepEqual(await saved(), ['light', ''], 'it is the same setting Settings > General > Theme reads');
        await ev(`if (document.querySelector('#top-bar-settings-menu').style.display === 'none') document.querySelector('button[aria-label="Settings menu"]').click(); true`); await settle(ev, 200); // sleep-ok: the menu is open to look at
        assert.deepEqual(await choice(), [['Light', 'true'], ['Dark', 'false'], ['System', 'false']], 'the menu shows Light chosen');
        await shot('gear-menu-theme-light');

        console.log('4. Choosing System follows the browser again');
        await ev(`[...document.querySelectorAll('${GROUP} [role=menuitemradio]')].find(b => b.textContent.trim() === 'System').click(); true`);
        await settle(ev, 400); // sleep-ok: the choice is applied and saved
        assert.equal(await theme(), 'dark', 'the browser is dark: System is dark');
        assert.deepEqual(await saved(), ['system', '']);
        console.log('PASS the gear menu has Light, Dark and System first, the same setting, and a first run follows the browser');
    } finally { await Emulation.setEmulatedMedia({ features: [] }); await ev(`localStorage.removeItem('coral-theme'); true`).catch(() => {}); await guard.restore(); await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
