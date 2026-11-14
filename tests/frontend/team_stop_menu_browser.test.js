// Stopping a team from its page (Beta Tester's pass and Mobile tester's, #10008): the team's page header has a Stop menu with the sidebar row's own words and actions (Sleep team or Wake team, then Reset team and Stop team apart, each asking first),
// a phone's More has the same items, and Pause board says in words what it does. At 1280 and 390 px; the isolated dev server, a board made through the API, the team's live rows put in the list.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const BOARD = 'stop-menu-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await ev(framesJs(3)); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const mk = (id, name, sleeping) => ({ session_id: id, name, display_name: name, agent_type: 'claude', summary: 'x', model: 'claude-opus-5-5', branch: 'main', repo_name: 'coral', working_directory: '/work/' + name, status: 'idle', server: 'local', board_project: BOARD, sleeping });
    const items = host => ev(`[...document.querySelectorAll('${host} [data-stop]:not([data-stop="sep"])')].map(b => ({ key: b.dataset.stop, text: ((b.querySelector('.menu-item-text') || b).firstChild || b).textContent.trim(), hint: ((b.querySelector('.menu-item-hint') || {}).textContent || '').trim(), danger: b.classList.contains('menu-item-danger'), shown: b.getClientRects().length > 0, h: Math.round(b.getBoundingClientRect().height) }))`);
    const dialogText = () => ev(`(() => { const d = [...document.querySelectorAll('dialog[open], .dlg-confirm')].find(e => e.getClientRects().length); return d ? d.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`);
    const closeDialog = () => ev(`(() => { for (const d of document.querySelectorAll('dialog[open], .dlg-confirm, #confirm-modal')) { if(!d.getClientRects().length)continue; const c = [...d.querySelectorAll('button')].find(b => /^cancel$/i.test(b.textContent.trim())); if (c) c.click(); } return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${w}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`fetch('/api/board/${BOARD}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator' }) }).then(r => r.status)`);
            // a team with no live agent: nothing to put to sleep, reset or kill, and the menu says so
            await ev(`T.state.liveSessions = []; T.render.renderLiveSessions([]); window.openTeamPage(${JSON.stringify(BOARD)}).then(() => true)`);
            await waitFor(`!!document.getElementById('team-page-view') && document.getElementById('team-page-view').getClientRects().length > 0 && document.getElementById('team-page-title').textContent.includes('stop-menu')`, `${w}: the team page, no agents`, 15000);
            await ev(`document.getElementById('team-page-more').click(); true`); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the menu opens
            const none = await ev(`[...document.querySelectorAll('#team-page-more-menu [data-stop]:not([data-stop="sep"])')].map(b => ({ disabled: b.disabled, title: b.title, note: (b.querySelector('.overflow-menu-note') || {}).textContent || '' }))`); // the reason is written beside a disabled item; a title that repeated it is gone (#11566)
            check(none.length === 3 && none.every(x => x.disabled && /No agent of this team is running/.test(x.note) && x.title === ''), `with no live agent the three are off, with the reason: ${JSON.stringify(none)}`);
            await ev(`document.getElementById('team-page-more').click(); true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the menu closes
            await ev(`T.state.liveSessions = ${JSON.stringify([mk('s1', 'Boss', false), mk('s2', 'Worker', false)])}; T.render.renderLiveSessions(T.state.liveSessions); window.openTeamPage(${JSON.stringify(BOARD)}).then(() => true)`);
            await waitFor(`!!document.getElementById('team-page-view') && document.getElementById('team-page-view').getClientRects().length > 0 && document.getElementById('team-page-title').textContent.includes('stop-menu')`, `${w}: the team page`, 15000);
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: the header fills
            const host = '#team-page-more-menu';
            check(await ev(`!document.getElementById('team-page-stop') && !document.getElementById('team-page-stop-menu')`), 'the header has no Stop button of its own: the stop items are in More, last, under a line (#15856)');
            // open the menu
            await ev(`document.getElementById('team-page-more').click(); true`);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: the menu opens
            let it = await items(host);
            check(JSON.stringify(it.map(i => i.text)) === JSON.stringify(['Sleep team', 'Reset team (clear context)', 'Stop team']), `the items are the sidebar row's own words: ${JSON.stringify(it)}`);
            check(/^Stops every agent for now; Wake team starts them again$/.test(it[0].hint) && /^Clears every agent's context; each starts in a new chat$/.test(it[1].hint) && /^Ends every agent now; their chats stay in History$/.test(it[2].hint), `each item says in one line what it does (#10357): ${JSON.stringify(it.map(i => i.hint))}`);
            check(it.every(i => i.shown) && (!mobile || it.every(i => i.h >= 44)), `shown (44 px on a phone): ${JSON.stringify(it)}`);
            check(it[0] && !it[0].danger && !it[1].danger && it[2].danger, 'Stop team is the danger item; Sleep team and Reset team (clear context) are not red at rest (#15373)');
            check(await ev(`document.querySelectorAll('${host} hr.overflow-menu-divider').length >= 1`), 'the danger items are set apart by a rule');
            check(await ev(`(() => { const k = [...document.querySelectorAll('${host} > *')]; const last3 = k.slice(-4); return last3[0].tagName === 'HR' && last3.slice(1).every(e => e.dataset.stop); })()`), 'More ends with a line and then the three stop items (#15856)');
            await shot(`team-stop-menu-${w}`);
            const separation=await ev(`(()=>{const host=document.querySelector('${host}'),reset=host.querySelector('[data-stop="reset"]'),kill=host.querySelector('[data-stop="kill"]');return{gap:kill.getBoundingClientRect().top-reset.getBoundingClientRect().bottom,resetRule:parseFloat(getComputedStyle(reset).borderTopWidth),killRule:parseFloat(getComputedStyle(kill).borderTopWidth)}})()`);
            check(separation.gap>=8&&separation.killRule>=1,`destructive actions have space and a visible boundary: ${JSON.stringify(separation)}`);
            if(mobile){
                const deletion=await ev(`(()=>{const b=document.querySelector('#team-page-more-menu #mb-delete-btn');return{margin:parseFloat(getComputedStyle(b).marginTop),rule:parseFloat(getComputedStyle(b).borderTopWidth),height:b.getBoundingClientRect().height}})()`);
                check(deletion.margin>=8&&deletion.rule>=1&&deletion.height>=44,`Delete team is separated and retains its phone target: ${JSON.stringify(deletion)}`);
                await ev(`document.querySelector('${host}').scrollTop=document.querySelector('${host}').scrollHeight;true`);
                await shot(`team-destructive-${w}`);
                await ev(`document.querySelector('${host}').scrollTop=0;true`);
            }
            // each asks first
            await ev(`document.querySelector('${host} [data-stop="reset"]').click(); true`); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the dialog opens
            let d = await dialogText();
            check(/Reset team/.test(d) && /Reset all agents in/.test(d), `Reset team asks first: ${d.slice(0, 120)}`);
            check(/starts again from its first instructions, in a new chat\. The old chats stay in History and your files are not touched\./.test(d) && !/context|original prompts/i.test(d), `Reset team says what happens to chats and files, in plain words (#10371): ${d.slice(0, 300)}`);
            await closeDialog(); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the dialog closes
            await ev(`document.getElementById('team-page-more').click(); true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the menu opens
            await ev(`document.querySelector('${host} [data-stop="kill"]').click(); true`); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the dialog opens
            d = await dialogText(); await shot(`team-stop-confirm-${w}`);
            check(/Stop team/i.test(d) && /Stop (all \d+ agents|the 1 agent) in "/.test(d) && /(Their processes|Its process) ends? now\. (Their chats|Its chat) stays? in History\./.test(d) && !/terminate|on board/i.test(d), `Stop team asks first, in plain words, and says what stays (#10371): ${d.slice(0, 300)}`);
            await closeDialog(); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the dialog closes
            // a sleeping team says Wake team
            await ev(`T.state.liveSessions = ${JSON.stringify([mk('s1', 'Boss', true), mk('s2', 'Worker', true)])}; T.render.renderLiveSessions(T.state.liveSessions); document.getElementById('team-page-more').click(); true`); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the menu follows the team
            it = await items(host);
            check(it[0] && it[0].text === 'Wake team' && /^Starts the sleeping agents again$/.test(it[0].hint), `a sleeping team offers Wake team, and says what it does: ${JSON.stringify(it)}`);
            await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
            // Pause board says what it does (the board's actions are in More)
            await ev(`document.getElementById('team-page-more').click(); true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the menu opens
            const pause = await ev(`(() => { const b = document.getElementById('mb-pause-btn'), n = document.getElementById('mb-pause-note'); return { btn: b && b.textContent.trim(), note: n && n.textContent.trim(), shown: !!n && n.getClientRects().length > 0, described: b && b.getAttribute('aria-describedby') }; })()`);
            check(pause.btn === 'Pause team' && /stop receiving new messages/.test(pause.note || '') && pause.shown && pause.described === 'mb-pause-note', `Pause team says what it does: ${JSON.stringify(pause)}`);
            await shot(`team-more-pause-${w}`);
            await closeDialog();
            await ev(`(async()=>{await window.exitTeamPage({force:true});window.switchNavTab('agents');T.render.renderLiveSessions(T.state.liveSessions);if(${mobile})window.mobileBack();return true})()`);
            const trigger=mobile?'#mobile-session-list .group-kebab-btn':'#live-sessions-list .group-kebab-btn';
            await waitFor(`!!document.querySelector('${trigger}')?.getClientRects().length`,'team sidebar menu trigger');
            await ev(`document.querySelector('${trigger}').click();true`);
            const sidebar=await ev(`(()=>{const host=document.querySelector('${trigger}').nextElementSibling;host.scrollTop=host.scrollHeight;const buttons=[...host.querySelectorAll('[data-on-click="team-kill"],[data-on-click="team-delete"]')];return{n:buttons.length,heights:buttons.map(b=>b.getBoundingClientRect().height),gaps:buttons.slice(1).map((b,i)=>b.getBoundingClientRect().top-buttons[i].getBoundingClientRect().bottom)}})()`);
            await shot(`team-sidebar-destructive-${w}`);
            check(sidebar.n>=2&&sidebar.gaps.every(g=>g>=8)&&(!mobile||sidebar.heights.every(h=>h>=44)),`sidebar destructive actions are separated with phone targets: ${JSON.stringify(sidebar)}`);
        }
    } finally { await removeBoards(ev, [BOARD]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'the team page Stop menu:\n  ' + problems.join('\n  '));
    console.log('PASS the team page Stop menu and Pause board words');
})().catch(e => { console.error(e); process.exit(1); });
