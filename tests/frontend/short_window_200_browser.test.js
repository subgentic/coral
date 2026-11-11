// 200% zoom on a laptop is a 720 x 450 window (walk 18, #15303): the Board leaves room for its messages beside the alerts offer, the Inbox's welcome buttons are on their rows, the Answer dialog opens at its top with Send and Cancel
// in view, the team's Actions menu fits the window or scrolls to its last item, Edit member's buttons are one row, and New goal's Done when is not under the footer. 720 x 450 at device scale 2, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const { coralReady } = require('./helpers/wait');

const TEAM = `qa-short200-${Date.now() % 100000}`;
const R = `const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), b: Math.round(b.bottom), r: Math.round(b.right) }; };`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const open = async () => {
        await Emulation.setDeviceMetricsOverride({ width: 720, height: 450, deviceScaleFactor: 2, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });

        // 1) the team page: Board with the alerts offer, the Actions menu, New goal
        await open(); await installTP(ev);
        await seed(ev, TEAM); await openTeam(ev, waitFor, TEAM).catch(() => {});
        await ev(`(async () => { document.getElementById('local-auth-banner')?.remove(); document.getElementById('launch-disclosure-banner')?.remove(); localStorage.removeItem('coral-alerts-offered');
            window.Notification = class { static get permission() { return 'default'; } static requestPermission() { return Promise.resolve('default'); } };
            const m = await import((window.__coralStatic || '/static/') + 'alerts_offer.js'); return m.offerAlertsAfterLaunch(); })()`);
        await waitFor(`!!document.getElementById('alerts-offer-banner')`, 'the alerts offer', 4000);
        await goTab(ev, settle, 'Board'); await settle(1200);
        const board = await ev(`(() => { ${R} return { vp: innerHeight, banner: r(document.getElementById('alerts-offer-banner')), tools: r(document.getElementById('mb-tools')), wrap: r(document.querySelector('.mb-messages-wrap')), form: r(document.querySelector('.mb-post-form')), bannerKids: [...document.getElementById('alerts-offer-banner').children].map(r), pad: getComputedStyle(document.getElementById('alerts-offer-banner')).padding, head: r(document.querySelector('.team-page-head')), tabs: r(document.querySelector('.team-tabs-row')), top: r(document.querySelector('header.top-bar')) }; })()`);
        check(board.banner.h <= 56, `the alerts offer is one line, not a block (${board.banner.h} px): ` + JSON.stringify(board));
        check(board.tools.h <= 64, `the Board's search, chips and view switch are one row (${board.tools.h} px): ` + JSON.stringify(board));
        check(board.wrap.h >= 140, `messages get at least 140 px with the alerts offer showing (${board.wrap.h} px): ` + JSON.stringify(board));
        const menu = async () => {
            await ev(`document.getElementById('team-page-more').click(); true`); await settle(500);
            return ev(`(() => { ${R} const m = document.getElementById('team-page-more-menu'); const vp = innerHeight; const rs = r(m); const bad = [];
                for (const i of [...m.querySelectorAll('.menu-item, button')].filter(x => x.getClientRects().length)) { i.scrollIntoView({ block: 'nearest' }); const q = i.getBoundingClientRect(), mm = m.getBoundingClientRect(); if (q.bottom > mm.bottom + 1 || q.top < mm.top - 1 || q.bottom > vp) bad.push(i.textContent.trim().slice(0, 20)); }
                return { menu: rs, vp, bad, n: m.querySelectorAll('.menu-item, button').length }; })()`);
        };
        const mn = await menu();
        check(mn.bad.length === 0 && mn.menu.b <= mn.vp, `every item of the team's Actions menu can be brought whole into the window (cut: ${JSON.stringify(mn.bad)}): ` + JSON.stringify(mn));
        await ev(`document.getElementById('team-page-more').click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
        await goTab(ev, settle, 'Goals'); await settle(600);
        await ev(`(() => { const b = [...document.querySelectorAll('main button')].find(x => /^new goal$/i.test((x.getAttribute('aria-label') || x.textContent).trim()) && x.getClientRects().length); b.click(); return true; })()`);
        await waitFor(`!!document.getElementById('goal-new-done') && document.getElementById('goal-new-done').getClientRects().length`, 'New goal', 6000); await settle(800);
        const goal = await ev(`(() => { ${R} const d = document.getElementById('goal-new-done'); const q = d.getBoundingClientRect(); const hit = document.elementFromPoint(q.x + q.width / 2, Math.min(q.y + q.height / 2, innerHeight - 1)); return { vp: innerHeight, done: r(d), covered: !(hit === d || d.contains(hit)), save: r([...document.querySelectorAll('dialog[open] button')].find(b => /^(create|save)/i.test(b.textContent.trim()))), kids: [...document.querySelector('dialog[open] form, dialog[open]').querySelectorAll('*')].filter(e => e.getClientRects().length && (e.matches('h3, label, textarea, input, .goal-toolbar, .goals-actions, .goals-form-body, .goal-form, .goals-form-head') )).map(e => e.tagName + '.' + String(e.className).split(' ')[0] + JSON.stringify(r(e))) }; })()`);
        check(goal.done.b <= goal.vp && !goal.covered, `New goal's Done when is on the screen and nothing covers it: ` + JSON.stringify(goal));
        await removeBoards(ev, [TEAM]);

        // 2) the Inbox's welcome rows
        await open();
        const S = `(window.__coralStatic || '/static/')`;
        await ev(`window.__realFetch = window.fetch; window.fetch = (u, o) => { const s = String(u), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            if (s.includes('/api/board/projects')) return json([]); if (s.includes('/api/settings') && o && o.method === 'PUT') return json({ ok: true }); return window.__realFetch(u, o); };
            T.state.settings = { ...T.state.settings, inbox_welcome: 'on', inbox_welcome_done: '' }; T.state.liveSessions = []; T.state.servers = []; true`);
        await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .inbox-welcome-name').length === 6`, 'six welcome items', 8000); await settle(600);
        const welcome = await ev(`[...document.querySelectorAll('#group-table-view .inbox-welcome-actions button')].filter(b => b.getClientRects().length).map(b => { const q = b.getBoundingClientRect(); return { t: b.textContent.trim() || b.getAttribute('aria-label'), x: Math.round(q.x), r: Math.round(q.right), w: innerWidth }; })`);
        check(welcome.length >= 6 && welcome.every(b => b.x >= 0 && b.r <= b.w), `each welcome row's button is on the screen (x >= 0, right <= ${720}): ` + JSON.stringify(welcome));

        // 3) the Answer dialog
        const PLAN = 'Here is the plan:\n' + [1, 2, 3, 4].map(n => `${n}. Step ${n}: build the converter, check the rounding and write the notes for the team to read`).join('\n') + '\nDo you approve it?';
        await ev(`window.__asks = [{ board: 'team', kind: 'ask', id: 41, asker: 'Lead', text: ${JSON.stringify(PLAN)}, at: '2026-10-31T01:00:00Z' }]; { const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify(window.__asks), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); } window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.updateInboxTab()); true`);
        await waitFor(`!!document.querySelector('button[aria-label="Answer the question of Lead"]')`, 'the Answer button', 10000);
        await ev(`document.querySelector('button[aria-label="Answer the question of Lead"]').click(); true`);
        await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open]')`, 'the Answer dialog', 4000); await settle(700);
        const ask = await ev(`(() => { ${R} const d = document.querySelector('dialog.inbox-ask-dialog'); return { vp: innerHeight, top: d.scrollTop, dlg: r(d), h2: r(d.querySelector('h2')), send: r(d.querySelector('.inbox-ask-send')), foot: r([...d.querySelectorAll('.inbox-ask-foot button')][0]) }; })()`);
        check(ask.top === 0 && ask.h2.y >= 0, `the Answer dialog opens at its top, with its title in view: ` + JSON.stringify(ask));
        check(ask.send && ask.send.b <= ask.vp && ask.foot && ask.foot.b <= ask.vp, `Send reply and the footer's button are fully in the window without scrolling: ` + JSON.stringify(ask));
        await ev(`document.querySelector('dialog.inbox-ask-dialog')?.close(); true`);

        // 4) Edit member
        await open();
        await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('team'); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step', 8000);
        await ev(`{ const n = document.getElementById('team-board-name'); n.value = 'persona-x'; n.dispatchEvent(new Event('input', { bubbles: true })); const d = document.getElementById('launch-team-dir'); d.value = '/work/x'; d.dispatchEvent(new Event('input', { bubbles: true })); true }`);
        await waitFor(`getComputedStyle(document.getElementById('team-agents-list')).display !== 'none' && document.querySelectorAll('#team-agents-list > *').length > 0`, 'the default members', 8000);
        await ev(`window.showTeamAgentModal(document.querySelector('#team-agents-list > *')); true`);
        await waitFor(`document.getElementById('launch-modal').getAttribute('data-member') === 'edit'`, 'Edit member', 6000); await settle(800);
        const mem = await ev(`(() => { ${R} const act = [...document.querySelectorAll('.launch-wizard > .modal-actions, .launch-modal-step > .modal-actions')].find(e => e.getClientRects().length); return { vp: innerHeight, actions: r(act), btns: [...act.querySelectorAll('.btn')].filter(b => b.getClientRects().length).map(b => b.textContent.trim() + ':' + r(b).y) }; })()`);
        check(mem.actions.h <= 72, `Edit member's footer is one row (${mem.actions.h} px): ` + JSON.stringify(mem));
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
    if (found.length) { console.error('FAIL\n' + found.join('\n')); process.exitCode = 1; } else console.log('PASS the 720 x 450 window: Board, Inbox welcome, Answer, Actions menu, Edit member, New goal');
})().catch(e => { console.error(e); process.exitCode = 1; });
