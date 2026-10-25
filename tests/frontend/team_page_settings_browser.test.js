// The team page's Settings tab (#7453, stage 2; UI/UX's doc 7aa984fe item 7, the approved panel design as a tab): sections Workflow, Health check, Messaging and Prompts; each setting a row with its label and hint at
// the left and its control at the right (a select named "Working mode", switches named "Require a goal", "Send health check", "Post when all is well"); a bar pinned at the bottom with a status line ("No changes to
// save."), Cancel at the left and Save settings at the right, Save off until something changes; a change turns the status on and Save on; Cancel puts it back; Save sends the change and the page says it saved.
// Written failing-first by QA (#7499): by role and accessible name (helpers/team_page.js). Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const VIEWS = [['1280x800', 1280, 800, false], ['390x844', 390, 844, true]];
const TEAM = `qa-settings-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const bar = () => ev(`(() => { const save = window.__tp.find('button', /^Save settings$/i), cancel = window.__tp.find('button', /^Cancel$/i); const st = [...window.__tp.page().querySelectorAll('[role=status], output, p, div')].filter(window.__na.vis).map(e => window.__na.text(e)).find(t => /No changes to save|Unsaved|changes? (to|not)|Saved/i.test(t) && t.length < 80) || ''; return { save: save ? { disabled: save.disabled || save.getAttribute('aria-disabled') === 'true', ...window.__na.box(save) } : null, cancel: cancel ? window.__na.box(cancel) : null, status: st.trim(), vh: innerHeight }; })()`);
    const sw = n => `(() => { const e = [...window.__tp.page().querySelectorAll('[role=switch], input[type=checkbox]')].filter(window.__na.vis).find(x => window.__na.name(x) === ${JSON.stringify(n)}); return e; })()`;
    const state = n => ev(`(() => { const e = ${sw(n)}; return e ? (e.getAttribute('aria-checked') || String(e.checked)) : null; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of VIEWS) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM).catch(() => {});
            await S.run(`${label}: Settings has the sections Workflow, Health check, Messaging and Prompts, and a select named Working mode`, async () => {
                await goTab(ev, settle, 'Settings'); await settle(500);
                const heads = await ev(`[...window.__tp.page().querySelectorAll('h2, h3')].filter(window.__na.vis).map(e => window.__na.text(e).trim())`);
                for (const n of ['Workflow', 'Health check', 'Messaging', 'Prompts']) assert.ok(heads.includes(n), `a section heading ${n} (got ${JSON.stringify(heads)})`);
                assert.ok(await ev(`!!window.__tp.find('select', /^Working mode$/i)`), 'a select named Working mode');
            });
            await S.run(`${label}: the switches "Require a goal", "Send health check" and "Post when all is well" are described by their hint`, async () => {
                for (const n of ['Require a goal', 'Send health check', 'Post when all is well']) {
                    const s = await ev(`(() => { const e = ${sw(n)}; return e ? { described: !!(e.getAttribute('aria-describedby') && document.getElementById(e.getAttribute('aria-describedby'))) } : null; })()`);
                    assert.ok(s, `a switch named ${n}`); assert.ok(s.described, `${n} is described by its hint`);
                }
            });
            if (!mobile) await S.run(`${label}: a row has its label and hint at the left and its control at the right`, async () => {
                const r = await ev(`(() => { const e = ${sw('Require a goal')}; const l = [...window.__tp.page().querySelectorAll('label, span, div, p')].filter(window.__na.vis).find(x => window.__na.text(x).trim() === 'Require a goal'); return e && l ? { label: window.__na.box(l), control: window.__na.box(e) } : null; })()`);
                assert.ok(r, 'the label and the switch are found'); assert.ok(r.control.x > r.label.x + r.label.w, `the control (x ${r.control.x}) is right of the label (ends ${r.label.x + r.label.w})`);
            });
            await S.run(`${label}: the bar is pinned at the bottom: status "No changes to save.", Cancel at the left, Save settings at the right, Save off`, async () => {
                const b = await bar(); assert.ok(b.save && b.cancel, 'Cancel and Save settings are there');
                assert.match(b.status, /No changes to save/, `the status says there is nothing to save (got ${JSON.stringify(b.status)})`);
                assert.equal(b.save.disabled, true, 'Save settings is off'); assert.ok(b.cancel.x < b.save.x, 'Cancel is left of Save settings');
                assert.ok(b.vh - (b.save.y + b.save.h) <= 24, `the bar is at the bottom of the screen (${b.vh - (b.save.y + b.save.h)} px under it)`);
                await ev(`window.scrollTo(0, 0); true`); const b2 = await bar(); assert.ok(Math.abs(b2.save.y - b.save.y) <= 1, 'the bar does not scroll away');
            });
            await S.run(`${label}: a change turns Save on and the status moves on; Cancel puts the switch back and the bar as it was`, async () => {
                const was = await state('Require a goal');
                await ev(`${sw('Require a goal')}.click(); true`); await settle(250);
                const b = await bar(); assert.equal(b.save.disabled, false, 'Save settings is on'); assert.ok(!/No changes to save/.test(b.status), `the status moved on (got ${JSON.stringify(b.status)})`);
                await ev(`window.__tp.find('button', /^Cancel$/i).click(); true`); await settle(250);
                assert.equal(await state('Require a goal'), was, 'Cancel put the switch back'); const b2 = await bar(); assert.equal(b2.save.disabled, true, 'Save is off again'); assert.match(b2.status, /No changes to save/, 'the status is back');
            });
            await S.run(`${label}: Save settings sends the board's settings once and the status says it saved`, async () => {
                await ev(`window.__tp.record(); ${sw('Require a goal')}.click(); true`); await settle(250);
                await ev(`window.__tp.find('button', /^Save settings$/i).click(); true`); await settle(900);
                const sent = await ev(`window.__writes.filter(x => /\\/settings$/.test(x.p))`); assert.equal(sent.length, 1, `one write to the settings (${JSON.stringify(sent.map(x => x.m + ' ' + x.p))})`);
                const b = await bar(); assert.match(b.status, /Saved|saved/, `the status says it saved (got ${JSON.stringify(b.status)})`); assert.equal(b.save.disabled, true, 'Save is off after saving');
            });
        }
        await removeBoards(ev, [TEAM]); S.finish(); // finish() exits the process, so the board goes first
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
