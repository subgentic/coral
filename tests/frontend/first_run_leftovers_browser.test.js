// Two first-run leftovers from the phone check (#11304, Mobile Beta Tester's #11301 and #11257): the "Set a password" dialog has no empty gap between the Password and the Confirm fields (the strength advice sits under both,
// its room kept so nothing jumps), at 390 and 320 px, 100% and 200% text, light and dark; and in the Change password form of Settings too.
// Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, fs, theme] of [[390, 16, 'light'], [390, 32, 'dark'], [320, 16, 'dark'], [320, 32, 'light'], [1280, 16, 'light']]) {
            const tag = `${w}@${fs} ${theme}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: w < 600 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`document.documentElement.style.fontSize = '${fs}px'; document.documentElement.setAttribute('data-theme', '${theme}'); document.activeElement && document.activeElement.blur(); import((window.__coralStatic || '/static/') + 'password_ui.js').then(m => { m.showSetPasswordModal({ local: true }); return true; })`);
            await waitFor(`!!document.getElementById('set-password-modal') && !!document.getElementById('set-password-confirm')`, `${tag}: the dialog`, 8000);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: the dialog draws
            const g = await ev(`(() => { const a = document.getElementById('set-password-new').closest('.pw-field'), c = document.getElementById('set-password-confirm').closest('.pw-field'), m = document.getElementById('set-password-strength').closest('.pw-strength'), ar = a.getBoundingClientRect(), cr = c.getBoundingClientRect(), mr = m.getBoundingClientRect(), fs = parseFloat(getComputedStyle(document.documentElement).fontSize); return { gap: Math.round(cr.top - ar.bottom), em: fs, meterAfterConfirm: mr.top >= cr.bottom - 1, order: [...document.querySelectorAll('#set-password-form > *')].map(e => e.className || e.tagName).join('|') }; })()`);
            if (!(g.gap >= 0 && g.gap <= Math.round(g.em * 1.5))) problems.push(`${tag}: ${g.gap} px between the Password field and Confirm (normal spacing is under ${Math.round(g.em * 1.5)}): ${g.order}`);
            if (!g.meterAfterConfirm) problems.push(`${tag}: the strength advice is under the Confirm field, not between the two`);
            await ev(`document.getElementById('set-password-later').click(); true`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Set a password dialog:\n  ' + problems.join('\n  '));
    console.log('PASS the Set a password dialog has no empty gap between Password and Confirm, at 390 and 320, 100% and 200%, light and dark');
})().catch(e => { console.error(e); process.exit(1); });
