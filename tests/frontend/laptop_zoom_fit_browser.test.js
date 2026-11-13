// A laptop at browser zoom (#15271, walk 14): a 1366x768 screen at 125%, 150%, 175% and 200% is a window of 1093x614, 911x512, 781x439 and 683x384 CSS px. The New team dialog (its three steps) and the member
// editor keep their title and their button row inside the window at each; the sidebar (from 1024 px up; below it is the phone drawer) takes no more than a quarter of the narrow ones (320 px is its width from 1334 px up). (The reply page's Send reply was not
// reproduced at real zoom and is not pinned here.) Real zoom is a smaller window at a higher device scale, not a CSS zoom.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = []; const check = (l, c, d) => { if (!c) problems.push(`${l}${d !== undefined ? ': ' + d : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [W, H] of [[1093, 614], [911, 512], [781, 439], [683, 384]]) {
            await Emulation.setDeviceMetricsOverride({ width: W, height: H, deviceScaleFactor: 1366 / W, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await require('./helpers/new_team').stubFolders(ev); // the folder check answers, so Next goes on
            const tag = `${W}x${H}`;
            const sw = await ev(`document.querySelector('.sidebar').getBoundingClientRect().width`);
            if (W >= 1024) check(`${tag}: the sidebar takes at most 27% of the window (280 px at the narrowest)`, sw <= W * 0.27, `${Math.round(sw)} px of ${W}`);
            const outside = label => ev(`(() => { const m = document.querySelector('#launch-modal .modal-content'), vh = innerHeight, vw = innerWidth, bad = [];
                for (const e of m.querySelectorAll('h3, button, .modal-actions')) { if (e.offsetParent === null || e.closest('[hidden]') || e.closest('.settings-modal-body')) continue; /* the body scrolls: only the title and the button row must stay in the window */ const r = e.getBoundingClientRect(); if (!r.width) continue; if (r.top < 0 || r.bottom > vh + 0.5 || r.left < 0 || r.right > vw + 0.5) bad.push((e.id || e.className || e.tagName) + ' ' + [r.top, r.bottom, r.left, r.right].map(Math.round)); }
                return bad.slice(0, 5); })()`).then(b => check(`${tag}: ${label} keeps its title and buttons in the window`, b.length === 0, JSON.stringify(b)));
            await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('team'); return true; })()`);
            await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, `${tag}: the team step`);
            await waitFor(`!document.getElementById('team-panel-team').hidden`, `${tag}: step 1 shown`);
            await outside('New team step 1');
            await ev(`{ const n = document.getElementById('team-board-name'); n.value = 'laptop-x'; n.dispatchEvent(new Event('input', { bubbles: true })); const d = document.getElementById('launch-team-dir'); d.value = '/work/payments-app'; d.dispatchEvent(new Event('input', { bubbles: true })); } true`);
            for (const [n, panel] of [[2, 'members']]) { await ev(`document.getElementById('launch-team-next').click(); true`); await waitFor(`document.getElementById('launch-step-team').dataset.stage === '${panel}'`, `${tag}: step ${n} shown`); await outside(`New team step ${n}`); }
            await ev(`(async () => { await window.showTeamAgentModal(); return true; })()`);
            await waitFor(`document.getElementById('launch-step-agent')?.dataset.stage === 'persona' && getComputedStyle(document.getElementById('launch-step-agent')).display !== 'none'`, `${tag}: the member's role page`);
            await outside('Add member, the role');
            await ev(`document.querySelector('#launch-step-agent .modal-actions .btn-primary:not([hidden])')?.click(); true`);
            await waitFor(`document.getElementById('launch-step-agent').dataset.stage === 'agent'`, `${tag}: the member's agent page`);
            await outside('Add member, the agent');
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'laptop at browser zoom:\n  ' + problems.join('\n  '));
    console.log('PASS at 125, 150, 175 and 200% of a 1366x768 laptop: New team and the member editor fit the window, the sidebar is narrow');
})().catch(e => { console.error(e); process.exit(1); });
