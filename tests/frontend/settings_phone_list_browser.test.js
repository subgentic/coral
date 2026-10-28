// Settings on a phone is a list of its sections, then one section with a way back (Beta Tester's phone pass, #10000): the section dropdown read as a form field. At 390 px Settings opens on a list of rows (each 44 px or more, with
// a chevron, no dropdown); a tap opens a section, with a back row that returns to the list; a section asked for (a link that says "set its path in Settings") opens straight on it. At 1280 px nothing changes: the rail and the section,
// no back row, no list screen. Drives Chrome over CDP through agent_view_harness.js on the isolated dev server; LOOK shots go to CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const vis = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; })()`;
    const state = () => ev(`(() => { const m = document.getElementById('settings-modal'), v = e => !!e && e.getClientRects().length > 0, tabs = [...m.querySelectorAll('.settings-tab')].filter(v);
        return { screen: m.dataset.screen || '', tabs: tabs.length, minH: tabs.length ? Math.round(Math.min(...tabs.map(t => t.getBoundingClientRect().height))) : 0, select: v(m.querySelector('.settings-group-pick select')), pane: v(m.querySelector('.settings-pane:not([hidden])')), back: v(m.querySelector('.settings-back')),
            chevron: tabs.length ? getComputedStyle(tabs[0], '::after').content : '', title: (m.querySelector('.settings-pane:not([hidden]) .settings-pane-title') || {}).textContent || '' }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 800, false]]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${w}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Emulation.setEmulatedMedia({ features: mobile ? [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] : [] });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`try { localStorage.removeItem(Object.keys(localStorage).find(k => /settings-group/.test(k)) || 'x'); } catch (e) {} window.showSettingsModal(); true`);
            await waitFor(`(m => !!m && getComputedStyle(m).display !== 'none' && m.querySelectorAll('.settings-tab').length >= 6)(document.getElementById('settings-modal'))`, `${w}: Settings open`, 10000); // the dialog is built when it first opens
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the dialog fills
            let s = await state();
            if (mobile) {
                check(s.screen === 'sections' && s.tabs >= 6 && !s.pane && !s.select && !s.back, `opens on the list of sections, no dropdown, no section open: ${JSON.stringify(s)}`);
                check(s.minH >= 44, `each row is 44 px or more: ${JSON.stringify(s)}`);
                check(s.chevron && s.chevron !== 'none' && s.chevron !== 'normal', `each row has a chevron: ${JSON.stringify(s)}`);
                await shot('settings-phone-list');
                await ev(`document.querySelector('#settings-modal #settings-tab-agents').click(); true`);
                await new Promise(r => setTimeout(r, 300)); // sleep-ok: the section opens
                s = await state();
                check(s.screen === 'pane' && s.pane && s.back && s.tabs === 0 && s.title === 'Agents', `a tap opens the section with a back row, the list is gone: ${JSON.stringify(s)}`);
                await shot('settings-phone-section');
                await ev(`document.querySelector('#settings-modal .settings-back').click(); true`);
                await new Promise(r => setTimeout(r, 300)); // sleep-ok: back to the list
                s = await state();
                check(s.screen === 'sections' && s.tabs >= 6 && !s.pane && !s.back, `back returns to the list: ${JSON.stringify(s)}`);
                check(await ev(`document.activeElement && document.activeElement.id === 'settings-tab-agents'`), 'and the keyboard is on the section it came from');
                await ev(`window.hideSettingsModal(); window.showSettingsModal('agents'); true`);
                await new Promise(r => setTimeout(r, 500)); // sleep-ok: the dialog fills
                s = await state();
                check(s.screen === 'pane' && s.pane && s.back && s.title === 'Agents', `a section asked for opens straight on it, with the way back: ${JSON.stringify(s)}`);
            } else {
                check(s.tabs >= 6 && s.pane && !s.select && !s.back, `the rail and a section, no back row, no dropdown: ${JSON.stringify(s)}`);
                await shot('settings-desktop');
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Settings on a phone:\n  ' + problems.join('\n  '));
    console.log('PASS Settings on a phone is a list of sections');
})().catch(e => { console.error(e); process.exit(1); });
