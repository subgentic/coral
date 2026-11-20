// #20050 (walk #20009 item 1): the team's own Needs you page draws its rows as the Inbox does: the same cards, kind (a pill only for Yes / No, plain text for a question, #20066) in the name line, the same buttons, More last. 1280 and 390 px, light and dark shots with CORAL_SCREENSHOT_DIR.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { install: installTeam, seed } = require('./helpers/team_page');
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'team-cards-' + Date.now().toString(36);
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 600)); /* sleep-ok: the theme colour transition has ended */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installTeam(ev);
            await seed(ev, team);
            await ev(`(() => { const at = n => new Date(Date.now() - n * 60000).toISOString(); window.__asks = [
                { board: ${JSON.stringify(team)}, board_label: 'Team', kind: 'ask', id: 71, asker: 'Designer', text: '@Operator Which colour for the logo?', at: at(3), buttons: [{ id: 1, label: 'Blue', action: 'reply', state: 'pending' }, { id: 2, label: 'Green', action: 'reply', state: 'pending' }, { id: 3, label: 'Red', action: 'reply', state: 'pending' }] },
                { board: ${JSON.stringify(team)}, board_label: 'Team', kind: 'ask', id: 72, asker: 'Dev', text: '@Operator May I delete the old build folder?', at: at(4), buttons: [{ id: 1, label: 'Yes', action: 'reply', state: 'pending' }, { id: 2, label: 'No', action: 'reply', state: 'pending' }] },
                { board: ${JSON.stringify(team)}, board_label: 'Team', kind: 'ask', id: 73, asker: 'QA', text: '@Operator Is the plan fine?', at: at(5) }];
                const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify(window.__asks), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o);
                import((window.__coralStatic || '/static/') + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)); return true; })()`);
            await ev(`window.openTeamPage(${JSON.stringify(team)})`);
            await waitFor(`document.querySelector('#team-tabs [role=tab]')?.getClientRects().length > 0`, `${at}team tabs`, 8000);
            await ev(`window.__tp.allTabs().find(t => window.__tp.tabLabel(t) === 'Needs you').click(); true`);
            await waitFor(`location.pathname.endsWith('/needs') && document.querySelector('#team-panel-needs:not([hidden])')`, `${at}team Needs you panel`, 8000);
            await new Promise(r => setTimeout(r, 1500)); // sleep-ok: the asks arrive
            const info = await ev(`[...document.querySelectorAll('#team-panel-needs tbody tr')].map(tr => tr.className + ' | ' + tr.textContent.replace(/\\s+/g, ' ').slice(0, 60))`);
            const rows = await ev(`[...document.querySelectorAll('#team-panel-needs tbody tr.inbox-kind-row')].map(tr => { const vis = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'; const act = [...tr.querySelectorAll('button, .inbox-row-more-toggle')].filter(vis).filter(b => !b.matches('input, [role=checkbox], .dt-star') && !b.closest('.inbox-kind-icon') && b.closest('.inbox-review-actions, .inbox-answers, .inbox-answers-with-more')).map(b => b.textContent.trim()); const pill = tr.querySelector('[data-badge]'); return { card: tr.classList.contains('inbox-card-tr'), words: act, pill: pill ? pill.getAttribute('data-badge') : '', pillShown: pill ? getComputedStyle(pill, '::after').content : '', radius: getComputedStyle(tr).borderLeftWidth }; })`);
            check(rows.length === 3, `${at}the team page lists its three asks as rows: ` + JSON.stringify(info));
            if (!mobile) check(rows.every(r => r.card), `${at}every row is an Inbox card (tr.inbox-card-tr): ` + JSON.stringify(rows));
            if (!mobile) check(rows.every(r => r.pill === '' || /Permission/.test(r.pill)), `${at}no Yes / No chip, as in the Inbox (mock v3, #20101): ` + JSON.stringify(rows));
            if (!mobile) {
                check(rows.every(r => r.words[r.words.length - 1] === 'More'), `${at}More is the last button of every row: ` + JSON.stringify(rows.map(r => r.words)));
                check(JSON.stringify(rows[0].words) === JSON.stringify(['Blue', 'Green', 'Red', 'Answer', 'Dismiss', 'More']), `${at}a button ask shows its buttons, then Answer, Dismiss, More: ` + JSON.stringify(rows[0].words));
            }
            const geo = await ev(`(() => { const tabs = [...document.querySelectorAll('#team-panel-needs .inbox-needs-tab')].map(t => t.getBoundingClientRect()); const tr = document.querySelector('#team-panel-needs tbody tr.inbox-kind-row'); const av = tr.querySelector('.dt-mail-avatar, .inbox-kind-column, .dt-avatar, .inbox-kind-icon'); const nm = tr.querySelector('.dt-mail-title, td[data-key="agent"] .inbox-review-from, .inbox-row-words'); return { tabs: tabs.length, sameLine: tabs.length === 2 && Math.abs(tabs[0].top - tabs[1].top) < 6 && tabs.every(t => t.height < (innerWidth < 500 ? 50 : 40)),  gap: av && nm ? nm.getBoundingClientRect().left - av.getBoundingClientRect().right : null, rail: getComputedStyle(tr).boxShadow }; })()`);
            check(geo.tabs === 2 && geo.sameLine, `${at}the two tabs are side by side on one line, as in the Inbox: ` + JSON.stringify(geo));
            if (mobile) check(geo.gap !== null && geo.gap < 16, `${at}the name sits next to the avatar as on the Inbox card (4 px there), not 45 px away: ` + JSON.stringify(geo));
            const hd = await ev(`(() => { const dots = [...document.querySelectorAll('#team-panel-needs tbody tr .dt-primary')].filter(e => { const c = getComputedStyle(e, '::before').content; return c && c !== 'none' && c !== 'normal'; }).length; const lines = ['#team-page-health', '#team-page-bar-needs'].filter(q => { const e = document.querySelector(q); return e && e.getClientRects().length; }); const kind = document.querySelector('#team-panel-needs .inbox-folder-toolbar .list-bar-search-row'); const more = kind.querySelector('.needs-more'), sw = kind.querySelector('.list-bar-search-wrap'), sel = [...kind.children].filter(c => c.getClientRects().length).map(c => Math.round(c.getBoundingClientRect().top)); return { dots, lines, moreTop: more && Math.round(more.getBoundingClientRect().top), searchTop: sw && Math.round(sw.getBoundingClientRect().top), searchW: sw && Math.round(sw.getBoundingClientRect().width), rowW: Math.round(kind.getBoundingClientRect().width) }; })()`);
            check(hd.dots === 0, `${at}no unread dot before a name, as in the Inbox: ` + JSON.stringify(hd));
            if (mobile) check(hd.lines.length === 1 && hd.searchW >= hd.rowW - 4 && hd.moreTop > hd.searchTop, `${at}one count line in the header, the search on its own line and More with Kind, the filters and Select under it, as the Inbox phone toolbar: ` + JSON.stringify(hd));
            for (const th of ['light', 'dark']) { await ev(`document.documentElement.setAttribute('data-theme', '${th}'); true`); await shot(`team-${w}-${th}`); } await ev(`document.documentElement.removeAttribute('data-theme'); true`);
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS');
})().catch(e => { console.error(e); process.exit(1); });
