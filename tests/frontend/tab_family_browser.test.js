// The text tab strip as the page draws it (Goal #88, #9210; the top bar, the dock and the history tabs join it in #9328): the team page's tabs and the goal screen's Tasks | Artifacts tabs are one family: 13 px, weight 500 (600 chosen), a 2 px underline that is the accent on the chosen tab and
// transparent on the others, a count badge in one style, 40 px high (44 on touch), and the strip's own line under it. A real board and goal on the isolated dev server (removed again); 1280 and 390, both themes, with shots.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    const B = 'tabs-' + Date.now().toString(36);
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const theme = t => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'settings_core.js'); m.clearCustomThemeVars(); m.applyTheme('${t}'); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'o-s' })).status < 300);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Tabs goal', outcome: 'One strip', done_when: 'Both look alike' }); assert.equal(g.status, 201);
        const G = g.body.id;
        assert.equal((await api('PATCH', `/api/board/${B}/goals/${G}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
        assert.ok((await api('POST', `/api/board/${B}/tasks`, { title: 'A task', body: 'x', created_by: 'orch', priority: 'medium', assigned_to: 'orch', goal_id: G })).status < 300);
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + `/team/${B}/goals/${G}` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await waitFor(`!!document.querySelector('#team-panel-goals #goal-tab-tasks') && !!document.querySelector('#team-tabs .tab[aria-selected=true]')`, 'the tab strips', 20000);
            const m = await ev(`(() => { const g = el => { const cs = getComputedStyle(el), r = el.getBoundingClientRect(); return { cls: el.className, h: Math.round(r.height), size: cs.fontSize, weight: cs.fontWeight, color: cs.color, line: cs.borderBottomWidth + ' ' + cs.borderBottomColor }; };
                const acc = (() => { const t = document.createElement('i'); t.style.color = 'var(--accent)'; document.body.append(t); const c = getComputedStyle(t).color; t.remove(); return c; })();
                const team = [...document.querySelectorAll('#team-tabs .tab')].filter(t => t.getClientRects().length), goal = [...document.querySelectorAll('#team-panel-goals .goal-tabs .tab')];
                const on = ts => ts.find(t => t.getAttribute('aria-selected') === 'true'), off = ts => ts.find(t => t.getAttribute('aria-selected') !== 'true');
                const counts = [...document.querySelectorAll('.team-tab .tab-count, .goal-tab .tab-count')].filter(c => c.getClientRects().length).map(c => { const cs = getComputedStyle(c); return { size: cs.fontSize, weight: cs.fontWeight, radius: cs.borderTopLeftRadius }; });
                return { acc, teamOn: g(on(team)), teamOff: g(off(team)), goalOn: g(on(goal)), goalOff: g(off(goal)), counts, teamStrip: getComputedStyle(document.getElementById('team-tabs')).borderBottomWidth }; })()`);
            if (mobile) { // #9377: at 200% text the team tabs are wider than the strip: it says which edge hides more, with the text size changed after the page loaded
                await ev(`document.documentElement.style.fontSize = '32px'; true`); await new Promise(r => setTimeout(r, 500)); // sleep-ok: the observer draws the cue after the reflow
                const cue = await ev(`(() => { const s = document.getElementById('team-tabs'); return { scrolls: s.scrollWidth > s.clientWidth + 1, more: s.getAttribute('data-more') || '' }; })()`);
                assert.ok(cue.scrolls && cue.more, 'the team tabs scroll at 200% text and fade the hidden edge: ' + JSON.stringify(cue));
                await ev(`document.documentElement.style.fontSize = ''; true`);
            }
            const want = mobile ? 44 : 40;
            for (const [n, t] of [['team', m.teamOn], ['goal', m.goalOn]]) {
                assert.ok(t.cls.split(' ').includes('tab'), at + `the ${n} tab is a .tab: ` + t.cls);
                assert.equal(t.size, '13px', at + `${n}: 13 px`); assert.equal(t.weight, '600', at + `${n}: the chosen tab is 600`);
                assert.ok(t.h >= want && t.h <= want + 2, at + `${n}: ${want} px high: ` + t.h);
                assert.equal(t.line.split(' ').slice(1).join(' '), m.acc, at + `${n}: the chosen tab's underline is the accent: ` + t.line);
            }
            for (const [n, t] of [['team', m.teamOff], ['goal', m.goalOff]]) { assert.equal(t.weight, '500', at + `${n}: an unchosen tab is 500`); assert.match(t.line, /rgba\(0, 0, 0, 0\)|transparent/, at + `${n}: an unchosen tab's underline is transparent: ` + t.line); }
            assert.equal(new Set(m.counts.map(c => JSON.stringify(c))).size, 1, at + 'the counts are one style: ' + JSON.stringify(m.counts));
            // the top bar's tabs (1280 only: a phone has the view list), the dock's and the history's are the same strip, found by their classes where they are not on screen (#9328)
            const strips = await ev(`(() => { const on = document.querySelector('.top-nav-tabs .tab.active, .top-nav-tabs .tab[aria-current]'); const cs = on && getComputedStyle(on); const acc = (() => { const t = document.createElement('i'); t.style.color = 'var(--accent)'; document.body.append(t); const c = getComputedStyle(t).color; t.remove(); return c; })();
                const bare = sel => [...document.querySelectorAll(sel)].filter(e => !e.classList.contains('tab')).map(e => e.id || e.className);
                return { nav: on && { weight: cs.fontWeight, size: cs.fontSize, line: cs.borderBottomColor, acc, visible: !!on.getClientRects().length }, bareNav: bare('.top-nav-tab'), bareDock: bare('.agentic-tab'), bareHistory: bare('.history-tab-btn'), tabsNav: document.querySelector('.top-nav-tabs').classList.contains('tabs'), tabsDock: document.querySelector('.agentic-state-tabs').classList.contains('tabs'), tabsHistory: document.querySelector('.history-tabs').classList.contains('tabs') }; })()`);
            assert.deepEqual([strips.bareNav, strips.bareDock, strips.bareHistory], [[], [], []], at + 'every top nav, dock and history tab is a .tab: ' + JSON.stringify(strips));
            assert.ok(strips.tabsNav && strips.tabsDock && strips.tabsHistory, at + 'the three strips are .tabs: ' + JSON.stringify(strips));
            if (!mobile) { assert.ok(strips.nav && strips.nav.visible, at + 'the top bar shows a current tab'); assert.equal(strips.nav.size, '13px'); assert.equal(strips.nav.weight, '600'); assert.equal(strips.nav.line, strips.nav.acc, at + 'the current top tab is underlined in the accent'); }
            for (const t of ['dark', 'light']) { await theme(t); await new Promise(r => setTimeout(r, 450)); await shot(`tabs-${t}-${w}`); } // sleep-ok: the theme's colour transition settles
        }
        console.log('PASS tab family: the team page tabs and the goal screen tabs are one strip style: 13/500 (600 chosen), the accent underline, one count style, 40 px (44 on touch)');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
