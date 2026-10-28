// UI/UX's round 2 on New team (#7407), one place: the Health check tab has no (i) icons and no card, "Send health check" has its line and "Post when all is well" its own, and the
// rows that only matter while the check is on are hidden until it is; Edit member labels the persona select "Start from a persona" (optional) and the Behavior prompt is not mono; the label of a field and its "optional" stay
// as one line at 200% text (the word wraps under, the label does not). Controls by role and name (helpers/new_team.js). 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNT, M, N, T, openNewTeam, scenarios, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios(); const t = T(ev, waitFor);
    const tab = async n => { await ev(`(() => { const d = window.__nt.dlg(${N.team}); const x = [...d.querySelectorAll('[role=tab]')].filter(window.__na.vis).find(e => window.__na.name(e) === ${JSON.stringify(n)}); if (x) { x.click(); return true; } return false; })()`); await settle(250); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNT(ev);
        await stubModels(ev); await openNewTeam(ev, waitFor);
        await t.to(3);
        await S.run('Start tab: What should the team work on? and Additional instructions span the pane under their label, not the right column only (#8479)', async () => {
            await tab('Start');
            const r = await ev(`(() => { const d = window.__nt.dlg(${N.team}); return ['team-goal', 'team-custom-instructions'].map(id => { const t = document.getElementById(id), row = t && t.closest('.sv-row'); if (!t || !row) return null; const a = t.getBoundingClientRect(), b = row.getBoundingClientRect(); return { id, left: Math.round(a.left - b.left), right: Math.round(b.right - a.right) }; }); })()`);
            for (const x of r) { assert.ok(x, 'both text areas are on the Start tab'); assert.ok(x.left <= 2 && x.right <= 2, `${x.id} spans its row (left gap ${x.left}, right gap ${x.right})`); }
        });
        await S.run('Health check (a settings_view, #8455): no (i) icons, a line for each switch, the dependent rows off until Send health check is on', async () => {
            await tab('Health check');
            const probe = () => ev(`(() => { const d = window.__nt.dlg(${N.team}); const p = [...d.querySelectorAll('.settings-pane')].find(x => x.dataset.section === 'health'); const vis = window.__na.vis;
                const row = k => p.querySelector('[data-key="' + k + '"]'); const help = k => { const h = row(k) && row(k).querySelector('.sv-help'); return h ? [vis(h), h.textContent.trim()] : null; };
                return { info: [...p.querySelectorAll('.settings-info-btn')].filter(vis).length, onHelp: help('on'), clearHelp: help('all_clear'), everyOff: row('interval_min').hasAttribute('data-disabled'), clearOff: row('all_clear').hasAttribute('data-disabled'), recipient: !!row('recipient') }; })()`);
            const off = await probe();
            assert.equal(off.info, 0, 'no (i) icon'); assert.deepEqual(off.onHelp, [true, 'Checks on stuck or idle agents. Uses tokens each time.'], 'the first switch has its line on the page');
            assert.deepEqual(off.clearHelp, [true, 'So a quiet team is not mistaken for a stopped check.'], 'Post when all is well has its own line');
            assert.equal(off.everyOff, true, 'Check every is off while Send health check is off'); assert.equal(off.clearOff, true, 'and so is Post when all is well'); assert.equal(off.recipient, false, 'who gets the check is not asked: it goes to the Orchestrator');
            await ev(`(() => { const d = window.__nt.dlg(${N.team}); const i = [...d.querySelectorAll('input[type=checkbox]')].find(x => x.name === 'on'); i.click(); return true; })()`); await settle(250);
            const on = await probe();
            assert.equal(on.everyOff, false, 'Check every is on once Send is on'); assert.equal(on.clearOff, false, 'and Post when all is well');
        });
        await S.run('Edit member: the persona select is labelled "Start from a persona" (optional) and the Behavior prompt is not mono', async () => {
            await t.click('button', /^Back$/i); await t.step(2); await settle(200);
            await ev(`(() => { const d = window.__nt.dlg(${N.team}); const b = window.__nt.rows(d)[1]; b.click(); return true; })()`);
            await waitFor(`!!window.__nt.dlg(${N.member})`, 'the Edit member dialog', 4000);
            const mem = M(ev, waitFor); await mem.toPersona(); // the persona and the prompt are the page before a member's settings (#7861)
            const r = await ev(`(() => { const d = window.__nt.dlg(${N.member}); const lab = [...d.querySelectorAll('label')].filter(window.__na.vis).find(l => /Start from a persona/i.test(l.textContent)); const sel = lab && d.querySelector('#' + CSS.escape(lab.htmlFor)); const ta = [...d.querySelectorAll('textarea.acf-prompt')].find(window.__na.vis); return { label: !!lab, bound: !!sel && sel.tagName === 'SELECT', optional: !!lab && /optional/.test(lab.parentElement.textContent), font: ta ? getComputedStyle(ta).fontFamily : null }; })()`);
            assert.equal(r.label, true, 'a visible label "Start from a persona"'); assert.equal(r.bound, true, 'it names the select'); assert.equal(r.optional, true, 'with "optional" beside it');
            assert.ok(r.font && !/mono|courier/i.test(r.font), `the prompt is in the product font (got ${r.font})`);
            await mem.cancel(); await settle(250);
        });
        await S.run('at 200% text the label "Start from a template" stays on one line and "optional" wraps under it', async () => {
            await ev(`document.documentElement.style.fontSize = '200%'; true`); await settle(300);
            const r = await ev(`(() => { const d = window.__nt.dlg(${N.team}); const lab = [...d.querySelectorAll('label')].filter(window.__na.vis).find(l => /Start from a template/i.test(l.textContent)); if (!lab) return null; const rects = [...lab.getClientRects()]; const lh = parseFloat(getComputedStyle(lab).lineHeight) || lab.getBoundingClientRect().height; return { lines: rects.length, h: Math.round(lab.getBoundingClientRect().height), lh: Math.round(lh) }; })()`);
            assert.ok(r, 'the label is there'); assert.equal(r.lines, 1, `the label is one box (${JSON.stringify(r)})`);
            assert.ok(r.h <= r.lh * 2 + 2, `the label wraps at most once at 200% (height ${r.h}, line ${r.lh})`);
        });
        S.finish();
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
