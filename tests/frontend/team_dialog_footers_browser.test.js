// One footer for the team dialogs (#16361, Beta Tester's walk #16340, the rule of #15816): Cancel then the one Primary at the right, a destructive Quiet button alone at the far left, nothing else crowding the
// footer. New agent no longer has Cancel on the left; the Edit member dialog's footer is Remove from team, Back, Cancel and Save member (Move up and Move down are in the dialog's header); the Stop agents
// confirmation keeps Cancel then its button at the right. 1280 and 390 px, light and dark.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await require('./helpers/settings_guard').guardSettings();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await ev(framesJs(3)); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const problems = [];
    // the footer's visible buttons, left to right, with where they sit in the dialog
    const footer = sel => ev(`(() => { const f = document.querySelector(${JSON.stringify(sel)}); if (!f) return null; const box = (f.closest('.modal-content') || f).getBoundingClientRect(); const bs = [...f.querySelectorAll('button')].filter(b => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden').map(b => { const r = b.getBoundingClientRect(); return { text: b.textContent.trim(), id: b.id, l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), quiet: b.classList.contains('btn-quiet'), primary: b.classList.contains('btn-primary') }; }).sort((a, b) => a.l - b.l || a.t - b.t); return { box: [Math.round(box.left), Math.round(box.right)], bs }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, theme] of [[1280, 800, false, 'dark'], [1280, 800, false, 'light'], [390, 844, true, 'dark'], [390, 844, true, 'light']]) {
            const tag = `${w}-${theme}`, check = (ok, msg) => { if (!ok) problems.push(`${tag}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile, maxTouchPoints: 5 });
            await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`import((window.__coralStatic || '/static/') + 'settings_core.js').then(m => m.applyTheme('${theme}')).then(() => true)`);
            // the Stop agents confirmation: Cancel, then its button, at the right
            await ev(`window.showConfirmModal('Stop agents', 'Stop all 3 agents in "x"?', () => {}, undefined, { label: 'Stop agents', danger: true }); true`);
            await waitFor(`document.getElementById('confirm-modal').getClientRects().length > 0`, `${tag}: the confirmation`, 6000);
            const c = await footer('#confirm-modal .modal-actions');
            check(c && c.bs.map(b => b.text).join('|') === 'Cancel|Stop agents', `confirmation: Cancel then Stop agents: ${JSON.stringify(c && c.bs.map(b => b.text))}`);
            check(c && c.bs[0].l > c.box[0] + (c.box[1] - c.box[0]) / 3, `confirmation: Cancel is at the right, not the left: ${JSON.stringify(c)}`);
            await ev(`document.getElementById('confirm-modal').querySelector('.modal-actions button').click(); true`);
            // New agent: Cancel and the Primary together at the right
            await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('agent'); return true; })()`);
            await waitFor(`!!document.querySelector('#launch-step-agent .modal-actions')?.getClientRects().length && getComputedStyle(document.getElementById('launch-step-agent')).display !== 'none'`, `${tag}: New agent`, 8000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the step draws
            const a = await footer('#launch-step-agent > .modal-actions');
            check(a && a.bs.length >= 2, `New agent has its footer buttons: ${JSON.stringify(a)}`);
            if (a && a.bs.length >= 2) {
                const half = a.box[0] + (a.box[1] - a.box[0]) / 3;
                check(a.bs[0].l > half, `New agent: Cancel is not at the left (the first button starts at ${a.bs[0].l}, the dialog's left third ends at ${Math.round(half)}): ${JSON.stringify(a.bs.map(b => [b.text, b.l]))}`);
                check(a.bs[a.bs.length - 1].primary && a.bs[a.bs.length - 2].text === 'Cancel' || a.bs.some(b => b.text === 'Back'), `New agent: the Primary is last: ${JSON.stringify(a.bs.map(b => b.text))}`);
            }
            await shot(`footer-new-agent-${tag}`);
            await ev(`window.hideLaunchModal(); true`);
            // Edit member: Remove from team alone at the far left; Back, Cancel, Save member at the right; Move up and Move down not in the footer
            await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('team'); return true; })()`);
            await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none' && document.querySelectorAll('#team-agents-list .team-agent-row').length >= 3`, `${tag}: the default team`, 8000);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_steps.js'); m.showTeamStep('members'); return true; })()`);
            await ev(`document.querySelectorAll('#team-agents-list .team-agent-row')[2].querySelector('button').click(); true`);
            await waitFor(`document.getElementById('launch-agent-title-text').textContent === 'Edit member' && document.getElementById('launch-agent-save').getClientRects().length > 0`, `${tag}: Edit member`, 8000);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: the step draws
            const m = await footer('#launch-step-agent > .modal-actions');
            const words = m.bs.map(b => b.text);
            check(JSON.stringify(words.slice().sort()) === JSON.stringify(['Back', 'Cancel', 'Remove from team', 'Save member']), `Edit member's footer is Remove from team, Back, Cancel, Save member: ${JSON.stringify(words)}`);
            check(words[0] === 'Remove from team' && m.bs[0].quiet, `Remove from team is a Quiet button alone at the far left: ${JSON.stringify(m.bs.map(b => [b.text, b.l]))}`);
            const rest = m.bs.slice(1);
            check(rest.length === 3 && rest[0].l > m.box[0] + (m.box[1] - m.box[0]) / 4 && rest[rest.length - 1].text === 'Save member' && rest[rest.length - 2].text === 'Cancel', `Back, Cancel, Save member sit together at the right, Cancel before the Primary: ${JSON.stringify(rest.map(b => [b.text, b.l]))}`);
            const moves = await ev(`['up', 'down'].map(d => { const b = document.getElementById('launch-agent-move-' + d); return { text: b.textContent.trim(), shown: b.getClientRects().length > 0, inFooter: !!b.closest('.modal-actions'), inHeader: !!b.closest('.sd-step-header'), h: Math.round(b.getBoundingClientRect().height) }; })`);
            check(moves.every(x => x.shown && !x.inFooter && x.inHeader), `Move up and Move down are shown in the dialog's header, not its footer: ${JSON.stringify(moves)}`);
            if (mobile) check(moves.every(x => x.h >= 44), `and they are 44 px targets: ${JSON.stringify(moves)}`);
            await shot(`footer-edit-member-${tag}`);
            await ev(`document.getElementById('launch-agent-cancel').click(); true`);
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`);
        }
    } finally { await guard.restore(); await client.close(); }
    assert.deepEqual(problems, [], '\n' + problems.join('\n'));
    console.log('PASS the team dialogs share one footer');
})().catch(e => { console.error(e); process.exit(1); });
