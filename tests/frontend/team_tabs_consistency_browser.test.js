// UI/UX's 170 consistency list, items 3 to 5 (task 7685): the team page's tabs start at one left edge and one height under the tab strip, the chosen chip is one style on Goals, Tasks and Agents, and Artifacts and Knowledge
// draw their empty state the one way (14/400, an optional 12/400 hint, no box). Item 2 (the back links) is measured in back_links_one_style. Real isolated dev server (helpers/team_page.js).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const VIEWS = [['1280x800', 1280, 800, false], ['390x844', 390, 844, true]];
const TEAM = `qa-consist-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    // Where a tab's first row starts, from the page edge of its panel and from the bottom of the tab strip: its search box, or its chips.
    const start = () => ev(`(() => { const p = document.querySelector('[role=tabpanel]:not([hidden])'), strip = window.__tp.tablist().getBoundingClientRect(), pr = p.getBoundingClientRect();
        const e = [...p.querySelectorAll('input.list-bar-search, .team-chips, .goals-chips-row, .team-agents-top')].find(x => window.__na.vis(x) && x.getBoundingClientRect().height > 0); if (!e) return null;
        const q = e.getBoundingClientRect(); return { left: Math.round(q.left - pr.left), under: Math.round(q.top - strip.bottom), what: e.className }; })()`);
    const chip = sel => ev(`(() => { const e = [...document.querySelectorAll('[role=tabpanel]:not([hidden]) ${sel}')].find(x => (window.__na.vis(x) || x.closest('.team-tb-pills')) && x.getAttribute('aria-pressed') === 'true'); /* the pills are the compact select on a phone (#7717): their own style is still read */ if (!e) return null; const c = getComputedStyle(e); return { bg: c.backgroundColor, border: c.borderTopColor, color: c.color, weight: c.fontWeight }; })()`);
    const empty = () => ev(`(() => { const p = document.querySelector('[role=tabpanel]:not([hidden])'); const l = p.querySelector('.empty-state-line'); if (!l) return null; const c = getComputedStyle(l), h = p.querySelector('.empty-state-hint'); const boxed = [l, l.parentElement].some(e => getComputedStyle(e).borderTopStyle !== 'none');
        return { text: l.textContent.trim(), size: c.fontSize, weight: c.fontWeight, boxed, hint: h && [h.textContent.trim(), getComputedStyle(h).fontSize, getComputedStyle(h).fontWeight] }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of VIEWS) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM).catch(() => {});
            await S.run(`${label}: item 3, every tab's search and chips start on the page edge (24 px, 16 on a phone) and 16 px (12) under the strip`, async () => {
                const edge = mobile ? 16 : 24, top = mobile ? 12 : 16;
                for (const tab of ['Goals', 'Board', 'Tasks', 'Agents', 'Artifacts', 'Knowledge']) {
                    await goTab(ev, settle, tab); await settle(600);
                    const at = await start(); assert.ok(at, `${tab} has a search box or chips`);
                    assert.equal(at.left, edge, `${tab}: its first row starts ${at.left} px from the page edge, not ${edge} (${at.what})`);
                    assert.ok(at.under >= top && at.under <= top + 8, `${tab}: its first row is ${at.under} px under the strip, not ${top} (a search box is up to 8 px lower than a button row) (${at.what})`);
                }
                await shot(`${label}-messages`);
            });
            await S.run(`${label}: item 4, the chosen chip is one style on Goals, Tasks and Agents`, async () => {
                const seen = {};
                for (const [tab, sel] of [['Goals', '.goals-chip'], ['Tasks', '.goals-chip'], ['Agents', '.goals-chip']]) { await goTab(ev, settle, tab); await settle(500); seen[tab] = await chip(sel); assert.ok(seen[tab], `${tab} has a chosen chip`); if (tab === 'Agents') await shot(`${label}-agents-chip`); }
                assert.deepEqual(seen.Agents, seen.Goals, `Agents' chosen chip is Goals': ${JSON.stringify(seen)}`); assert.deepEqual(seen.Tasks, seen.Goals, 'and Tasks\'');
            });
            await S.run(`${label}: item 5, Artifacts and Knowledge draw the one empty line (14/400, an optional 12/400 hint, no box)`, async () => {
                await goTab(ev, settle, 'Artifacts'); await waitFor(`!!document.querySelector('[role=tabpanel]:not([hidden]) .empty-state-line')`, 'the Artifacts empty line', 8000);
                const art = await empty(); assert.deepEqual([art.text, art.size, art.weight, art.boxed], ['No artifacts yet.', '14px', '400', false], 'Artifacts: ' + JSON.stringify(art)); await shot(`${label}-artifacts-empty`);
                await goTab(ev, settle, 'Knowledge'); await waitFor(`!!document.querySelector('[role=tabpanel]:not([hidden]) .empty-state-line')`, 'the Knowledge empty line', 8000);
                const kn = await empty(); assert.deepEqual([kn.text, kn.size, kn.weight, kn.boxed], ['No knowledge yet.', '14px', '400', false], 'Knowledge: ' + JSON.stringify(kn));
                assert.deepEqual(kn.hint && kn.hint.slice(1), ['12px', '400'], 'its hint is 12/400: ' + JSON.stringify(kn.hint)); await shot(`${label}-knowledge-empty`);
            });
            await S.run(`${label}: item 5 (Goals, Tasks), a filter with nothing in it draws the same empty line (14/400, no box)`, async () => {
                for (const tab of ['Goals', 'Tasks']) {
                    await goTab(ev, settle, tab); await settle(400);
                    const clicked = await ev(`(() => { const c = [...document.querySelectorAll('[role=tabpanel]:not([hidden]) .goals-chip')].find(x => /\\b0$/.test(x.textContent.trim())); if (!c) return false; c.click(); return true; })()`); // (a phone shows the compact select: the pill is pressed through the DOM)
                    assert.ok(clicked, `${tab} has a filter with nothing in it`); await settle(400);
                    const e = await ev(`(() => { const p = document.querySelector('[role=tabpanel]:not([hidden]) .empty-state'); if (!p) return null; const c = getComputedStyle(p); return { size: c.fontSize, weight: c.fontWeight, boxed: c.borderTopStyle !== 'none', color: c.color, primary: (() => { const t = document.createElement('i'); t.style.color = 'var(--text-secondary)'; document.body.append(t); const v = getComputedStyle(t).color; t.remove(); return v; })() }; })()`); // the empty line is the secondary colour (UI/UX): never as loud as the rows
                    assert.ok(e, `${tab}: its empty line is there`); assert.deepEqual([e.size, e.weight, e.boxed, e.color], ['14px', '400', false, e.primary], `${tab}: ` + JSON.stringify(e));
                    if (tab === 'Tasks') await shot(`${label}-tasks-empty`);
                    await ev(`(() => { const c = [...document.querySelectorAll('[role=tabpanel]:not([hidden]) .goals-chip')].find(x => /^All\\b/.test(x.textContent.trim())); if (c) c.click(); return true; })()`);
                }
            });
            await S.run(`${label}: item 2, a back link is the link colour at 13/500 on the team page, in a group's page and in the Jobs page`, async () => {
                const style = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const c = getComputedStyle(e); return { color: c.color, size: c.fontSize, weight: c.fontWeight }; })()`);
                await goTab(ev, settle, 'Goals'); await settle(400);
                await ev(`(() => { const b = document.createElement('button'); b.className = 'back-link goals-back'; b.id = 'zz-goals-back'; b.textContent = 'x'; document.body.append(b); const g = document.createElement('button'); g.className = 'back-link'; g.id = 'zz-group-back'; g.textContent = 'x'; document.body.append(g); const s = document.createElement('button'); s.className = 'back-link sched-back'; s.id = 'zz-sched-back'; s.textContent = 'x'; document.body.append(s); return true; })()`);
                const a = await style('#zz-goals-back'), g = await style('#zz-group-back');
                assert.deepEqual([a.size, a.weight], ['13px', '500'], 'the team page back link: ' + JSON.stringify(a)); assert.deepEqual(g, a, 'a group page back link is the same: ' + JSON.stringify({ a, g }));
                if (mobile) { const j = await style('#zz-sched-back'); assert.deepEqual(j, a, 'the Jobs page back link is the same: ' + JSON.stringify({ a, j })); }
                const link = await ev(`(() => { const t = document.createElement('a'); t.style.color = 'var(--link-text)'; document.body.append(t); const c = getComputedStyle(t).color; t.remove(); return c; })()`);
                assert.equal(a.color, link, 'it is the link colour: ' + JSON.stringify({ a, link }));
                await ev(`['zz-goals-back', 'zz-group-back', 'zz-sched-back'].forEach(i => document.getElementById(i).remove()); true`);
            });
        }
        console.log('PASS team tabs consistency');
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
    S.finish(); // finish() exits the process, so the board goes first
})().catch(e => { console.error(e); process.exit(1); });
