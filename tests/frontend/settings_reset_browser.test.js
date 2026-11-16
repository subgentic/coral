// ST9: defaults differ from the saved-at-open baseline; Reset uses row autosave.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await require('./helpers/settings_guard').guardSettings();
    const missing = [];
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
            const real = window.fetch; window.__writes = []; window.__refuseReset = false;
            window.fetch = (u, o = {}) => {
                if (new URL(String(u), location.origin).pathname === '/api/settings' && o.method === 'PUT') {
                    window.__writes.push(JSON.parse(o.body));
                    if (window.__refuseReset) return Promise.resolve(new Response(JSON.stringify({error:'Reset refused'}), {status:400,headers:{'Content-Type':'application/json'}}));
                }
                return real(u, o);
            };
        })()` });
        for (const width of [1440, 390]) for (const theme of ['dark', 'light']) {
            await Emulation.setDeviceMetricsOverride({ width, height: 1000, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`Object.assign(window.__qaState.settings, {show_scrollbars:false,terminal_scrollback:'5000',default_working_dir:'/tmp/custom'}); window.showSettingsModal('general')`);
            await waitFor(`document.getElementById('settings-modal')?.style.display === 'flex'`, 'Settings open');
            await ev(`document.documentElement.dataset.theme='${theme}'; document.documentElement.style.fontSize='32px'; true`);
            await ev(framesJs(3));
            if (process.env.CORAL_SCREENSHOT_DIR) {
                fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, {recursive:true});
                fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/settings-reset-${width}-${theme}.png`, Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));
            }
            const has = await ev(`!!document.querySelector('[data-reset-setting="settings-show-scrollbars"]')`);
            if (!has) { missing.push(`${width}/${theme}: no default marker or Reset`); continue; }
            assert.equal(await ev(`document.querySelector('[data-reset-setting="settings-show-scrollbars"]').parentElement.hidden`), false);
            // A default row has no visible Reset, even though it was loaded in the same dialog.
            assert.equal(await ev(`document.querySelector('[data-reset-setting="settings-terminal-scrollback"]').parentElement.hidden`), false);
            await ev(`document.querySelector('[data-reset-setting="settings-show-scrollbars"]').click()`);
            await waitFor(`window.__writes.length === 1 && !document.getElementById('settings-show-scrollbars').disabled`, 'toggle Reset saved');
            assert.deepEqual(await ev(`window.__writes[0]`), {show_scrollbars:true});
            assert.equal(await ev(`document.querySelector('[data-reset-setting="settings-show-scrollbars"]').parentElement.hidden`), true);
            await ev(`document.querySelector('[data-reset-setting="settings-terminal-scrollback"]').click()`);
            await waitFor(`window.__writes.length === 2 && !document.getElementById('settings-terminal-scrollback').disabled`, 'select Reset saved');
            assert.deepEqual(await ev(`window.__writes[1]`), {terminal_scrollback:'20000'});
            // A rejected Reset restores the saved value and its marker. It cannot save a neighbour's draft.
            await ev(`document.getElementById('settings-tab-agents').click()`);
            await ev(`window.__refuseReset=true; document.querySelector('[data-reset-setting="settings-working-dir"]').click()`);
            await waitFor(`document.getElementById('settings-working-dir').closest('.sv-row').querySelector('.settings-save-status')?.textContent.includes('Not saved')`, 'Reset refusal');
            assert.equal(await ev(`document.getElementById('settings-working-dir').value`), '/tmp/custom');
            assert.equal(await ev(`document.querySelector('[data-reset-setting="settings-working-dir"]').parentElement.hidden`), false);
            assert.deepEqual(await ev(`window.__writes[2]`), {default_working_dir:''});
            await ev(`window.__refuseReset=false; document.querySelector('[data-reset-setting="settings-working-dir"]').click()`);
            await waitFor(`window.__writes.length === 4 && !document.getElementById('settings-working-dir').disabled`, 'text Reset saved');
            assert.deepEqual(await ev(`window.__writes[3]`), {default_working_dir:''});
            assert.equal(await ev(`document.querySelector('[data-reset-setting="settings-working-dir"]').parentElement.hidden`), true);
            assert.equal(await ev(`!!document.querySelector('#settings-api-key').closest('.sv-row').querySelector('[data-reset-setting]')`), false);
        }
        assert.deepEqual(missing, [], 'every Settings viewport has default markers and Reset');
    } finally { await guard.restore(); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
