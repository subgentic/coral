// Describe your team opens in place (#15893, LT2; review 5.3 point 2: "the description box opens in place, not in a second dialog"): the box sits under the template row of the Members step,
// inside the New team dialog; no second dialog opens, Escape closes the box and leaves the New team dialog, and the box and its buttons stay inside the dialog at 1280 and 390 px, light and dark,
// at 200% text. SHOT_DIR=<dir> also saves a shot of each. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { install: installNT, N, T, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const t = T(ev, waitFor);
    const problems = [];
    const key = async (k, code) => { const b = { key: k, code: k, windowsVirtualKeyCode: code }; await client.Input.dispatchKeyEvent({ type: 'keyDown', ...b }); await client.Input.dispatchKeyEvent({ type: 'keyUp', ...b }); await settle(150); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) for (const theme of ['light', 'dark']) {
            const at = `${w} ${theme}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile, maxTouchPoints: 5 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installNT(ev); await stubModels(ev);
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); document.documentElement.style.fontSize = '200%'; localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
            await openNewTeam(ev, waitFor); await settle(400);
            await t.type('input', N.teamName, 'alpha'); await t.type('input', N.folder, '/work/payments-app');
            await t.click('button', N.next); await t.step(2); await settle(400);
            const closed = await ev(`(() => { const p = document.getElementById('team-wizard-panel'); return { exists: !!p, hidden: p && (p.hidden || !p.getClientRects().length) }; })()`);
            if (!closed.exists || !closed.hidden) problems.push(`${at}: the box starts closed ${JSON.stringify(closed)}`);
            await ev(`document.getElementById('team-describe').click(); true`);
            await waitFor(`!document.getElementById('team-wizard-panel').hidden`, `${at}: the box opens`, 4000);
            await settle(300);
            const s = await ev(`(() => { const p = document.getElementById('team-wizard-panel'), d = document.querySelector('#launch-modal .modal-content'), r = e => e.getBoundingClientRect(),
                visibleModals = [...document.querySelectorAll('.modal')].filter(m => getComputedStyle(m).display !== 'none' && m.getClientRects().length).map(m => m.id),
                inside = e => { const a = r(e), b = r(d); return a.left >= b.left - 1 && a.right <= b.right + 1; };
                return { inLaunch: !!p.closest('#launch-modal'), underMembers: !!p.closest('#team-panel-members'), visibleModals, textareaInside: inside(document.getElementById('team-wizard-directive')),
                    buttonsInside: ['team-wizard-cancel', 'team-wizard-test-btn', 'team-wizard-generate-btn'].every(id => inside(document.getElementById(id))), pageScroll: document.documentElement.scrollWidth > innerWidth + 1,
                    focus: document.activeElement.id, expanded: document.getElementById('team-describe').getAttribute('aria-expanded') }; })()`);
            if (!s.inLaunch || !s.underMembers) problems.push(`${at}: the box is in the New team dialog's Members step ${JSON.stringify(s)}`);
            if (s.visibleModals.join() !== 'launch-modal') problems.push(`${at}: no second dialog opens: ${s.visibleModals.join()}`);
            if (!s.textareaInside || !s.buttonsInside) problems.push(`${at}: the box and its buttons stay inside the dialog`);
            if (s.pageScroll) problems.push(`${at}: the page scrolls sideways`);
            if (s.focus !== 'team-wizard-directive' || s.expanded !== 'true') problems.push(`${at}: the keyboard is in the box and the button says it is open ${JSON.stringify(s)}`);
            if (process.env.SHOT_DIR) { fs.mkdirSync(process.env.SHOT_DIR, { recursive: true }); const shot = await Page.captureScreenshot({ format: 'png' }); fs.writeFileSync(`${process.env.SHOT_DIR}/describe-${w}-${theme}.png`, Buffer.from(shot.data, 'base64')); }
            await key('Escape', 27);
            const after = await ev(`({ hidden: document.getElementById('team-wizard-panel').hidden, launchOpen: getComputedStyle(document.getElementById('launch-modal')).display !== 'none', focus: document.activeElement.id })`);
            if (!after.hidden) problems.push(`${at}: Escape closes the box`);
            if (!after.launchOpen) problems.push(`${at}: Escape leaves the New team dialog open`);
            if (after.focus !== 'team-describe') problems.push(`${at}: the keyboard goes back to Describe your team (${after.focus})`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Describe your team in place:\n  ' + problems.join('\n  '));
    console.log('PASS Describe your team opens in place: inside the Members step, no second dialog, Escape closes only the box');
})().catch(e => { console.error(e); process.exit(1); });
