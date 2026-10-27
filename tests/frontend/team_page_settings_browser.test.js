// The team page's Settings tab (#7453, stage 2; UI/UX's doc 7aa984fe item 7, the approved panel design as a tab): sections Workflow, Health check, Messaging and Prompts; each setting a row with its label and hint at
// the left and its control at the right (a select named "Working mode", switches named "Require a goal", "Send health check", "Post when all is well"); a save bar pinned on a wide view, at the scroll end on a narrow view ("No changes to
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
    const bar = () => ev(`(() => { const save = window.__tp.find('button', /^Save settings$/i), cancel = window.__tp.find('button', /^Cancel$/i); const st = [...window.__tp.page().querySelectorAll('[role=status], output, p, div')].filter(window.__na.vis).map(e => window.__na.text(e)).find(t => /^(No changes to save|You have unsaved changes|Saved\.|Could not save)/.test(t.trim()) && t.length < 80) || ''; return { save: save ? { disabled: save.disabled || save.getAttribute('aria-disabled') === 'true', ...window.__na.box(save) } : null, cancel: cancel ? window.__na.box(cancel) : null, status: st.trim(), vh: innerHeight }; })()`);
    const sw = n => `(() => { const e = [...window.__tp.page().querySelectorAll('[role=switch], input[type=checkbox]')].filter(window.__na.vis).find(x => window.__na.name(x) === ${JSON.stringify(n)}); return e; })()`;
    const state = n => ev(`(() => { const e = ${sw(n)}; return e ? (e.getAttribute('aria-checked') || String(e.checked)) : null; })()`);
    // The groups of the page are the main Settings' (#7663): a list at the left (a selector on a phone); one group's pane is open at a time.
    const group = name => ev(`(() => { const page = window.__tp.page(); const tab = [...page.querySelectorAll('[role=tab]')].filter(window.__na.vis).find(t => window.__na.name(t) === ${JSON.stringify(name)}); if (tab) { tab.click(); return 'tab'; }
        const sel = [...page.querySelectorAll('select')].filter(window.__na.vis).find(x => window.__na.name(x) === 'Team settings group'); if (!sel) return null; const o = [...sel.options].find(x => x.textContent === ${JSON.stringify(name)}); if (!o) return null; sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return 'select'; })()`);
    const openFor = async n => { for (const g of ['Workflow', 'Health check', 'Messaging', 'Prompts']) { await group(g); if (await ev(`!!${sw(n)}`)) return g; } return null; };
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
                const how = [];
                for (const n of ['Workflow', 'Health check', 'Messaging', 'Prompts']) {
                    how.push(await group(n)); await settle(150);
                    const heads = await ev(`[...window.__tp.page().querySelectorAll('h4')].filter(window.__na.vis).map(e => window.__na.text(e).trim())`);
                    assert.ok(heads.includes(n), `opening the group ${n} shows its heading (got ${JSON.stringify(heads)})`);
                }
                assert.deepEqual([...new Set(how)], [mobile ? 'select' : 'tab'], 'the groups are a list of tabs at the left on a desktop and a selector on a phone');
                if (!mobile) { const g = await ev(`(() => { const t = [...window.__tp.page().querySelectorAll('[role=tab]')].filter(window.__na.vis).find(x => window.__na.name(x) === 'Workflow'); const pane = [...window.__tp.page().querySelectorAll('h4')].filter(window.__na.vis)[0]; return t && pane ? { tab: window.__na.box(t), pane: window.__na.box(pane), icon: !!t.querySelector('.material-icons') } : null; })()`); assert.ok(g && g.tab.x + g.tab.w <= g.pane.x && g.icon, 'the list is left of the pane and each entry has an icon: ' + JSON.stringify(g)); }
                await group('Workflow'); await settle(150);
                assert.ok(await ev(`!!window.__tp.find('select', /^Working mode$/i)`), 'a select named Working mode');
            });
            await S.run(`${label}: the switches "Require a goal", "Send health check" and "Post when all is well" are described by their hint`, async () => {
                for (const n of ['Require a goal', 'Send health check', 'Post when all is well']) {
                    await openFor(n);
                    const s = await ev(`(() => { const e = ${sw(n)}; return e ? { described: !!(e.getAttribute('aria-describedby') && document.getElementById(e.getAttribute('aria-describedby'))) } : null; })()`);
                    assert.ok(s, `a switch named ${n}`); assert.ok(s.described, `${n} is described by its hint`);
                }
            });
            if (!mobile) await S.run(`${label}: a row has its label and hint at the left and its control at the right`, async () => {
                await openFor('Require a goal');
                const r = await ev(`(() => { const e = ${sw('Require a goal')}; const l = [...window.__tp.page().querySelectorAll('label, span, div, p')].filter(window.__na.vis).find(x => window.__na.text(x).trim() === 'Require a goal'); return e && l ? { label: window.__na.box(l), control: window.__na.box(e) } : null; })()`);
                assert.ok(r, 'the label and the switch are found'); assert.ok(r.control.x > r.label.x + r.label.w, `the control (x ${r.control.x}) is right of the label (ends ${r.label.x + r.label.w})`);
            });
            if (!mobile) await S.run(`${label}: the group list is the main Settings' (arrows move and open a group), and Cancel keeps the open group`, async () => {
                await group('Workflow'); await settle(150);
                const sel = () => ev(`(() => { const t = [...window.__tp.page().querySelectorAll('[role=tab]')].filter(window.__na.vis).find(x => x.getAttribute('aria-selected') === 'true' && ['Workflow', 'Health check', 'Messaging', 'Prompts'].includes(window.__na.name(x))); return t ? window.__na.name(t) : null; })()`);
                assert.equal(await sel(), 'Workflow', 'Workflow is the open group at first');
                await ev(`[...window.__tp.page().querySelectorAll('[role=tab]')].filter(window.__na.vis).find(x => window.__na.name(x) === 'Workflow').focus(); true`);
                await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); true`); await settle(200);
                assert.equal(await sel(), 'Health check', 'ArrowDown opens the next group');
                assert.ok(await ev(`[...window.__tp.page().querySelectorAll('h4')].filter(window.__na.vis).some(h => window.__na.text(h).trim() === 'Health check')`), 'its pane is open');
                await openFor('Send health check');
                await ev(`${sw('Send health check')}.click(); true`); await settle(250);
                await ev(`window.__tp.find('button', /^Cancel$/i).click(); true`); await settle(500);
                assert.equal(await sel(), 'Health check', 'Cancel redraws the page on the group that was open');
            });
            if (mobile) await S.run(`${label}: the group selector's word grows with the text size, and Learn more adds no height to the Working mode hint (UI/UX on #7663)`, async () => {
                await group('Workflow'); await settle(150);
                const at = z => ev(`(() => { document.documentElement.style.fontSize = ${JSON.stringify(z)}; const sel = [...window.__tp.page().querySelectorAll('select')].filter(window.__na.vis).find(x => window.__na.name(x) === 'Team settings group'); const l = window.__tp.find('button', /^Learn more about working modes$/i), a = getComputedStyle(l, '::after'), h = document.getElementById((window.__tp.find('select', /^Working mode$/i).getAttribute('aria-describedby') || '').split(/\\s+/)[0]), lh = parseFloat(getComputedStyle(h).lineHeight) || parseFloat(getComputedStyle(h).fontSize) * 1.4; return { font: parseFloat(getComputedStyle(sel).fontSize), root: parseFloat(getComputedStyle(document.documentElement).fontSize), learnH: l.getBoundingClientRect().height, lh, target: a.position === 'absolute' && parseFloat(a.height) >= 43.5, lines: Math.round(h.getBoundingClientRect().height / lh) }; })()`);
                const n = await at(''), big = await at('32px');
                assert.ok(big.font >= n.font * 1.9, `the selector's word doubles at 200% text (${n.font}px then ${big.font}px)`);
                for (const m of [n, big]) { assert.ok(m.learnH <= m.lh * 1.6, `Learn more is a line high, not a 44 px button (${m.learnH}px for a ${m.lh}px line)`); assert.equal(m.target, true, 'its 44 px touch target is the invisible ::after'); }
                await ev(`document.documentElement.style.fontSize = ''; true`);
            });
            if (mobile) await S.run(`${label}: at 200% text the page scrolls as a whole and the pane keeps its room; the group select is on the input look (UI/UX on 1b)`, async () => {
                await group('Workflow'); await settle(150);
                await ev(`document.documentElement.style.fontSize = '32px'; true`); await settle(300);
                const m = await ev(`(() => { const sv = document.querySelector('#team-settings-workspace .sv-scroll'), panes = sv.querySelector('.settings-panes'), sel = sv.querySelector('.settings-group-pick select'); const cs = getComputedStyle(sel); return { svScroll: getComputedStyle(sv).overflowY, panes: getComputedStyle(panes).overflowY, paneH: panes.getBoundingClientRect().height, vh: innerHeight, selBg: cs.backgroundColor, bg: getComputedStyle(document.body).getPropertyValue('--bg-primary') ? true : false, selBorder: cs.borderTopWidth }; })()`);
                assert.equal(m.svScroll, 'auto', 'the view scrolls as a whole on a short screen'); assert.equal(m.panes, 'visible', 'the pane is not a small scroll box under the bar');
                assert.ok(m.paneH >= m.vh * 0.4, `the pane has at least 40% of the screen (${Math.round(m.paneH)} of ${m.vh} px)`);
                assert.equal(m.selBorder, '1px', 'the group select has the input border, not the browser\'s');
                await ev(`document.documentElement.style.fontSize = ''; true`);
            });
            await S.run(`${label}: the save bar stays reachable: status "No changes to save.", Cancel at the left, Save settings at the right, Save off`, async () => {
                const b = await bar(); assert.ok(b.save && b.cancel, 'Cancel and Save settings are there');
                assert.match(b.status, /No changes to save/, `the status says there is nothing to save (got ${JSON.stringify(b.status)})`);
                assert.equal(b.save.disabled, true, 'Save settings is off'); assert.ok(b.cancel.x < b.save.x, 'Cancel is left of Save settings');
                const narrow = await ev(`(() => { const root=document.querySelector('#team-settings-workspace .sv'); return root.clientWidth <= 24 * parseFloat(getComputedStyle(document.documentElement).fontSize); })()`);
                if (narrow) {
                    // settings_view's 24rem container mode deliberately scrolls the whole
                    // view, with the bar after the pane, so large text keeps reading room.
                    const end = await ev(`(() => {
                        const scroll=document.querySelector('#team-settings-workspace .sv-scroll');
                        scroll.scrollTop=scroll.scrollHeight;
                        const footer=scroll.querySelector('.sv-bar'), shell=scroll.querySelector('.sv-shell'), r=footer.getBoundingClientRect(), box=scroll.getBoundingClientRect();
                        return { overflow:getComputedStyle(scroll).overflowY, panes:getComputedStyle(scroll.querySelector('.settings-panes')).overflowY,
                            after:shell.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING,
                            inside:r.top >= box.top-1 && r.bottom <= box.bottom+1, gap:box.bottom-r.bottom };
                    })()`);
                    assert.equal(end.overflow,'auto','the narrow view scrolls as a whole');
                    assert.equal(end.panes,'visible','the pane keeps its reading room');
                    assert.ok(end.after,'the save bar follows the pane');
                    assert.ok(end.inside && Math.abs(end.gap)<=24,'the whole save bar is reachable at the scroll end: '+JSON.stringify(end));
                    await ev(`document.querySelector('#team-settings-workspace .sv-scroll').scrollTop=0; true`);
                } else {
                    const under = await ev(`(() => { const c = document.querySelector('.team-settings-modal .modal-content').getBoundingClientRect(); return Math.round(c.bottom); })()`); // the popout (#8853): the bar is at the bottom of its dialog
                    assert.ok(under - (b.save.y + b.save.h) <= 24, `the bar is at the bottom of the dialog (${under - (b.save.y + b.save.h)} px under it)`);
                    await ev(`document.querySelector('#team-settings-workspace .settings-panes').scrollTop=10000; true`);
                    const b2=await bar();
                    assert.ok(Math.abs(b2.save.y-b.save.y)<=1,'the wide view save bar does not scroll with its pane');
                }
            });
            await S.run(`${label}: a change turns Save on and the status moves on; Cancel puts the switch back and the bar as it was`, async () => {
                await openFor('Require a goal');
                const was = await state('Require a goal');
                await ev(`${sw('Require a goal')}.click(); true`); await settle(250);
                const b = await bar(); assert.equal(b.save.disabled, false, 'Save settings is on'); assert.match(b.status, /^You have unsaved changes\.$/, `the status says there are unsaved changes (got ${JSON.stringify(b.status)})`);
                await ev(`window.__tp.find('button', /^Cancel$/i).click(); true`); await settle(250);
                assert.equal(await state('Require a goal'), was, 'Cancel put the switch back'); const b2 = await bar(); assert.equal(b2.save.disabled, true, 'Save is off again'); assert.match(b2.status, /No changes to save/, 'the status is back');
            });
            await S.run(`${label}: Save settings sends the board's settings once and the status says it saved`, async () => {
                await openFor('Require a goal');
                await ev(`window.__tp.record(); ${sw('Require a goal')}.click(); true`); await settle(250);
                await ev(`window.__tp.find('button', /^Save settings$/i).click(); true`); await settle(900);
                const sent = await ev(`window.__writes.filter(x => /\\/settings$/.test(x.p))`); assert.equal(sent.length, 1, `one write to the settings (${JSON.stringify(sent.map(x => x.m + ' ' + x.p))})`);
                const b = await bar(); assert.match(b.status, /^Saved\.$/, `the status says Saved. (got ${JSON.stringify(b.status)})`); assert.equal(b.save.disabled, true, 'Save is off after saving');
            });
            await S.run(`${label}: a failed save says "Could not save: <reason>" in the status and Save is on again`, async () => {
                await openFor('Send health check');
                await ev(`(() => { const R = window.fetch.bind(window); window.fetch = (u, o = {}) => (String((o && o.method) || 'GET').toUpperCase() !== 'GET' && /\\/settings$/.test(new URL(String(u), location.origin).pathname)) ? Promise.resolve(new Response(JSON.stringify({ error: 'disk full' }), { status: 500, headers: { 'Content-Type': 'application/json' } })) : R(u, o); ${sw('Send health check')}.click(); return true; })()`); await settle(250);
                await ev(`window.__tp.find('button', /^Save settings$/i).click(); true`); await settle(900);
                const b = await bar(); assert.match(b.status, /^Could not save: /, `the status says it could not save and why (got ${JSON.stringify(b.status)})`); assert.equal(b.save.disabled, false, 'Save settings is on again');
            });
            await group('Workflow'); await settle(150);
            await S.run(`${label}: the Working mode row has one hint line with a Learn more (the old "About working modes"), and the mode's own description stays under the select`, async () => {
                const r = await ev(`(() => { const sel = window.__tp.find('select', /^Working mode$/i); if (!sel) return null; const ids = (sel.getAttribute('aria-describedby') || '').split(/\\s+/); const row = sel.closest('.sv-row'); const h = (document.getElementById(ids[0]) || document.body).closest('.sv-help'); const more = h && h.querySelector('[aria-controls]'); /* the control is described by the sentence alone; its line holds the Learn more too */ const d = document.getElementById(ids[1] || ''); return { hint: h ? window.__na.text(h).replace(/Learn more/, '').trim().split(/\\s{2,}|\\n/)[0] : null, inRow: !!(h && row && row.contains(h)), learn: more ? { name: window.__na.name(more), expanded: more.getAttribute('aria-expanded') } : null, desc: d ? window.__na.text(d).trim() : null, descUnder: !!(d && sel.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING) }; })()`);
                assert.ok(r, 'a select named Working mode'); assert.match(r.hint, /^Instructions are saved with each task when it is first claimed\./); assert.equal(r.inRow, true, 'the hint is in the Working mode row');
                assert.deepEqual(r.learn, { name: 'Learn more about working modes', expanded: 'false' }, 'a Learn more, closed');
                assert.equal(r.desc, 'No extra guidance.'); assert.equal(r.descUnder, true, 'the mode description is under the select');
                await ev(`window.__tp.find('button', /^Learn more about working modes$/i).click(); true`); await settle(200);
                const open = await ev(`(() => { const m = document.getElementById(window.__tp.find('button', /^Show less about working modes$/i).getAttribute('aria-controls')); const a = m && m.querySelector('a'); return { shown: !!m && !m.hidden, text: m ? window.__na.text(m).trim() : '', link: a ? window.__na.text(a).trim() : null }; })()`);
                assert.equal(open.shown, true); assert.match(open.text, /Tasks already claimed keep their instructions\. This setting gives guidance; it does not create worktrees by itself\./); assert.equal(open.link, 'Team working modes');
            });
            // The leave question moved here from team_settings_keyboard when the right dock went (#7457): leaving the team page for another page with an unsaved change asks; Escape stays and keeps the change; Leave goes.
            if (!mobile) await S.run(`${label}: leaving the team page with an unsaved change asks first; Escape stays on the page with the change kept, and Leave goes`, async () => {
                const shown = `(() => { const m = document.getElementById('confirm-modal'); return !!m && getComputedStyle(m).display !== 'none' && m.getClientRects().length > 0; })()`;
                await openFor('Require a goal');
                const was = await state('Require a goal');
                await ev(`${sw('Require a goal')}.click(); true`); await settle(250);
                const go = () => ev(`(() => { const r = document.querySelector('#live-sessions-list li[data-session-id]'); if (!r) return false; r.click(); return true; })()`);
                assert.ok(await go(), 'a row in the sidebar to leave for');
                await waitFor(shown, 'the unsaved-settings question', 5000);
                assert.match(await ev(`document.getElementById('confirm-modal').innerText`), /Team settings have unsaved changes\. Leave without saving\?/, 'the question is the unsaved-settings one');
                await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
                await waitFor(`!(${shown})`, 'the question closed by Escape', 5000);
                assert.ok(await ev(`window.__tp.tablist() !== null`), 'Escape stayed on the team page');
                assert.notEqual(await state('Require a goal'), was, 'and the change is kept');
                assert.ok(await go(), 'leave again'); await waitFor(shown, 'the question again', 5000);
                await ev(`document.getElementById('confirm-modal-yes').click(); true`);
                await waitFor(`window.__tp.tablist() === null`, 'the team page is left after Leave', 5000);
            });
        }
        await removeBoards(ev, [TEAM]); S.finish(); // finish() exits the process, so the board goes first
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
