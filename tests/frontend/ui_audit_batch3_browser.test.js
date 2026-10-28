// UI audit #5589, third batch (findings 16, 19, 21, 24, 27), on the real server and the real dialogs:
//   16  Settings > Terminal: each backend is one line, the whole explanation (Security's wording) opens under "Learn more";
//   19  Settings > General: the machine health is part of About;
//   21  Settings > Network and Hub, a server with no hub: the command to start with has a Copy button;
//   24  the launch chooser draws the robot the start page draws, in the page's font;
//   27  Settings' footer button says "Save settings", as Team settings does.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async (name, w, h) => { if (!process.env.CORAL_SCREENSHOT_DIR) return; fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); await new Promise(r => setTimeout(r, 300)); // sleep-ok: a screenshot settles layout, there is no event for it
        fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            const open = async group => { await ev(`(async () => { await window.showSettingsModal(${JSON.stringify(group)}); return true; })()`); await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none'`, 'Settings'); };

            // Windows exposes only pty; the backend-choice assertions apply where tmux is available.
            if (process.platform !== 'win32') {
                console.log(`1. (${w}) Terminal: one title each, the whole explanation under Learn more`);
                await open('terminal');
                await waitFor(`!document.getElementById('tb-choice').closest('.sv-row').hidden`, 'the backend row', 10000);
                const RADIO_ROW = `document.getElementById('tb-choice').closest('.sv-row')`;
                const tb = await ev(`[...document.querySelectorAll('#tb-choice option')].map(o => o.textContent.trim())`);
                assert.deepEqual(tb, ['Keep agents running when Coral restarts (tmux)', 'Put agents to sleep when Coral restarts (pty, default)'], 'the backend is a select with two short options (#9490: no radio buttons in the product)');
                assert.equal(await ev(`document.querySelectorAll('input[type=radio]').length`), 0, 'no radio button in Settings');
                const more = await ev(`(() => { const m = ${RADIO_ROW}.querySelector('.sv-more'); return { text: m.textContent, shown: m.checkVisibility({ checkVisibilityCSS: true }) }; })()`);
                assert.match(more.text, /any other program running as you, can find that socket/, 'the access warning is in Learn more, whole');
                assert.ok(!more.shown && more.text.length > 600, 'Learn more is closed at first and holds the whole explanation');
                assert.equal((more.text.match(/macOS: with pty|Linux: with pty/g) || []).length, 1, "the operating system's note ends the explanation, said once");
                assert.equal(await ev(`${RADIO_ROW}.querySelectorAll('.sv-learn').length`), 1, 'the backend card has one Learn more (#7636)');
                const wake = await ev(`(() => { const a = document.getElementById('tb-autowake-on').closest('.sv-row'); if (a.hidden) return null; const c = document.getElementById('tb-autowake-on').getBoundingClientRect(), r = a.getBoundingClientRect(); return { fromEdge: Math.round(r.right - c.right), first: a.firstElementChild.tagName === 'DIV' && /Wake agents/.test(a.firstElementChild.textContent) ? 'SPAN' : a.firstElementChild.tagName }; })()`);
                if (wake) assert.ok(wake.fromEdge < 12 && wake.first === 'SPAN', 'Wake agents after a restart: the label first, its switch at the far end like every other row (#7636): ' + JSON.stringify(wake));
                await shot('terminal-short', w);
                await ev(`document.getElementById('tb-choice').value = 'tmux'; ${RADIO_ROW}.querySelector('.sv-learn').click(); true`);
                const opened = await ev(`(() => { const b = ${RADIO_ROW}.querySelector('.sv-learn'), d = ${RADIO_ROW}.querySelector('.sv-more'); return { shown: d.checkVisibility({ checkVisibilityCSS: true }), text: d.textContent, label: b.textContent, expanded: b.getAttribute('aria-expanded'), selectChanged: document.getElementById('tb-choice').value !== 'tmux' }; })()`);
                assert.ok(opened.shown && opened.label === 'Show less' && opened.expanded === 'true' && /puts them to sleep first when it stops cleanly/.test(opened.text), JSON.stringify(opened).slice(0, 200));
                const learnName = await ev(`${RADIO_ROW}.querySelector('.sv-learn').getAttribute('aria-label')`);
                assert.equal(learnName, 'Show less about the terminal backends', 'an open Learn more is named by its visible words and what it explains: ' + learnName);
                assert.equal(opened.selectChanged, false, 'Learn more does not choose the backend');
                await shot('terminal-learn', w);
                await ev(`window.hideSettingsModal(); true`);
            }

            console.log(`1b. (${w}) Notifications: every hint is one sentence with a full stop`);
            await open('notifications');
            const hints = await ev(`[...document.querySelectorAll('#settings-pane-notifications .sv-help-text')].filter(h => h.checkVisibility() && h.textContent.trim()).map(h => h.textContent.trim())`);
            assert.equal(await ev(`document.querySelectorAll('#settings-pane-notifications .sv-learn').length`), 1, 'Desktop alerts keeps its explanation behind Learn more (#7907)');
            assert.ok(hints.length >= 1 && hints.every(h => /\.$/.test(h) && !/\.\s+\S/.test(h)), 'one sentence each, with a full stop (#7636): ' + JSON.stringify(hints));
            console.log(`2. (${w}) General: the machine health is part of About`);
            await open('general');
            assert.deepEqual(await ev(`(() => { const a = document.getElementById('about-section'); const h = document.getElementById('machine-health-local'); return { inAbout: a.contains(h), order: [...a.children].map(c => c.id || c.className.split(' ')[0]) }; })()`).then(r => r.inAbout), true);
            await shot('general-about', w);

            console.log(`3. (${w}) Network and Hub: with no hub, the command has a Copy button`);
            await ev(`window.hideSettingsModal(); true`); await open('network');
            await waitFor(`!!document.querySelector('#settings-cloud [data-cloud=command-row]:not([hidden])') || /connect|configured|Ready/.test(document.getElementById('settings-cloud-status').textContent)`, 'the Coral Hub status', 10000);
            const hubOff = await ev(`/isn't configured/.test(document.getElementById('settings-cloud-status').textContent)`);
            if (hubOff) {
                const row = await ev(`(() => { const r = document.querySelector('#settings-cloud [data-cloud=command-row]'); return { shown: !r.hidden, cmd: r.querySelector('code').textContent, copy: r.querySelector('button').textContent }; })()`);
                assert.deepEqual(row, { shown: true, cmd: 'coral --cloud-url https://app.coralhub.dev\ncoral cloud connect', copy: 'Copy' }); // the sequence: batch 4 puts both steps in the row
                await ev(`window.__copied = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: t => { window.__copied.push(t); return Promise.resolve(); } } }); document.querySelector('#settings-cloud [data-cloud=command-row] button').click(); true`);
                await waitFor(`window.__copied.length === 1`, 'the copy'); assert.deepEqual(await ev(`window.__copied`), ['coral --cloud-url https://app.coralhub.dev\ncoral cloud connect']);
                await shot('network-off', w);
            }
            console.log(`4. (${w}) Settings footer says Save settings`);
            assert.equal(await ev(`document.querySelector('#settings-modal [data-on-click=m-apply-settings]').textContent.trim()`), 'Save settings');
            await ev(`window.hideSettingsModal(); true`);

            console.log(`5. (${w}) The launch chooser: the start page's robot, in the page's font`);
            await ev(`(async () => { await window.showLaunchModal(); return true; })()`);
            await waitFor(`getComputedStyle(document.getElementById('launch-step-chooser')).display !== 'none'`, 'the chooser');
            const ch = await ev(`(() => { const c = document.querySelector('.launch-type-card'); const g = c.querySelector('.launch-type-glyph'); return { glyph: g && g.textContent, font: getComputedStyle(c).fontFamily === getComputedStyle(document.body).fontFamily, svg: c.querySelectorAll('svg').length }; })()`);
            assert.deepEqual(ch, { glyph: 'smart_toy', font: true, svg: 0 });
            await shot('chooser', w);
            await ev(`window.hideLaunchModal(); true`);
        }
        console.log('   ✓');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
