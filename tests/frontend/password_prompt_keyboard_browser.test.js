// The first-run "Set a password for Coral" dialog by keyboard at 200% text and at 640 px (Beta Tester's #10058, #10067): (1) a focused field is scrolled into view above the footer, not left under it (the dialog's body scrolls and the footer
// stays); (2) closing it (Not now, Escape) gives the keyboard to a control on the page behind it (Home's first one), not the body. Real keys (Tab, Escape). Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const KEYS = { Tab: [9, 'Tab'], Escape: [27, 'Escape'] };
    const key = async (k, shift) => { const [code, name] = KEYS[k]; await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: k, code: name, windowsVirtualKeyCode: code, modifiers: shift ? 8 : 0 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: name, windowsVirtualKeyCode: code }); await new Promise(r => setTimeout(r, 150)); }; // sleep-ok: the key's handlers run
    const where = () => ev(`(() => { const a = document.activeElement, m = document.getElementById('set-password-modal'); return { tag: a ? a.tagName : '', id: a ? a.id : '', inModal: !!m && !!a && m.contains(a), body: a === document.body, label: a ? (a.getAttribute('aria-label') || a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) : '' }; })()`);
    const geom = () => ev(`(() => { const a = document.activeElement, f = document.querySelector('#set-password-modal .modal-footer'); if (!a || !f) return null; const r = a.getBoundingClientRect(), fr = f.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), footTop: Math.round(fr.top), vh: innerHeight }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, font] of [['200% text', 1280, 800, '32px'], ['200% text, short', 1280, 520, '32px'], ['640 px', 640, 420, '']]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${label}: ${msg}`); };
            for (const closeBy of ['Not now', 'Escape']) {
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: false });
                await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
                await ev(`window.__coralReady.startup('liveList', 'settings')`);
                if (font) await ev(`document.documentElement.style.fontSize = ${JSON.stringify(font)}; true`);
                await ev(`document.activeElement && document.activeElement.blur(); import((window.__coralStatic || '/static/') + 'password_ui.js').then(m => { m.showSetPasswordModal({ local: true }); return true; })`);
                await waitFor(`!!document.getElementById('set-password-modal')`, `${label}: the dialog`, 8000);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: the dialog draws
                // Tab through its stops: each focused field is above the footer
                const seen = [];
                for (let i = 0; i < 6; i++) { await key('Tab'); const wh = await where(); if (!wh.inModal) break; const g = await geom(); seen.push({ id: wh.id, ...g }); }
                const fields = seen.filter(s => /^set-password-(new|confirm)$/.test(s.id));
                check(fields.length === 2, `Tab reaches both fields: ${JSON.stringify(seen.map(s => s.id))}`);
                for (const s of fields) check(s.bottom <= s.footTop - 12 && s.top >= 0, `${s.id} is in view with room above the footer, not flush against it (its label and the meter are not under it): ${JSON.stringify(s)}`);
                // close it
                if (closeBy === 'Escape') await key('Escape'); else await ev(`document.getElementById('set-password-later').click(); true`);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: the dialog closes
                const after = await where();
                check(!(await ev(`!!document.getElementById('set-password-modal')`)), `${closeBy}: the dialog is closed`);
                check(!after.body && after.tag !== 'HTML', `${closeBy}: the keyboard is on a control of the page, not the body: ${JSON.stringify(after)}`);
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Set a password dialog by keyboard:\n  ' + problems.join('\n  '));
    console.log('PASS the Set a password dialog by keyboard');
})().catch(e => { console.error(e); process.exit(1); });
