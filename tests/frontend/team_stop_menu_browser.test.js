// Stopping a team from its page (Beta Tester's pass and Mobile tester's, #10008): the team's page header has a Stop menu with the sidebar row's own words and actions (Sleep Team or Wake Team, then Reset Team and Kill All apart, each asking first),
// a phone's More has the same items, and Pause Board says in words what it does. At 1280 and 390 px; the isolated dev server, a board made through the API, the team's live rows put in the list.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const BOARD = 'stop-menu-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const mk = (id, name, sleeping) => ({ session_id: id, name, display_name: name, agent_type: 'claude', summary: 'x', model: 'claude-opus-5-5', branch: 'main', repo_name: 'coral', working_directory: '/work/' + name, status: 'idle', server: 'local', board_project: BOARD, sleeping });
    const items = host => ev(`[...document.querySelectorAll('${host} [data-stop]:not([data-stop="sep"])')].map(b => ({ key: b.dataset.stop, text: ((b.querySelector('.menu-item-text') || b).firstChild || b).textContent.trim(), hint: ((b.querySelector('.menu-item-hint') || {}).textContent || '').trim(), danger: b.classList.contains('menu-item-danger'), shown: b.getClientRects().length > 0, h: Math.round(b.getBoundingClientRect().height) }))`);
    const dialogText = () => ev(`(() => { const d = [...document.querySelectorAll('dialog[open], .dlg-confirm')].find(e => e.getClientRects().length); return d ? d.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`);
    const closeDialog = () => ev(`(() => { for (const d of document.querySelectorAll('dialog[open]')) { const c = [...d.querySelectorAll('button')].find(b => /^cancel$/i.test(b.textContent.trim())); if (c) c.click(); } return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${w}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`fetch('/api/board/${BOARD}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator' }) }).then(r => r.status)`);
            // a team with no live agent: nothing to put to sleep, reset or kill, and the menu says so
            await ev(`T.state.liveSessions = []; T.render.renderLiveSessions([]); window.openTeamPage(${JSON.stringify(BOARD)}).then(() => true)`);
            await waitFor(`!!document.getElementById('team-page-view') && document.getElementById('team-page-view').getClientRects().length > 0 && document.getElementById('team-page-title').textContent.includes('stop-menu')`, `${w}: the team page, no agents`, 15000);
            await ev(`document.getElementById('${mobile ? 'team-page-more' : 'team-page-stop'}').click(); true`); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the menu opens
            const none = await ev(`[...document.querySelectorAll('${mobile ? '#team-page-more-menu' : '#team-page-stop-menu'} [data-stop]:not([data-stop="sep"])')].map(b => ({ disabled: b.disabled, title: b.title }))`);
            check(none.length === 3 && none.every(x => x.disabled && /No agent of this team is running/.test(x.title)), `with no live agent the three are off, with the reason: ${JSON.stringify(none)}`);
            await ev(`document.getElementById('${mobile ? 'team-page-more' : 'team-page-stop'}').click(); true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the menu closes
            await ev(`T.state.liveSessions = ${JSON.stringify([mk('s1', 'Boss', false), mk('s2', 'Worker', false)])}; T.render.renderLiveSessions(T.state.liveSessions); window.openTeamPage(${JSON.stringify(BOARD)}).then(() => true)`);
            await waitFor(`!!document.getElementById('team-page-view') && document.getElementById('team-page-view').getClientRects().length > 0 && document.getElementById('team-page-title').textContent.includes('stop-menu')`, `${w}: the team page`, 15000);
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: the header fills
            const host = mobile ? '#team-page-more-menu' : '#team-page-stop-menu';
            if (mobile) check(await ev(`document.getElementById('team-page-stop').getClientRects().length === 0`), 'a phone has no Stop button, its header has one button: More');
            else check(await ev(`document.getElementById('team-page-stop').getClientRects().length > 0`), 'the header has a Stop button');
            // open the menu
            await ev(`document.getElementById('${mobile ? 'team-page-more' : 'team-page-stop'}').click(); true`);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: the menu opens
            let it = await items(host);
            check(JSON.stringify(it.map(i => i.text)) === JSON.stringify(['Sleep Team', 'Reset Team', 'Kill All']), `the items are the sidebar row's own words: ${JSON.stringify(it)}`);
            check(/^Stops every agent for now; Wake Team starts them again$/.test(it[0].hint) && /^Each agent starts again from its first instructions, in a new chat$/.test(it[1].hint) && /^Ends every agent now; their chats stay in History$/.test(it[2].hint), `each item says in one line what it does (#10357): ${JSON.stringify(it.map(i => i.hint))}`);
            check(it.every(i => i.shown) && (!mobile || it.every(i => i.h >= 44)), `shown (44 px on a phone): ${JSON.stringify(it)}`);
            check(it[0] && !it[0].danger && it[1].danger && it[2].danger, 'Reset Team and Kill All are the danger items, Sleep Team is not');
            check(await ev(`document.querySelectorAll('${host} hr.overflow-menu-divider').length >= 1`), 'the danger items are set apart by a rule');
            await shot(`team-stop-menu-${w}`);
            // each asks first
            await ev(`document.querySelector('${host} [data-stop="reset"]').click(); true`); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the dialog opens
            let d = await dialogText();
            check(/Reset team/.test(d) && /Reset all agents in/.test(d), `Reset Team asks first: ${d.slice(0, 120)}`);
            check(/starts again from its first instructions, in a new chat\. The old chats stay in History and your files are not touched\./.test(d) && !/context|original prompts/i.test(d), `Reset Team says what happens to chats and files, in plain words (#10371): ${d.slice(0, 300)}`);
            await closeDialog(); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the dialog closes
            await ev(`document.getElementById('${mobile ? 'team-page-more' : 'team-page-stop'}').click(); true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the menu opens
            await ev(`document.querySelector('${host} [data-stop="kill"]').click(); true`); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the dialog opens
            d = await dialogText();
            check(/Kill team/i.test(d) && /Kill (all \d+ agents|the 1 agent) in "/.test(d) && /stop now\. (Their chats|Its chat) stays? in History\./.test(d) && !/terminate|on board/i.test(d), `Kill All asks first, in plain words, and says what stays (#10371): ${d.slice(0, 300)}`);
            await closeDialog(); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the dialog closes
            // a sleeping team says Wake Team
            await ev(`T.state.liveSessions = ${JSON.stringify([mk('s1', 'Boss', true), mk('s2', 'Worker', true)])}; T.render.renderLiveSessions(T.state.liveSessions); document.getElementById('${mobile ? 'team-page-more' : 'team-page-stop'}').click(); true`); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the menu follows the team
            it = await items(host);
            check(it[0] && it[0].text === 'Wake Team' && /^Starts the sleeping agents again$/.test(it[0].hint), `a sleeping team offers Wake Team, and says what it does: ${JSON.stringify(it)}`);
            await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
            // Pause Board says what it does (the board's actions are in More)
            await ev(`document.getElementById('team-page-more').click(); true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the menu opens
            const pause = await ev(`(() => { const b = document.getElementById('mb-pause-btn'), n = document.getElementById('mb-pause-note'); return { btn: b && b.textContent.trim(), note: n && n.textContent.trim(), shown: !!n && n.getClientRects().length > 0, described: b && b.getAttribute('aria-describedby') }; })()`);
            check(pause.btn === 'Pause Board' && /stop receiving new messages/.test(pause.note || '') && pause.shown && pause.described === 'mb-pause-note', `Pause Board says what it does: ${JSON.stringify(pause)}`);
            if (!mobile) check(await ev(`[...document.querySelectorAll('#team-page-more-menu hr')].every(r => r.getClientRects().length === 0)`), 'a wide More menu has no stray rule (the Stop items are phone-only in it)');
            await shot(`team-more-pause-${w}`);
        }
    } finally { await removeBoards(ev, [BOARD]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'the team page Stop menu:\n  ' + problems.join('\n  '));
    console.log('PASS the team page Stop menu and Pause Board words');
})().catch(e => { console.error(e); process.exit(1); });
