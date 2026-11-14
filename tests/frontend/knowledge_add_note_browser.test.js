// The Knowledge tab lets a person add a fact by hand (#16685, walk 30 F1 and walk 45): before this the tab had Search and Distill knowledge only, so a new user posted the rule on the Board, where the team's knowledge never saw it.
// "Add a note" opens the sidebar with a title and the text; Save writes the entry note-<title> through the route an edit uses (every agent of the team reads it when it starts); the table lists it as "Added by hand".
// The route is stubbed in the shape of GET/PUT /api/teams/detail/<team>/knowledge[/<name>]. Isolated dev server; drives Chrome over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-kn-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const stub = () => ev(`(() => { window.__bundle = { exists: false }; window.__puts = []; const R = window.fetch.bind(window); const j = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); const m = String((o && o.method) || 'GET').toUpperCase();
            if (m === 'GET' && /\\/api\\/teams\\/detail\\/[^/]+\\/knowledge$/.test(url.pathname)) return j(window.__bundle);
            const put = /\\/api\\/teams\\/detail\\/[^/]+\\/knowledge\\/([^/]+)$/.exec(url.pathname);
            if (m === 'PUT' && put) { const name = decodeURIComponent(put[1]), content = JSON.parse(o.body).content; window.__puts.push({ name, content });
                const b = window.__bundle.exists ? window.__bundle : (window.__bundle = { exists: true, team_name: 'x', created_at: new Date().toISOString(), index: '# Team knowledge', agents: [] });
                b.agents = b.agents.filter(a => a.name !== name).concat([{ name, content }]); return j({ ok: true, redacted: false }); }
            return R(u, o); };
        return true; })()`);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await settle(350); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const buttons = () => ev(`[...document.querySelectorAll('[role=tabpanel]:not([hidden]) .team-toolbar-row button')].filter(b => b.getClientRects().length).map(b => b.textContent.trim())`);
    const open = async (w, h, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM); await stub();
        if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
        await openTeam(ev, waitFor, TEAM).catch(() => {});
        await goTab(ev, settle, 'Knowledge'); await waitFor(`!!document.querySelector('[role=tabpanel]:not([hidden]) .empty-state-line')`, 'the empty Knowledge tab', 10000);
    };
    const fill = (id, v) => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.focus(); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const status = () => ev(`(document.querySelector('#detail-pane .detail-status') || {}).textContent || ''`);
    const clickSave = () => ev(`[...document.querySelectorAll('#detail-pane .detail-foot button')].find(b => /Save note/.test(b.textContent)).click(); true`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
            console.log(`${w}x${h}`);
            await open(w, h, mobile);
            await S.run(`${w}: the empty Knowledge tab has Add a note beside Distill knowledge, and its hint says so`, async () => {
                assert.deepEqual(await buttons(), ['Add a note', 'Distill knowledge'], 'the toolbar: ' + JSON.stringify(await buttons()));
                const hint = await ev(`(document.querySelector('[role=tabpanel]:not([hidden]) .empty-state-hint') || {}).textContent || ''`);
                assert.match(hint, /Add a note/, 'the hint names the way to add a fact: ' + hint);
                assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, 'the page does not scroll sideways');
                await shot(`knowledge-add-note-empty-${w}`);
            });
            await S.run(`${w}: Add a note opens the pane; Save with no title or text says what is missing and saves nothing`, async () => {
                await ev(`document.querySelector('.team-add-note').click(); true`);
                await waitFor(`!!document.getElementById('knowledge-note-title')`, 'the note form', 8000);
                assert.equal(await ev(`document.querySelector('#detail-pane .detail-title').textContent`), 'Add a note');
                assert.match(await ev(`document.querySelector('#detail-pane .detail-sub').textContent`), /Every agent of this team reads it/);
                assert.equal(await ev(`document.activeElement.id`), 'knowledge-note-title', 'the title has the focus');
                await clickSave(); await settle(150); assert.equal(await status(), 'Give the note a title.');
                await fill('knowledge-note-title', 'Deploy window'); await clickSave(); await settle(150); assert.equal(await status(), 'Write what the team should know.');
                assert.equal(await ev(`window.__puts.length`), 0, 'nothing was sent');
                await shot(`knowledge-add-note-form-${w}`);
            });
            await S.run(`${w}: Save writes note-<title> with its title and text, and the table lists it as Added by hand`, async () => {
                await fill('knowledge-note-text', 'Never deploy on Fridays. Ask the Orchestrator first.'); await clickSave();
                await waitFor(`window.__puts.length === 1`, 'the PUT', 8000);
                const put = await ev(`window.__puts[0]`);
                assert.equal(put.name, 'note-deploy-window'); assert.match(put.content, /^---\ntype: note\ntitle: "Deploy window"\n---\n\nNever deploy on Fridays\. Ask the Orchestrator first\.\n$/);
                await waitFor(`window.__tp.rows() && window.__tp.rows().some(r => /Deploy window/.test(r) && /Added by hand/.test(r))`, 'the row', 8000);
                assert.equal(await ev(`document.querySelector('#detail-pane .detail-title').textContent`), 'Deploy window', 'the saved note opens in the pane');
                assert.match(await ev(`document.querySelector('#detail-pane').innerText`), /Never deploy on Fridays/);
                assert.ok(!/note-deploy-window/.test(await ev(`document.querySelector('[role=tabpanel]:not([hidden])').innerText`)), 'the file name is not shown');
                await shot(`knowledge-add-note-saved-${w}`);
            });
            await S.run(`${w}: a second note with the same title is refused; a title with no letters or numbers too`, async () => {
                await ev(`(document.querySelector('#detail-pane .detail-close') || {click(){}}).click(); true`); await settle(200);
                await ev(`document.querySelector('.team-add-note').click(); true`); await waitFor(`!!document.getElementById('knowledge-note-title')`, 'the form', 8000);
                await fill('knowledge-note-title', 'deploy  WINDOW'); await fill('knowledge-note-text', 'again'); await clickSave(); await settle(150);
                assert.match(await status(), /A note with that title exists/); assert.equal(await ev(`window.__puts.length`), 1);
                await fill('knowledge-note-title', '???'); await clickSave(); await settle(150);
                assert.equal(await status(), 'Use letters or numbers in the title.'); assert.equal(await ev(`window.__puts.length`), 1);
            });
        }
        await removeBoards(ev, [TEAM]); S.finish();
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
