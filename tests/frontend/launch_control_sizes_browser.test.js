// New agent dialog: one control height per width, chips of at least 24 px, and Full access as a switch row (#15889, LA5; spec 695ed583, guideline 4.13).
// Today: Model 36, Thinking 44, Refresh models 30, Choose a path 44, the Deny chips 21 and the Full access box a bare tick box apart from its label.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await require('./helpers/settings_guard').guardSettings();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const measure = async (w, h, expected, label) => {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`window.showLaunchModal(); window._selectLaunchType('agent'); true`);
            await waitFor(`!!document.getElementById('launch-step-agent') && getComputedStyle(document.getElementById('launch-step-agent')).display !== 'none' && !!document.querySelector('#launch-step-agent .acf-model-select, #launch-step-agent .perm-chip')`, 'the agent step');
            await ev(`document.getElementById('launch-step-agent').dataset.stage = 'agent'; document.querySelectorAll('#launch-step-agent details').forEach(d => d.open = true); const st = document.createElement('style'); st.textContent = '#launch-step-agent [data-section] { display: block !important; }'; document.head.append(st); document.querySelector('#launch-step-agent .acf-use-full-access')?.removeAttribute('hidden'); true`);
            await waitFor(`[...document.querySelectorAll('#launch-step-agent .perm-chip')].some(e => e.getBoundingClientRect().height > 0) && [...document.querySelectorAll('#launch-step-agent .acf-model-refresh')].some(e => e.getBoundingClientRect().height > 0)`, 'the chips and Refresh models drawn');
            const r = await ev(`(() => { const vis = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
                const h = e => Math.round(e.getBoundingClientRect().height);
                const q = s => [...document.querySelectorAll('#launch-step-agent ' + s)].filter(vis);
                const controls = q('select.acf-model-select, .acf-model-refresh, .acf-thinking select, .acf-thinking button, .provider-choose, select#launch-board-select').map(e => ({ cls: e.className.toString().slice(0, 40) + ' ' + e.tagName, h: h(e) }));
                const chips = q('.perm-chip').map(e => h(e));
                const full = document.querySelector('#launch-step-agent .acf-use-full-access-input');
                const row = full && full.closest('label'), nm = row && row.querySelector('.acf-use-full-access-name');
                const lvl = full && nm ? Math.abs((full.getBoundingClientRect().top + full.getBoundingClientRect().height / 2) - (nm.getBoundingClientRect().top + nm.getBoundingClientRect().height / 2)) : 99;
                return { controls, chips, fullIsSwitch: !!full && full.classList.contains('switch'), switchLevelWithName: lvl }; })()`);
            console.log(label, JSON.stringify(r));
            const heights = new Set(r.controls.map(c => c.h));
            assert.ok(r.controls.length >= 2, label + ': the dialog shows its controls');
            assert.deepEqual([...heights], [expected], `${label}: every control is ${expected} px, saw ${JSON.stringify(r.controls)}`);
            assert.ok(r.chips.length > 0 && r.chips.every(c => c >= 24), `${label}: chips are at least 24 px, saw ${r.chips}`);
            assert.equal(r.fullIsSwitch, true, label + ': Full access is a switch');
            assert.ok(r.switchLevelWithName <= 3, `${label}: the switch is level with the Full access name, off by ${r.switchLevelWithName} px`);
        };
        console.log('Desktop 1440: controls are 36 px');
        await measure(1440, 900, 36, 'desktop');
        console.log('Phone 390: controls are 44 px');
        await measure(390, 800, 44, 'phone');
        console.log('PASS launch control sizes');
    } finally {
        await guard.restore().catch(e => console.error('settings restore: ' + (e && e.message)));
        await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
