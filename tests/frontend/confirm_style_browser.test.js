// The confirm dialog's button style (#9318): a question that loses something passes { danger: true } and its confirming button is the danger style; one that loses nothing passes
// { danger: false }, or a call that names nothing, gets the primary; every question's button says what it does (Sleep agent, Archive, Delete workflow), never Yes. The real dialog, asked with callers' own words. The style is set on every call, so a danger dialog followed by a plain one is not still red.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const CASES = [ // key, title, message, options, class, the button's words
    ['danger-delete-workflow', 'Delete workflow', 'Delete workflow "nightly-build"? This will also delete all run history.', { label: 'Delete workflow', danger: true }, 'btn-danger', 'Delete workflow'],
    ['danger-kill-run', 'Kill run', 'Stop run #12? Its steps stop where they are and the run cannot be resumed.', { label: 'Kill run', danger: true }, 'btn-danger', 'Kill run'],
    ['danger-paste', 'Paste 3 lines?', 'This terminal isn\u2019t in paste mode, so each line is sent as if typed and runs on its own.', { label: 'Paste and run', danger: true }, 'btn-danger', 'Paste and run'],
    ['primary-sleep-agent', 'Sleep agent', 'Put "Backend Dev" to sleep?', { danger: false, label: 'Sleep agent' }, 'btn-primary', 'Sleep agent'],
    ['primary-archive', 'Archive agent', 'Archive "Backend Dev"? Archived agents are not woken with their team or by Wake All.', { danger: false, label: 'Archive' }, 'btn-primary', 'Archive'],
    ['primary-sleep-team', 'Sleep team', 'Put all agents on "coral-go-team" to sleep?', { danger: false, label: 'Sleep team' }, 'btn-primary', 'Sleep team'],
    ['primary-unnamed', 'Anything', 'A call that names no choice.', undefined, 'btn-primary', 'Confirm'], // census-guarded: no real caller leaves it out, and the fallback is not a Yes (#9413)
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 700, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            const colours = {};
            for (const [key, title, message, opts, cls, words] of CASES) {
                await ev(`window.showConfirmModal(${JSON.stringify(title)}, ${JSON.stringify(message)}, () => {}, undefined, ${JSON.stringify(opts)}); true`);
                await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, `${at}${key}: the dialog`, 8000);
                const got = await ev(`(() => { const b = document.getElementById('confirm-modal-yes'); const s = getComputedStyle(b); return { cls: b.className, bg: s.backgroundColor, color: s.color, text: b.textContent }; })()`);
                assert.ok(got.cls.split(/\s+/).includes(cls) && !got.cls.split(/\s+/).includes(cls === 'btn-danger' ? 'btn-primary' : 'btn-danger'), `${at}${key}: the confirming button is ${cls}: ${got.cls}`);
                assert.equal(got.text, words, `${at}${key}: the button says what it does`);
                colours[key] = got.bg + '|' + got.color;
                await waitFor(`getComputedStyle(document.querySelector('#confirm-modal .modal-content, #confirm-modal > div') || document.body).opacity === '1'`, `${at}${key}: the dialog has settled`, 8000);
                if (key !== 'primary-unnamed') await shot(`confirm-${key}-${w}`);
                await ev(`document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)').click(); true`);
            }
            assert.notEqual(colours['danger-kill-run'], colours['primary-sleep-agent'], at + 'the two styles look different');
            assert.equal(colours['primary-unnamed'], colours['primary-sleep-agent'], at + 'no choice named looks like the primary');
        }
        console.log('PASS confirm style: danger true is the danger button, false or unnamed is the primary, set on every call');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
