// New team wizard footer (#15846, Design D3, guideline 4.8): one footer on all three steps, Back quiet at the left, Cancel and the one Primary (Next, then Launch team) at the right,
// none of them moving between steps; and in Edit member, Remove from team is a Quiet button alone at the far left, grey at rest (the beta tester removed a member by mistake, walk 23).
// Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
        const setup = async (w, h, theme) => {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
            await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`import((window.__coralStatic || '/static/') + 'settings_core.js').then(sc => { sc.clearCustomThemeVars(); sc.applyTheme('${theme}', { remember: false }); return true; })`);
            await require('./helpers/new_team').stubFolders(ev);
            await ev(`(async () => { await window.showLaunchModal(); window.hideLaunchModal(); return true; })()`); // the dialog's markup is a template: it is built on the first open
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_dialogs.js'); window.__pickT = n => m._pickTeamTemplate(n); return true; })()`);
        };
        const step = () => ev(`document.getElementById('launch-step-team').dataset.stage`);
        const rects = () => ev(`(() => { const r = id => { const e = document.getElementById(id), b = e.getBoundingClientRect(), cs = getComputedStyle(e); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), vis: cs.visibility !== 'hidden' && cs.display !== 'none', quiet: e.classList.contains('btn-quiet') }; };
            return { back: r('launch-team-back'), cancel: r('launch-team-cancel'), next: r('launch-team-next'), go: r('launch-team-go') }; })()`);
        const go = async sel => { await ev(`document.querySelector(${JSON.stringify(sel)}).click(); true`); };

        for (const [w, h] of [[1440, 900], [390, 844]]) for (const theme of ['dark', 'light']) {
            const label = `${w} px ${theme}`;
            console.log(`The footer does not move between steps 1 to 3, and Remove is quiet (${label})`);
            await setup(w, h, theme);
            await ev(`window.showLaunchModal(); window._selectLaunchType('team'); true`);
            await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none' && document.querySelectorAll('#team-template-select option').length > 1`, 'the team step');
            await ev(`{ const n = document.getElementById('team-board-name'); n.value = 'crew-1'; n.dispatchEvent(new Event('input', { bubbles: true })); const d = document.getElementById('launch-team-dir'); d.value = '/work/repo'; d.dispatchEvent(new Event('input', { bubbles: true })); } true`);
            const s1 = await rects(); await shot(`team-${w}-${theme}-step1`);
            assert.equal(s1.back.vis, false, 'step 1: Back keeps its place but is not there to press');
            assert.ok(s1.back.quiet, 'Back is Quiet');
            await go('#launch-team-next'); await waitFor(`document.getElementById('launch-step-team').dataset.stage==='members'`, 'members step');
            await ev(`window.__pickT && window.__pickT('Default team'); true`);
            const s2 = await rects(); await shot(`team-${w}-${theme}-step2`);
            await go('#launch-team-next'); await waitFor(`document.getElementById('launch-step-team').dataset.stage==='start'`, 'start step');
            const s3 = await rects(); await shot(`team-${w}-${theme}-step3`);
            assert.ok(s2.back.vis && s3.back.vis, 'Back shows on steps 2 and 3');
            assert.ok(s1.back.l < s1.cancel.l && s1.cancel.l < s1.next.l, `Back, then Cancel, then Next: ${JSON.stringify(s1)}`);
            const foot = await ev(`(() => { const b = document.getElementById('launch-team-back').parentElement.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right) }; })()`);
            assert.ok(s1.back.l - foot.l <= 32, `Back is at the footer's left edge: ${s1.back.l} in ${JSON.stringify(foot)}`);
            assert.ok(foot.r - s1.next.r <= 32, `Next is at the footer's right edge: ${s1.next.r} in ${JSON.stringify(foot)}`);
            for (const [n, s] of [[2, s2], [3, s3]]) {
                assert.equal(s.back.l, s1.back.l, `step ${n}: Back does not move`);
                assert.equal(s.cancel.l, s1.cancel.l, `step ${n}: Cancel does not move`);
            }
            assert.equal(s2.next.l, s1.next.l, 'step 2: Next does not move');
            assert.equal(s3.go.l, s1.next.l, 'step 3: Launch team is where Next was');
            assert.equal(s3.go.r, s1.next.r, 'step 3: Launch team ends where Next ended');
            assert.ok(s3.go.vis && !s3.next.vis, 'step 3 shows Launch team in place of Next');
            await ev(`window.hideLaunchModal(); true`);
        await ev(`window.showLaunchModal(); window._selectLaunchType('team'); true`);
        await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none' && document.querySelectorAll('#team-template-select option').length > 1`, 'the team step');
        await ev(`{ const n = document.getElementById('team-board-name'); n.value = 'crew-2'; n.dispatchEvent(new Event('input', { bubbles: true })); const d = document.getElementById('launch-team-dir'); d.value = '/work/repo'; d.dispatchEvent(new Event('input', { bubbles: true })); } true`);
        await go('#launch-team-next'); await waitFor(`document.getElementById('launch-step-team').dataset.stage==='members'`, 'members step');
        await ev(`window.__pickT && window.__pickT('Default team'); true`);
        await waitFor(`document.querySelectorAll('#team-agents-list .team-agent-row').length >= 2`, 'member rows');
        await ev(`(() => { const rows = [...document.querySelectorAll('#team-agents-list .team-agent-row')]; rows[rows.length - 1].querySelector('button').click(); return true; })()`);
        await waitFor(`!document.getElementById('launch-agent-remove').hidden`, 'Remove from team in Edit member');
        await shot(`member-${w}-${theme}-edit`);
        const rm = await ev(`(() => { const e = document.getElementById('launch-agent-remove'), cs = getComputedStyle(e), b = e.getBoundingClientRect();
            const others = [...e.parentElement.querySelectorAll('.btn')].filter(x => x !== e && x.getBoundingClientRect().width > 0).map(x => x.getBoundingClientRect().left);
            return { quiet: e.classList.contains('btn-quiet'), color: cs.color, bg: cs.backgroundColor, left: b.left, minOther: Math.min(...others) }; })()`);
        assert.ok(rm.quiet, 'Remove is Quiet');
        assert.equal(rm.bg, 'rgba(0, 0, 0, 0)', `no box at rest: ${rm.bg}`);
        const [r, g, b] = rm.color.match(/\d+/g).map(Number);
        assert.ok(Math.abs(r - g) < 40 && Math.abs(g - b) < 40, `grey at rest, not red: ${rm.color}`);
        assert.ok(rm.left <= rm.minOther, `Remove is at the far left (alone on its own line on a phone): ${JSON.stringify(rm)}`);
        }
        console.log('ok');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
