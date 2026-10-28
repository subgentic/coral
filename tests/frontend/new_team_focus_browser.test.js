// New team by keyboard (Beta #10401 moments 1 and 2, #10410): (1) on step 1 every Tab stop is something a person can see and that has a name (the Worktree switch of a later step took a stop on step 1 with no label and nothing
// on screen); (2) step 3 opens with the keyboard in its first field, not on the left menu's "Start" (typing the first task went nowhere). Real Tab keys. 1280 px, the isolated dev server, models stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNT, N, T, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const { Input } = client; const t = T(ev, waitFor);
    const tab = async () => { for (const type of ['rawKeyDown', 'keyUp']) await Input.dispatchKeyEvent({ type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); };
    const where = () => ev(`(() => { const a = document.activeElement; if (!a || a === document.body) return { body: true }; const r = a.getBoundingClientRect(); return { tag: a.tagName.toLowerCase(), id: a.id || '', role: a.getAttribute('role') || '', type: a.type || '', name: window.__na.name(a).slice(0, 40), shown: r.width > 0 && r.height > 0 && getComputedStyle(a).visibility !== 'hidden', inDialog: !!window.__nt.dlg(${N.team}) && window.__nt.dlg(${N.team}).contains(a) }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNT(ev); await stubModels(ev);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
        await openNewTeam(ev, waitFor);
        // (1) step 1: every stop is visible and named
        await t.type('input', N.teamName, 'alpha'); await t.type('input', N.folder, '/work/payments-app');
        await ev(`window.__nt.find(window.__nt.dlg(${N.team}), 'input', ${N.teamName}).focus(); true`);
        const stops = [];
        for (let i = 0; i < 8; i++) { await tab(); const w = await where(); if (!w.inDialog) break; stops.push(w); if (/^Cancel$|^Next$/.test(w.name) && /^Next$/.test(w.name)) break; }
        const bad = stops.filter(s => !s.shown || !s.name);
        check(bad.length === 0, `every Tab stop on step 1 is visible and named: ${JSON.stringify(bad)} (stops: ${JSON.stringify(stops.map(s => s.name || s.id))})`);
        // (2) step 3 opens in its first field
        await t.click('button', N.next); await t.step(2);
        await t.click('button', N.next); await t.step(3);
        await new Promise(r => setTimeout(r, 500)); // sleep-ok: the step draws and takes the keyboard
        const w3 = await where();
        check(!w3.body && w3.inDialog && w3.role !== 'tab' && /^(input|textarea|select)$/.test(w3.tag), `step 3 opens with the keyboard in its first field, not on a menu tab: ${JSON.stringify(w3)}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'New team by keyboard:\n  ' + problems.join('\n  '));
    console.log('PASS New team steps open on a field and have no unnamed stops');
})().catch(e => { console.error(e); process.exit(1); });
