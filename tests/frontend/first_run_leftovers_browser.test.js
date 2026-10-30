// Two first-run leftovers from the phone check (#11304, Mobile Beta Tester's #11301 and #11257): the "Set a password" dialog has no empty gap between the Password and the Confirm fields (the strength advice sits under both fields and holds no room until something is typed), at 390 and 320 px, 100% and 200% text, light and dark; and in the Change password form of Settings too.
// Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, fs, theme] of [[390, 16, 'light'], [390, 32, 'dark'], [320, 16, 'dark'], [320, 32, 'light'], [1280, 16, 'light']]) {
            const tag = `${w}@${fs} ${theme}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: w < 600 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`document.documentElement.style.fontSize = '${fs}px'; document.documentElement.setAttribute('data-theme', '${theme}'); document.activeElement && document.activeElement.blur(); import((window.__coralStatic || '/static/') + 'password_ui.js').then(m => { m.showSetPasswordModal({ local: true }); return true; })`);
            await waitFor(`!!document.getElementById('set-password-modal') && !!document.getElementById('set-password-confirm')`, `${tag}: the dialog`, 8000);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: the dialog draws
            const g = await ev(`(() => { const a = document.getElementById('set-password-new').closest('.pw-field'), c = document.getElementById('set-password-confirm').closest('.pw-field'), m = document.getElementById('set-password-strength').closest('.pw-strength'), ar = a.getBoundingClientRect(), cr = c.getBoundingClientRect(), mr = m.getBoundingClientRect(), fs = parseFloat(getComputedStyle(document.documentElement).fontSize); return { gap: Math.round(cr.top - ar.bottom), em: fs, meterAfterConfirm: !!(c.compareDocumentPosition(m.closest('.pw-strength')) & Node.DOCUMENT_POSITION_FOLLOWING), order: [...document.querySelectorAll('#set-password-form > *')].map(e => e.className || e.tagName).join('|') }; })()`);
            if (!(g.gap >= 0 && g.gap <= Math.round(g.em * 1.5))) problems.push(`${tag}: ${g.gap} px between the Password field and Confirm (normal spacing is under ${Math.round(g.em * 1.5)}): ${g.order}`);
            if (!g.meterAfterConfirm) problems.push(`${tag}: the strength advice is under the Confirm field, not between the two`);
            // nothing typed: the advice holds no room; typing brings it
            const idle = await ev(`Math.round(document.getElementById('set-password-strength').closest('.pw-strength').getBoundingClientRect().height)`);
            if (idle !== 0) problems.push(`${tag}: the empty advice holds ${idle} px under Confirm (it holds none until there is something to say)`);
            await ev(`(() => { const i = document.getElementById('set-password-new'); i.focus(); i.value = 'abc'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await new Promise(r => setTimeout(r, 200)); // sleep-ok: the advice is drawn on the input event
            const shown = await ev(`Math.round(document.getElementById('set-password-strength').closest('.pw-strength').getBoundingClientRect().height)`);
            if (!(shown > 0)) problems.push(`${tag}: the advice appears once a password is typed (it is ${shown} px)`);
            await ev(`document.getElementById('set-password-later').click(); true`);
            // the same spacing in Settings' Change password form
            const cp = await ev(`(async () => { const R = window.fetch; window.fetch = (u, o = {}) => { const p = String(u); if (p.startsWith('/api/system/auth-status')) return Promise.resolve(new Response(JSON.stringify({ authenticated: true, method: 'session', password_set: true, local: true }), { status: 200, headers: { 'content-type': 'application/json' } })); if (p.startsWith('/api/auth/sessions') && !o.method) return Promise.resolve(new Response(JSON.stringify({ sessions: [], recent: [] }), { status: 200, headers: { 'content-type': 'application/json' } })); return R(u, o); };
                document.body.insertAdjacentHTML('beforeend', '<div id="settings-security" class="tb-row sec-row" role="group"></div>'); const sec = await import((window.__coralStatic || '/static/') + 'security_settings.js'); await sec.loadSecurityRow(); await new Promise(r => setTimeout(r, 200)); // sleep-ok: the row is drawn after its two fetches
                const d = document.getElementById('sec-change'); d.open = true; await new Promise(r => setTimeout(r, 100));
                const n = document.getElementById('sec-new').closest('.pw-field'), c = document.getElementById('sec-confirm').closest('.pw-field'), m = document.getElementById('sec-strength').closest('.pw-strength'), fsz = parseFloat(getComputedStyle(document.documentElement).fontSize);
                const out = { gap: Math.round(c.getBoundingClientRect().top - n.getBoundingClientRect().bottom), em: fsz, meterAfter: !!(c.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING), idleH: Math.round(m.getBoundingClientRect().height) };
                window.fetch = R; document.getElementById('settings-security').remove(); return out; })()`);
            if (!(cp.gap >= 0 && cp.gap <= Math.round(cp.em * 1.5))) problems.push(`${tag}: Settings' Change password: ${cp.gap} px between New password and Confirm (under ${Math.round(cp.em * 1.5)} is normal)`);
            if (!cp.meterAfter || cp.idleH !== 0) problems.push(`${tag}: Settings' Change password: the advice is under Confirm and holds no room while empty (after: ${cp.meterAfter}, ${cp.idleH} px)`);
        }
        // a chat that cannot open: the caller is told, and says the agent launched
        const seam = await ev(`import((window.__coralStatic || '/static/') + 'launch_dialog.js').then(async m => ({ failed: await m._openLaunched({ session_name: 'x', session_id: 'x' }, 'claude', null, { select: async () => { throw new Error('no chat'); } }), opened: await m._openLaunched({ session_name: 'x', session_id: 'x' }, 'claude', null, { select: async () => {} }) }))`);
        if (seam.failed !== false || seam.opened !== true) problems.push(`_openLaunched says whether the chat opened: ${JSON.stringify(seam)}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Set a password dialog:\n  ' + problems.join('\n  '));
    console.log('PASS the Set a password dialog has no empty gap between Password and Confirm, at 390 and 320, 100% and 200%, light and dark');
})().catch(e => { console.error(e); process.exit(1); });
