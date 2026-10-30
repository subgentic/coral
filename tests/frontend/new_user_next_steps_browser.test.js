// New-user fixes from Mobile Beta Tester's v2.0.8 phone walkthrough (#11336, #11334): (1) an empty team Board has one next step, a button that asks its lead to plan the first task and starts the message in the box;
// (2) the folder of a team made after the first agent is offered like the first agent's (the person's recent folders are only ones Coral made), a fresh one beside it; (3) the amber no-password banner is one
// short line on a phone with Set a password and Dismiss; (4) plain words in the task and goal forms and the team's members line. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

const TEAM = `qa-next-steps-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const problems = [];
    const check = (ok, what) => { if (!ok) problems.push(what); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        // (1) the empty Board
        for (const [label, w, h, mobile] of [['1280 px', 1280, 800, false], ['390 px', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM); if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM).catch(() => {});
            await ev(`(() => { const R = window.fetch; window.fetch = (u, o) => String(u).includes('/messages/all') ? Promise.resolve(new Response(JSON.stringify({ messages: [], total: 0, before_count: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })) : R(u, o); return true; })()`); // a board nothing was posted on: the seeded one holds the system lines of its goals and tasks
            await goTab(ev, settle, 'Board'); await waitFor(`!!document.querySelector('#mb-messages .mb-empty-board')`, `${label}: the empty board`, 10000).catch(() => {});
            if (process.env.DBG) console.log('DBG', await ev(`(() => { const m = document.getElementById('mb-messages'); return JSON.stringify({ tab: (document.querySelector('[role=tab][aria-selected=true]') || {}).textContent, board: (document.getElementById('mb-board') || {}).style?.display, boardIn: document.getElementById('mb-board')?.parentElement?.id, html: m ? m.outerHTML.slice(0, 200) : null, panelHtml: (document.querySelector('#team-page-view [role=tabpanel]:not([hidden])') || {}).innerHTML?.slice(0, 500), rows: document.querySelectorAll('#team-panel-messages *').length, panel: (document.getElementById('team-panel-messages') || {}).innerText?.slice(0, 300) }); })()`));
            const b = await ev(`(() => { const e = document.querySelector('#mb-messages .mb-empty-board'); const btn = e && e.querySelector('.mb-empty-ask'); return { empty: !!e, text: e ? e.querySelector('p').textContent : null, btn: btn ? btn.textContent : null, btnShown: !!btn && btn.getClientRects().length > 0 }; })()`);
            check(b.empty && /^No messages on the board yet/.test(b.text || ''), `${label}: an empty board says so: ${JSON.stringify(b)}`);
            check(b.btnShown && /^(Ask .+ to plan the first task|Write the first message)$/.test(b.btn || ''), `${label}: and offers one action: ${JSON.stringify(b.btn)}`);
            if (b.btnShown) {
                const target = b.btn.replace(/^Ask (.+) to plan the first task$/, '$1');
                await ev(`document.querySelector('#mb-messages .mb-empty-ask').click(); true`); await settle(200);
                const c = await ev(`(() => { const x = document.getElementById('mb-post-input'); return { value: x.value, focused: document.activeElement === x, caret: x.selectionStart === x.value.length }; })()`);
                check(c.focused && c.caret && (/^Write/.test(b.btn) ? c.value === '' : c.value.startsWith('@' + target + ' ') && /plan the first task/.test(c.value)), `${label}: the button starts the message in the box and gives it the focus: ${JSON.stringify(c)}`);
            }
        }
        // (2) the team's folder after the first agent
        const f = await ev(`import(${S} + 'folder_suggestion.js').then(async m => { const br = await import(${S} + 'browser.js'); const mk = () => { const i = document.createElement('input'); i.dataset.coralRoot = '/home/someone'; return i; };
            const root = '/home/someone'; const only = m.onlyCoralMadeRecents(root, ['/home/someone/Coral/first-agent']), own = m.onlyCoralMadeRecents(root, ['/home/someone/Coral/first-agent', '/home/someone/work']), none = m.onlyCoralMadeRecents(root, []);
            br.recordRecentDir('/home/someone/Coral/first-agent'); const a = mk(); m.offerSuggestion(a, null, 'first-team', { afterCoralMade: true });
            const plain = mk(); m.offerSuggestion(plain, null, 'first-agent');
            br.recordRecentDir('/home/someone/Coral/first-team'); const c = mk(); m.offerSuggestion(c, null, 'first-team', { afterCoralMade: true });
            br.recordRecentDir('/home/someone/work'); const d = mk(); m.offerSuggestion(d, null, 'first-team', { afterCoralMade: true });
            return { only, own, none, team: a.value, plain: plain.value, second: c.value, withOwn: d.value }; })`);
        check(f.only === true && f.own === false && f.none === false, `only Coral-made recents are told apart from a person's own: ${JSON.stringify([f.only, f.own, f.none])}`);
        check(f.team === '/home/someone/Coral/first-team', `a team after the first agent is offered its own folder: ${f.team}`);
        check(f.plain === '', `the first-agent rule is as it was (a recent folder: nothing offered): ${JSON.stringify(f.plain)}`);
        check(f.second === '/home/someone/Coral/first-team-2', `and a fresh one when that name is taken: ${f.second}`);
        check(f.withOwn === '', `a person with a folder of their own is offered nothing: ${JSON.stringify(f.withOwn)}`);
        // (3) the banner
        for (const [w, theme] of [[390, 'light'], [390, 'dark'], [320, 'light']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); const b = document.getElementById('local-auth-banner'); b.hidden = false; b.classList.remove('notice-error'); b.classList.add('notice-warn'); b.querySelector('[data-auth-state=off]').hidden = true; b.querySelector('[data-auth-state=nopw]').hidden = false; document.getElementById('local-auth-set-password').hidden = false; document.getElementById('local-auth-dismiss').hidden = false; true`); await settle(300);
            const g = await ev(`(() => { const b = document.getElementById('local-auth-banner'), r = b.getBoundingClientRect(), vis = e => e.getClientRects().length > 0 && e.getBoundingClientRect().width > 4, d = document.getElementById('local-auth-dismiss'), s = document.getElementById('local-auth-set-password'); return { h: Math.round(r.height), vh: innerHeight, shown: vis(d) && vis(s), text: b.textContent.replace(/\\s+/g, ' ').trim(), seen: [...b.querySelectorAll('[data-auth-state=nopw] > b, .local-auth-more')].map(e => Math.round(e.getBoundingClientRect().width)) }; })()`);
            if (process.env.DBG) console.log('DBG2', await ev(`(() => { const b = document.getElementById('local-auth-banner'); const m = b.querySelector('.local-auth-more'); const cs = getComputedStyle(b); const cs2 = getComputedStyle(b); return JSON.stringify({ bw: Math.round(b.getBoundingClientRect().width), pad: cs2.padding, gap: cs2.gap, more: !!m, moreW: m && Math.round(m.getBoundingClientRect().width), pos: m && getComputedStyle(m).position, wrap: cs.flexWrap, kids: [...b.children].map(e => { const c = getComputedStyle(e); return e.tagName + '[m' + c.margin + ' p' + c.padding + ']'; }).concat([...b.children].map(e => e.tagName + ':' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height))) }); })()`));
            check(g.shown && /No password is set/.test(g.text) && /a browser needs a password to sign in/.test(g.text), `${w} ${theme}: the banner says it, in words a screen reader has whole: ${JSON.stringify(g.text)}`);
            check(g.h <= (w >= 390 ? 72 : 110), `${w} ${theme}: the banner is one short line, ${g.h} px of ${g.vh} (it was a quarter of the screen)`);
        }
        // (4) plain words
        const root = require('node:path').join(__dirname, '..', '..', 'coral-go', 'pkg', 'frontend', 'static'), read = f => require('node:fs').readFileSync(require('node:path').join(root, f), 'utf8'); // the sources that write the words
        const t = read('task_create.js'), g = read('goals_view.js'), d = read('team_dialogs.js');
        const words = { draft: /Hold back as a draft/.test(t) && !/Create as draft/.test(t), order: /Order of work \(advanced\)/.test(t) && !/Workflow and prerequisites/.test(t), start: /Start once the tasks it waits for/.test(t) && !/Proceed when prerequisites/.test(t), driver: /Driver, the agent who looks after it \(optional\)/.test(g), orch: /The Orchestrator plans the work and hands tasks to the others/.test(d) };
        check(Object.values(words).every(Boolean), `plain words in the task form, the goal form and the members line: ${JSON.stringify(words)}`);
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'new-user next steps:\n  ' + problems.join('\n  '));
    console.log('PASS the empty Board has a next step, a team is offered its folder, the banner is one line, the jargon has plain words');
})().catch(e => { console.error(e); process.exit(1); });
