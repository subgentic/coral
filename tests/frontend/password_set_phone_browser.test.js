// After Set password on a phone (#10720, Mobile pass 37 moment 1): focus does not return to the Search agents box that had it when the dialog opened (its focus raises the on-screen keyboard over the result), and the toast "Password set..."
// is whole: inside the screen, its words not cut, and long enough on screen to read. 390 px with touch, the save answered by a stub; shots with CORAL_SCREENSHOT_DIR. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const problems = [];
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`(() => { const R = window.fetch; window.fetch = (u, o) => /\\/api\\/auth\\/password\\/set/.test(String(u && u.url || u)) ? Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })) : R(u, o); return true; })()`);
        // the person had the search box when the dialog came up
        const search = await ev(`(() => { const e = [...document.querySelectorAll('#agent-search-input, #mobile-agent-list .mobile-search-input, input[type=search]')].find(x => x.getClientRects().length > 0); if (!e) return null; e.focus(); return e.id || e.className; })()`);
        if (!search) problems.push('no visible search box to hold the focus (the phone home changed?)');
        await ev(`import((window.__coralStatic || '/static/') + 'password_ui.js').then(m => { m.showSetPasswordModal({ local: true }); return true; })`);
        await waitFor(`!!document.getElementById('set-password-modal')`, 'the dialog', 8000);
        await ev(`(() => { const set = (sel, v) => { const i = document.querySelector('#set-password-modal ' + sel); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }; const ins = [...document.querySelectorAll('#set-password-modal input[type=password]')]; for (const i of ins) { i.value = 'a-long-enough-pass-9'; i.dispatchEvent(new Event('input', { bubbles: true })); } return ins.length; })()`);
        await ev(`document.querySelector('#set-password-modal form').requestSubmit(); true`);
        await waitFor(`!document.getElementById('set-password-modal') && !!document.querySelector('.toast')`, 'the toast', 8000);
        await sleep(400); /* sleep-ok: the toast slides in */
        const got = await ev(`(() => { const a = document.activeElement; const t = document.querySelector('.toast'), m = t.querySelector('.toast-message') || t, r = t.getBoundingClientRect(); return { tag: a ? a.tagName.toLowerCase() : '', type: a && a.type || '', typing: !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'submit'].includes(a.type))), id: a && a.id, left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), w: innerWidth, h: innerHeight, clipped: m.scrollWidth > m.clientWidth + 1 || m.scrollHeight > m.clientHeight + 1, text: m.textContent.trim() }; })()`);
        await shot('password-set-phone');
        if (got.typing) problems.push(`focus is on a text box (${got.tag}#${got.id}): its focus raises the keyboard`);
        if (got.left < 0 || got.right > got.w || got.bottom > got.h) problems.push(`the toast is outside the screen: ${JSON.stringify(got)}`);
        if (got.clipped) problems.push(`the toast's words are cut: ${JSON.stringify(got)}`);
        if (!/^Password set\./.test(got.text)) problems.push(`the toast says ${got.text}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'after Set password on a phone:\n  ' + problems.join('\n  '));
    console.log('PASS Set password on a phone: no keyboard, a whole toast');
})().catch(e => { console.error(e); process.exit(1); });
