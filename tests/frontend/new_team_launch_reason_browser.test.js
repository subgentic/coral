// New team step 3 says why Launch team is off (#9945, Beta Tester's find #9944): with the Claude CLI missing, a member's own CLI warning (in the Members page, hidden on step 3) held Launch team off and nothing
// on screen said so. Now the line above the buttons names the reason and the fix, as steps 1 and 2 do, and Launch team is described by it; with the CLI found the recap is back and Launch team is on.
// 1280 px, isolated dev server, the CLI check stubbed (missing, then found), controls by role and name (helpers/new_team.js).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { install: installNT, T, N, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const t = T(ev, waitFor);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const launchState = () => ev(`(() => { const d = window.__nt.dlg(${N.team}); const b = window.__nt.buttons(d).find(x => ${N.launch}.test(x.name)); const line = window.__na.text(document.getElementById('team-recap')); const go = document.getElementById('launch-team-go'); return { disabled: !!b && b.disabled, line, described: go.getAttribute('aria-describedby') }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNT(ev); await stubModels(ev);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); window.__cliFound = false; const real = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href); if (p.pathname === '/api/system/cli-check') return Promise.resolve(new Response(JSON.stringify(window.__cliFound ? { found: true, version: '1', status: 'available' } : { found: false, status: 'missing', agent_type: p.searchParams.get('type') }), { status: 200, headers: { 'Content-Type': 'application/json' } })); return real(u, o); }; true`);
        await openNewTeam(ev, waitFor);
        await t.to(3, {});
        await waitFor(`document.getElementById('launch-team-go').disabled`, 'Launch team is off while the CLI is missing', 8000);
        const off = await launchState();
        assert.equal(off.disabled, true, 'Launch team is off: ' + JSON.stringify(off));
        assert.match(off.line, /CLI (was )?not found/i, 'the line above the buttons names the reason: ' + JSON.stringify(off));
        assert.match(off.line, /Settings/, 'and the fix: ' + JSON.stringify(off));
        assert.equal(off.described, 'team-recap', 'Launch team is described by that line: ' + JSON.stringify(off));
        await shot('new-team-launch-reason');
        // the CLI is there: the recap is back and Launch team is on
        await ev(`window.__cliFound = true; document.querySelectorAll('#launch-step-team .acf-cli-warning [data-on-click], #launch-step-team .acf-cli-warning button').forEach(b => { if (/Check again/.test(b.textContent)) b.click(); }); true`);
        await waitFor(`!document.getElementById('launch-team-go').disabled`, 'Launch team is on once the CLI is found', 8000);
        await settle(300);
        const on = await launchState();
        assert.equal(on.disabled, false, 'Launch team is on: ' + JSON.stringify(on));
        assert.match(on.line, /: \d+ members, /, 'the recap is back: ' + JSON.stringify(on));
        console.log('PASS New team step 3 names why Launch team is off (the CLI missing, its fix) and the recap returns when it is there');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
