// After a team is launched the keyboard goes where the person types next on a computer, and to the page's heading on a touch screen (Mobile recheck, #10342, #10281): the team's message box took the focus, which raised the
// on-screen keyboard over the team's page before the person had looked at it. The rule is the password dialog's (#10067): a coarse pointer gets the heading, a fine one the box. _openLaunchedTeam is what Launch team
// calls once the agents are up, with and without a first task (a team with a first task took no focus at all on a desktop, Beta #10401 moment 3). At 1280 px with a mouse and at 390 px with touch; the isolated dev server, a board made through the API.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const BOARD = 'team-focus-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const S = `(window.__coralStatic || '/static/')`;
    const where = () => ev(`(() => { const a = document.activeElement; return !a || a === document.body ? 'the page (nothing)' : a.tagName.toLowerCase() + (a.id ? '#' + a.id : ''); })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, touch, want] of [[1280, 800, false, 'textarea#mb-post-input'], [390, 844, true, 'h1#team-page-title']]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${w}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: touch }); await Emulation.setTouchEmulationEnabled({ enabled: touch });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`fetch('/api/board/${BOARD}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator' }) }).then(r => r.status)`);
            await ev(`window.__posted = []; { const R = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href).pathname; if (p === ${JSON.stringify('/api/board/' + BOARD + '/messages')} && String(o.method).toUpperCase() === 'POST') { window.__posted.push(String(o.body || '')); return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })); } return R(u, o); }; } true`); // the first task's post answers ok (and is recorded): a task that really goes out, so the first-task case is not the one that falls back to the box
            for (const goal of ['', 'Say hello to the team']) {
            // as a launch goes: the dialog was opened from a button and is hidden when Launch is pressed, which puts the keyboard back on that button; the team page opens after
            await ev(`(async () => { document.getElementById('kb-opener')?.remove(); const b = document.body.appendChild(Object.assign(document.createElement('button'), { id: 'kb-opener', textContent: 'New agent' })); b.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999'; b.focus(); await window.showLaunchModal(); await new Promise(r => setTimeout(r, 300)); window.hideLaunchModal(); await new Promise(r => setTimeout(r, 300)); return true; })()`); // sleep-ok: the dialog's open and close transitions
            await ev(`import(${S} + 'team_dialogs.js').then(m => m._openLaunchedTeam('local', ${JSON.stringify(BOARD)}, ${JSON.stringify(goal)}, [{ name: 'Boss' }], Promise.resolve())).then(() => true)`);
            await waitFor(`!!document.getElementById('team-page-view') && document.getElementById('team-page-view').getClientRects().length > 0 && !!document.getElementById('mb-post-input')`, `${w}: the team page`, 15000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the page settles after it opens
            const got = await where();
            if (goal) check((await ev(`window.__posted.length`)) >= 1, `the first task went out (${await ev('window.__posted.length')} posted): the case under test is a task that was sent`);
            check(got === want, `after the team launches ${goal ? 'with a first task' : 'with none'} the keyboard is on ${want} (it is on ${got})`);
            await ev(`window.exitTeamPage && window.exitTeamPage({ force: true }); true`);
            }
        }
    } finally { await removeBoards(ev, [BOARD]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'the keyboard after Launch team:\n  ' + problems.join('\n  '));
    console.log('PASS the keyboard after Launch team: the box with a mouse, the heading on touch');
})().catch(e => { console.error(e); process.exit(1); });
