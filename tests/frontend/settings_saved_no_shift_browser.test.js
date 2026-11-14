// A setting's "Saved" note takes no room (Beta Tester, walk #16414: the row pushed the switch down about 6 px). At 1440 and 390, dark and light: a switch is turned on in General, and while its "Saved" note shows, the
// switch, its row and the rows under it are where they were. The note is still read (it is a status line), and it clears after two seconds.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await require('./helpers/settings_guard').guardSettings();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1440, false], [390, true]]) for (const theme of ['dark', 'light']) {
            const tag = `${w}px ${theme}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.showSettingsModal('general')`);
            await waitFor(`document.getElementById('settings-modal')?.style.display === 'flex'`, `${tag}: Settings open`);
            await ev(`document.documentElement.dataset.theme = '${theme}'; true`); await ev(framesJs(3));
            const pos = () => ev(`(() => { const sw = document.getElementById('settings-show-scrollbars'), row = sw.closest('.sv-row'), next = row.nextElementSibling; return { sw: Math.round(sw.getBoundingClientRect().top), row: Math.round(row.getBoundingClientRect().height), next: next ? Math.round(next.getBoundingClientRect().top) : null, note: (row.querySelector('.settings-save-status') || {}).textContent || '' }; })()`);
            const before = await pos();
            await ev(`document.getElementById('settings-show-scrollbars').click(); true`);
            await waitFor(`(document.getElementById('settings-show-scrollbars').closest('.sv-row').querySelector('.settings-save-status') || {}).textContent === 'Saved'`, `${tag}: the Saved note`, 5000);
            await ev(framesJs(3));
            const during = await pos(); await shot(`saved-note-${w}-${theme}`);
            if (during.sw !== before.sw || during.row !== before.row || during.next !== before.next) problems.push(`${tag}: the Saved note moves things: before ${JSON.stringify(before)}, during ${JSON.stringify(during)}`);
            await ev(`document.getElementById('settings-show-scrollbars').click(); true`); // put it back
            await waitFor(`(document.getElementById('settings-show-scrollbars').closest('.sv-row').querySelector('.settings-save-status') || {}).textContent === 'Saved'`, `${tag}: Saved again`, 5000);
        }
    } finally { await guard.restore(); await client.close(); }
    assert.deepEqual(problems, [], 'Settings:\n  ' + problems.join('\n  '));
    console.log('PASS the Saved note takes no room');
})().catch(e => { console.error(e.message); process.exit(1); });
