// Settings opens on Basics (#10114, Desktop tester #10113): Theme, the update notice, the default permission mode and models, notifications, the phone's remote access and setup code, the password and usage
// analytics; the rest is one click away behind Advanced, in its own panes and rows (nothing removed), and a group asked for by name turns Advanced on. 1280 and 390 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page, 'settings-basics');
    const open = async group => { await ev(`window.hideSettingsModal && window.hideSettingsModal(); true`); await ev(`(async () => { await window.showSettingsModal(${group ? JSON.stringify(group) : ''}); return true; })()`); await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none' && !!document.querySelector('#settings-pane-agents [data-key]') && !!document.querySelector('#settings-pane-general [data-level]')`, 'Settings with its rows drawn and tagged', 8000); };
    const tabs = () => ev(`[...document.querySelectorAll('#settings-tabs [role=tab]')].filter(t => !t.hidden && getComputedStyle(t).display !== 'none').map(t => t.querySelector('.settings-tab-name').textContent.trim())`);
    const visibleKeys = async pane => { await ev(`document.getElementById('settings-tab-${pane}').click(); true`); await waitFor(`!document.getElementById('settings-pane-${pane}').hidden`, 'the pane ${pane}'); return ev(`[...document.querySelectorAll('#settings-pane-${pane} [data-key]')].filter(e => e.getClientRects().length).map(e => e.dataset.key)`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `try { localStorage.removeItem('coral-settings-advanced'); } catch (e) {}` }); // after the harness's own, which turns Advanced on for the suites that walk every setting
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);

        console.log('1. Settings opens on the short list');
        await open();
        const t = await tabs();
        assert.ok(t.includes('General') && t.includes('Agents') && t.includes('Notifications') && t.includes('Network and Hub') && t.includes('Security and privacy'), 'the Basic sections: ' + t);
        for (const hidden of ['Terminal', 'Files and Git', 'Storage and cleanup']) assert.ok(!t.includes(hidden), `${hidden} is behind Advanced: ${t}`);
        assert.deepEqual(await visibleKeys('general'), ['theme', 'check_updates'], 'General has Theme and the update notice');
        const agents = await visibleKeys('agents');
        for (const k of ['permission_mode', 'default_model_claude']) assert.ok(agents.includes(k), `${k} is a Basic row: ${agents}`);
        for (const k of ['working_dir', 'cli_path_claude', 'auto_resume', 'codex_trust_hooks']) assert.ok(!agents.includes(k), `${k} is Advanced: ${agents}`);
        assert.deepEqual(await visibleKeys('notifications'), ['notify_needs_input', 'desktop_notify'], 'notifications are all Basic');
        const sec = await visibleKeys('security'); assert.ok(sec.includes('telemetry_enabled') && sec.includes('live_settings-security') && !sec.includes('api_key') && !sec.includes('install_id'), 'password and analytics: ' + sec);
        const net = await visibleKeys('network'); assert.ok(net.includes('remote_access') && !net.includes('net_status_title') && !net.includes('live_about-section') && !net.includes('net_hub_title') && !net.includes('hub_mode'), 'remote access (its setup code shows once it is on), not Status or Hub: ' + net);
        assert.equal(await ev(`document.querySelector('.settings-advanced-toggle').getAttribute('aria-expanded')`), 'false');
        await shot('basics-1280');

        console.log('2. Advanced shows all of it, and nothing was removed');
        await ev(`document.querySelector('.settings-advanced-toggle').click(); true`); await waitFor(`document.getElementById('settings-modal').hasAttribute('data-advanced') && !!document.querySelector('#settings-tab-terminal') && !document.querySelector('#settings-tab-terminal').hidden`, 'Advanced on');
        const all = await tabs();
        for (const name of ['Terminal', 'Files and Git', 'Storage and cleanup']) assert.ok(all.includes(name), `${name} is there with Advanced on: ${all}`);
        assert.ok((await visibleKeys('general')).includes('show_scrollbars'), 'a General row comes back');
        assert.match(await ev(`document.querySelector('.settings-advanced-toggle').textContent`), /Fewer settings/);
        await shot('advanced-1280');

        console.log('3. it is remembered, and a group asked for by name turns it on');
        await ev(`document.querySelector('.settings-advanced-toggle').click(); true`); await waitFor(`!document.getElementById('settings-modal').hasAttribute('data-advanced') && document.querySelector('#settings-tab-terminal').hidden`, 'back on Basics');
        assert.ok(!(await tabs()).includes('Terminal'), 'back on Basics');
        await open('terminal');
        assert.ok((await tabs()).includes('Terminal'), 'asking for Terminal turned Advanced on');
        assert.equal(await ev(`document.querySelector('#settings-pane-terminal').hidden`), false, 'and showed it');

        console.log('4. a phone: the list of sections is short too');
        await ev(`document.querySelector('.settings-advanced-toggle').click(); true`); // back to Basics
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await open();
        const phone = await tabs(); assert.ok(!phone.includes('Terminal') && phone.includes('General'), 'phone sections: ' + phone);
        assert.ok(await ev(`(() => { const b = document.querySelector('.settings-advanced-toggle'); const r = b.getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth && r.bottom <= innerHeight + 400; })()`), 'the Advanced button is on screen');
        await shot('basics-390');
        console.log('PASS settings basics and advanced');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
