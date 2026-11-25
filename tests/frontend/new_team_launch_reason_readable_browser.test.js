// New team step 3: the reason Launch team is off is READABLE next to it (2.1.12, #21236): it was 24 x 36 px under Cancel at 1440 and 1280 (the row's measure counted Cancel, at the far left, as one of the right buttons). 1440, 1280, 390; CLI missing.
// (older note) New team step 3 says why Launch team is off (#9945, Beta Tester's find #9944): with the Claude CLI missing, a member's own CLI warning (in the Members page, hidden on step 3) held Launch team off and nothing
// on screen said so. Now the line above the buttons names the reason and the fix, as steps 1 and 2 do, and Launch team is described by it; with the CLI found the recap is back and Launch team is on.
// 1280 px, isolated dev server, the CLI check stubbed (missing, then found), controls by role and name (helpers/new_team.js).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { install: installNT, T, N, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const t = T(ev, waitFor);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const launchState = () => ev(`(() => { const d = window.__nt.dlg(${N.team}); const b = window.__nt.buttons(d).find(x => ${N.launch}.test(x.name)); const line = window.__na.text(document.getElementById('team-recap')); const go = document.getElementById('launch-team-go'); return { disabled: !!b && b.disabled, line, described: go.getAttribute('aria-describedby') }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installNT(ev); await stubModels(ev);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); window.__cliFound = false; const real = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href); if (p.pathname === '/api/system/cli-check') return Promise.resolve(new Response(JSON.stringify((window.__cliFound || p.searchParams.get('type') !== 'claude') ? { found: true, version: '1', status: 'available' } : { found: false, status: 'missing', agent_type: p.searchParams.get('type') }), { status: 200, headers: { 'Content-Type': 'application/json' } })); return real(u, o); }; true`);
        await openNewTeam(ev, waitFor);
        await t.to(3, {});
        await waitFor(`document.getElementById('launch-team-go').disabled`, 'Launch team is off while the CLI is missing', 8000);
        for (const [w, h, mobile] of [[1440, 900, false], [1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await settle(500);
            const g = await ev(`(() => { const r = document.getElementById('team-recap'), b = r.getBoundingClientRect(), a = document.querySelector('#launch-step-team > .modal-actions'); const btn = n => { const e = [...a.querySelectorAll(':scope > .btn')].find(x => x.textContent.trim() === n); return e && e.getClientRects().length ? e.getBoundingClientRect() : null; }; const c = btn('Cancel'), back = btn('Back'), go = btn('Launch team'); const fix = [...r.querySelectorAll('button, a')].find(x => /path|Settings/i.test(x.textContent)); const fr = fix && fix.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), left: Math.round(b.left), right: Math.round(b.right), cancelRight: c && Math.round(c.right), backLeft: back && Math.round(back.left), goOff: document.getElementById('launch-team-go').disabled, fix: !!fr && fr.width > 0 && fr.height > 0, fixInside: !!fr && fr.right <= b.right + 1, clipped: r.scrollHeight > r.clientHeight + 2 }; })()`);
            const at = w + ' px: ';
            assert.ok(g.goOff, at + 'Launch team is off: ' + JSON.stringify(g));
            assert.ok(g.w >= 240 && g.h >= 18, at + 'the reason has room to be read (it was 24 x 36): ' + JSON.stringify(g));
            assert.ok(g.fix && g.fixInside, at + 'the link to the Settings fix is shown inside it: ' + JSON.stringify(g));
            if (!mobile) assert.ok(g.left >= g.cancelRight && g.right <= g.backLeft, at + 'it sits between Cancel and the buttons at the right, under neither: ' + JSON.stringify(g));
            assert.ok(!g.clipped, at + 'nothing of it is cut off: ' + JSON.stringify(g));
        }
        console.log('PASS New team step 3: the reason Launch team is off is readable beside it, with its Settings link, at 1440, 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
