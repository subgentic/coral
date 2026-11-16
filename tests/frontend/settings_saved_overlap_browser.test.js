// The Settings "Saved" note does not sit on a control (QA3's SHOULD on #16426, #17628): the note takes no room (it sits in the row's padding, bottom right), so on a row with a tall control at the right (a select, an
// input, a button) it could cover the control's bottom edge. In General, Defaults, Storage and Files, at 1440 and 390 px, dark and light, a "Saved" note is put on every row that has a control, built as autosave builds it
// (settings_autosave.js status()), and its box must not overlap the box of any control of its own row or of the row under it. One shot per width and theme.
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
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            for (const pane of ['general', 'agents', 'cleanup', 'files']) {
                const tag = `${w}px ${theme} ${pane}`;
                await ev(`window.showSettingsModal('${pane}')`);
                await waitFor(`document.getElementById('settings-modal')?.style.display === 'flex' && document.querySelector('#settings-pane-${pane} .sv-row')`, `${tag}: the pane`, 10000);
                await ev(`document.documentElement.dataset.theme = '${theme}'; true`); await ev(framesJs(3));
                const hits = await ev(`(() => { const out = [], pane = document.getElementById('settings-pane-${pane}'); let n = 0;
                    for (const row of pane.querySelectorAll('.sv-row')) {
                        const ctl = [...row.querySelectorAll('input:not([type=hidden]),select,textarea,button')].filter(c => c.getClientRects().length && !c.closest('.settings-save-status'));
                        if (!ctl.length || row.getClientRects().length === 0) continue;
                        const s = document.createElement('span'); s.className = 'settings-save-status'; s.setAttribute('role', 'status'); s.textContent = 'Saved'; (row.querySelector('.sv-text') || row).append(s); n++;
                        const a = s.getBoundingClientRect(), nx = row.nextElementSibling, all = [...row.querySelectorAll('input:not([type=hidden]),select,textarea,button'), ...(nx && nx.classList.contains('sv-row') ? nx.querySelectorAll('input:not([type=hidden]),select,textarea,button') : [])].filter(c => c.getClientRects().length && !c.closest('.settings-save-status'));
                        for (const c of all) { const b = c.getBoundingClientRect(); const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); if (ox > 0.5 && oy > 0.5) out.push((row.dataset.key || row.id || '?') + ': the note ' + [a.left, a.top, a.right, a.bottom].map(Math.round) + ' covers ' + (c.id || c.tagName) + ' ' + [b.left, b.top, b.right, b.bottom].map(Math.round)); }
                    } return { n, out }; })()`);
                if (hits.n < 3) problems.push(`${tag}: only ${hits.n} rows with a control were looked at`);
                for (const h of hits.out) problems.push(`${tag}: ${h}`);
                if (pane === 'general') await shot(`saved-overlap-${w}-${theme}`);
                await ev(`document.querySelectorAll('#settings-modal .settings-save-status').forEach(s => s.remove()); true`);
            }
        }
    } finally { await guard.restore(); await client.close(); }
    assert.deepEqual(problems, [], 'the Saved note on a control:\n  ' + problems.join('\n  '));
    console.log('PASS the Saved note covers no control');
})().catch(e => { console.error(e.message); process.exit(1); });
