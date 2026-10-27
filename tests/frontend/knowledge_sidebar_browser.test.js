// The Knowledge tab's entries open in the shared right sidebar as Markdown (#7761, the operator: "Distill knowledge needs to have the same sidebar on the right with previews in markdown"): headings, lists, code and tables
// are drawn, not "#" and "---" text; the front matter is a quiet block of facts (type, title, tags as chips, the time in words with the exact one in the title); a relative link to another entry opens it in the same pane;
// the sidebar has the goal page column's handle (drag, keys, double click, the width kept); a finished distillation opens the entry it wrote; on a phone the pane is a full-screen view with a way back "<- Knowledge".
// The bundle is stubbed in the shape of GET /api/teams/detail/<team>/knowledge. Isolated dev server; drives Chrome over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-kb-${Date.now() % 100000}`;
const INDEX = `---\ntype: Team Knowledge Bundle\ntitle: ${TEAM}\ndescription: Distilled institutional knowledge\ntags: [orchestrator, uxux-engineer, backend-dev]\ntimestamp: 2026-10-22T04:22:31Z\n---\n\n# ${TEAM} - Team Knowledge\n\nAuto-distilled from agent session histories.\n\n## Agents\n\n- [Orchestrator](./orchestrator.md) - lead\n- [UX/UX Engineer](./uxux-engineer.md) - worker\n- [Nobody](./nobody.md) - gone\n- [Site](https://example.com/docs) - outside\n\n## Commands\n\n\`\`\`\ngo test ./...\n\`\`\`\n\n| Agent | Role |\n|---|---|\n| Orchestrator | lead |\n`;
const BUNDLE = { exists: true, team_name: TEAM, created_at: '2026-10-25T05:00:00Z', index: INDEX, agents: [
    { name: 'Orchestrator', content: '---\ntype: Agent Knowledge\ntitle: Orchestrator\ntags: [lead]\ntimestamp: 2026-10-22T04:22:31Z\n---\n\n# Orchestrator\n\nHands work to [Backend Dev](./backend-dev.md).\n' },
    { name: 'UX/UX Engineer', content: '# UX notes\n\nPlain notes without a block.' },
    { name: 'Backend Dev', content: 'Backend knowledge text.' }] };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const stub = () => ev(`(() => { window.__bundle = ${JSON.stringify(BUNDLE)}; const R = window.fetch.bind(window); const j = (b) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); const m = String((o && o.method) || 'GET').toUpperCase();
            if (m === 'GET' && /\\/api\\/teams\\/detail\\/[^/]+\\/knowledge$/.test(url.pathname)) return j(window.__bundle);
            return R(u, o); };
        return true; })()`);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await settle(350); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const paneText = () => ev(`window.__tp.pane() ? window.__na.text(window.__tp.pane()) : ''`);
    const openRow = async (rx) => { assert.ok(await ev(`(() => { const b = [...window.__tp.table().querySelectorAll('button')].find(x => ${rx}.test(window.__na.name(x))); if (!b) return false; b.focus(); b.click(); return true; })()`), `no row button ${rx}`); await settle(300); };
    const title = () => ev(`(() => { const p = window.__tp.pane(); const h = p && p.querySelector('.detail-title'); return h ? h.textContent : null; })()`);
    const width = () => ev(`Math.round(window.__tp.pane().getBoundingClientRect().width)`);
    const key = async (k, code, vk) => { await client.Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); };
    const drag = async (dx) => { const r = await ev(`(() => { const b = document.querySelector('.detail-grip').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + 200) }; })()`); const I = client.Input; await I.dispatchMouseEvent({ type: 'mouseMoved', x: r.x, y: r.y }); await I.dispatchMouseEvent({ type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await I.dispatchMouseEvent({ type: 'mouseMoved', x: r.x + dx, y: r.y, button: 'left' }); await I.dispatchMouseEvent({ type: 'mouseReleased', x: r.x + dx, y: r.y, button: 'left', clickCount: 1 }); };
    const open = async (w, h, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
        await ev(`localStorage.removeItem('coral-detail-width'); true`);
        await seed(ev, TEAM); await stub();
        if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
        await openTeam(ev, waitFor, TEAM).catch(() => {});
        await goTab(ev, settle, 'Knowledge'); await waitFor(`!!window.__tp.rows() && window.__tp.rows().length >= 4`, 'the knowledge table', 10000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        console.log('1280x800');
        await open(1280, 800, false);
        await S.run('an entry is drawn as Markdown: headings, a list, code and a table, with no "#" or "---" text', async () => {
            await openRow('/^Index$/'); await waitFor(`!!window.__tp.pane() && !!window.__tp.pane().querySelector('.knowledge-md')`, 'the rendered entry', 8000);
            const d = await ev(`(() => { const p = window.__tp.pane(), md = p.querySelector('.knowledge-md'); return { text: md.innerText, heads: [...md.querySelectorAll('.md-h')].map(h => h.textContent), li: md.querySelectorAll('li').length, code: !!md.querySelector('pre code'), th: [...md.querySelectorAll('th')].map(h => h.textContent), pre: !!p.querySelector('pre.knowledge-text') }; })()`);
            assert.deepEqual(d.heads, [`${TEAM} - Team Knowledge`, 'Agents', 'Commands'], 'the headings');
            assert.equal(d.li, 4, 'the four list items'); assert.ok(d.code, 'the code block'); assert.deepEqual(d.th, ['Agent', 'Role'], 'the table');
            assert.ok(!/^#|\n#|---|\]\(\.\//.test(d.text), `no raw Markdown text: ${JSON.stringify(d.text.match(/^#|\n#|---|\]\(\.\//))} in ${JSON.stringify(d.text)}`); assert.equal(d.pre, false, 'the plain text is replaced by the rendering');
        });
        await S.run('the front matter is a facts block: type, title, tags as chips and no time of its own (one time format, in the header line, with the exact one on hover), not raw text', async () => {
            const f = await ev(`(() => { const p = window.__tp.pane(), dl = p.querySelector('dl.facts'); if (!dl) return null; const rows = {}; dl.querySelectorAll('dt').forEach(t => { rows[t.textContent] = t.nextElementSibling; }); return { keys: [...dl.querySelectorAll('dt')].map(t => t.textContent), type: rows.Type.textContent, title: rows.Title.textContent, tags: [...rows.Tags.querySelectorAll('.knowledge-tag')].map(t => t.textContent), sub: p.querySelector('.detail-sub').textContent, exact: p.querySelector('.detail-sub').title, all: window.__na.text(p) }; })()`);
            assert.ok(f, 'a facts block'); assert.deepEqual(f.keys, ['Type', 'Title', 'About', 'Tags'], 'no Written row: the time is in the header line only');
            assert.equal(f.type, 'Team Knowledge Bundle'); assert.equal(f.title, TEAM); assert.deepEqual(f.tags, ['orchestrator', 'uxux-engineer', 'backend-dev']);
            assert.ok(f.sub && f.exact && !f.sub.startsWith(f.exact) && /^(just now|\d+ min ago|today|yesterday|[A-Z][a-z]{2} \d)/.test(f.sub), `the header line has the time in words (${JSON.stringify(f.sub)}) and the exact time on hover (${JSON.stringify(f.exact)})`);
            assert.ok(!/Written|2026-10-22|Oct 21/.test(f.all.replace(f.sub, '')), 'the time is shown once, in one format');
            assert.ok(!/tags: \[|type: Team|timestamp:/.test(f.all), 'no raw front matter text in the pane');
            await shot('knowledge-sidebar-desktop');
        });
        await S.run('a link to another entry opens it in the same pane; an unknown one and an outside one are not entry links', async () => {
            const l = await ev(`(() => { const md = window.__tp.pane().querySelector('.knowledge-md'); const as = [...md.querySelectorAll('a')].map(a => ({ t: a.textContent, h: a.getAttribute('href'), blank: a.target })); return { as, host: md.querySelector('a[href^="/team-knowledge/"] + .md-host') !== null, text: md.innerText }; })()`);
            assert.deepEqual(l.as.map(a => a.t), ['Orchestrator', 'UX/UX Engineer', 'Site'], 'Nobody has no link: it is text'); assert.ok(/Nobody/.test(l.text) && !/nobody\.md/.test(l.text), 'an unknown file is its words alone');
            assert.equal(l.as[2].h, 'https://example.com/docs'); assert.equal(l.as[2].blank, '_blank'); assert.equal(l.host, false, 'an entry link has no host after it');
            await ev(`[...window.__tp.pane().querySelectorAll('.knowledge-md a')].find(a => a.textContent === 'Orchestrator').click(); true`); await settle(400);
            assert.equal(await title(), 'Orchestrator', 'the pane now shows the Orchestrator entry');
            assert.equal(await ev(`window.__tp.pane().querySelectorAll('.knowledge-md').length`), 1, 'one pane, one document');
            assert.equal(await ev(`window.__tp.table().querySelector('tr[aria-current="true"] .dt-primary').textContent`), 'Orchestrator', 'the table marks the open entry');
            await ev(`[...window.__tp.pane().querySelectorAll('.knowledge-md a')].find(a => a.textContent === 'Backend Dev').click(); true`); await settle(400);
            assert.equal(await title(), 'Backend Dev', 'a link inside an agent entry opens the other entry');
            assert.match(await paneText(), /Backend knowledge text\./);
            await openRow('/UX\\/UX Engineer/'); await settle(200);
            assert.equal(await ev(`window.__tp.pane().querySelector('dl.facts')`), null, 'an entry without a block has no facts'); assert.match(await paneText(), /UX notes/);
        });
        await S.run('the sidebar has the goal column\'s handle: a separator, dragged wider, kept, with the dock\'s limits, keys and double click', async () => {
            await openRow('/^Index$/'); await waitFor(`!!document.querySelector('.detail-grip')`, 'the handle');
            const sep = await ev(`(() => { const g = document.querySelector('.detail-grip'); return { role: g.getAttribute('role'), name: g.getAttribute('aria-label'), min: g.getAttribute('aria-valuemin'), tab: g.tabIndex, now: g.getAttribute('aria-valuenow') }; })()`);
            assert.deepEqual([sep.role, sep.name, sep.min, sep.tab], ['separator', 'Resize the details', '280', 0]); assert.equal(await width(), 460, 'the default width is the pane\'s 460 px');
            await drag(-100); await waitFor(`Math.abs(Math.round(window.__tp.pane().getBoundingClientRect().width) - 560) <= 1`, 'the pane dragged 100 px wider', 5000); const kept = await width();
            assert.equal(await ev(`localStorage.getItem('coral-detail-width')`), String(kept), 'the width is remembered');
            await openRow('/Backend Dev/'); assert.equal(await width(), kept, 'another entry opens at the kept width');
            await ev(`document.querySelector('.detail-grip').focus(); true`); await key('Home', 'Home', 36); assert.equal(await width(), 280, 'Home goes to the minimum');
            await key('ArrowLeft', 'ArrowLeft', 37); assert.equal(await width(), 304, 'Left widens by 24');
            await drag(2000); assert.equal(await width(), 280, 'it stops at 280'); await drag(-3000);
            const max = await ev(`Math.round(document.getElementById('team-page-row').getBoundingClientRect().width) - 240`); assert.ok(Math.abs((await width()) - max) <= 1, `and at the page's room less 240 (${await width()} / ${max})`);
            await ev(`document.querySelector('.detail-grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
            assert.equal(await width(), 460, 'a double click resets it'); assert.equal(await ev(`localStorage.getItem('coral-detail-width')`), null, 'and forgets the width');
            await ev(`localStorage.setItem('coral-detail-width', '520'); true`);
            await ev(`window.__tp.pane().querySelector('.detail-close').click(); true`); await settle(200); await openRow('/Orchestrator/'); assert.equal(await width(), 520, 'a saved width is applied when the pane is opened again');
            await ev(`localStorage.removeItem('coral-detail-width'); true`);
        });
        await S.run('a finished distillation opens the entry it wrote in the pane, leaving the focus where it was; nothing opens when nothing changed', async () => {
            await ev(`window.__tp.pane() && window.__tp.pane().querySelector('.detail-close').click(); true`); await settle(200);
            await ev(`document.querySelector('.team-distill').focus(); true`);
            const done = () => ev(`document.dispatchEvent(new CustomEvent('coral:distill-status', { detail: { team: ${JSON.stringify(TEAM)}, job: { status: 'complete' }, prev: { status: 'running' } } })); true`);
            await done(); await settle(600);
            assert.equal(await ev(`window.__tp.pane() === null`), true, 'nothing changed: nothing opens');
            await ev(`window.__bundle = Object.assign({}, window.__bundle, { agents: window.__bundle.agents.map(a => a.name === 'Backend Dev' ? Object.assign({}, a, { content: 'Backend notes, rewritten.' }) : a) }); true`);
            await done(); await waitFor(`!!window.__tp.pane()`, 'the written entry in the pane', 8000);
            assert.equal(await title(), 'Backend Dev', 'the changed entry opens'); assert.match(await paneText(), /Backend notes, rewritten\./);
            assert.equal(await ev(`document.activeElement.classList.contains('team-distill')`), true, 'the focus stayed on the button');
            await ev(`window.__tp.pane().querySelector('.detail-close').click(); true`); await settle(200);
            await ev(`window.__bundle = Object.assign({}, window.__bundle, { index: window.__bundle.index + '\\nMore.' }); true`);
            await done(); await waitFor(`!!window.__tp.pane()`, 'the index in the pane', 8000);
            assert.equal(await title(), 'Index', 'the team\'s index goes first when it changed');
        });
        console.log('390x844');
        await open(390, 844, true);
        await S.run('on a phone the pane is a full-screen view with the way back "<- Knowledge" on the title\'s line, and no handle', async () => {
            await openRow('/^Index$/'); await waitFor(`!!window.__tp.pane() && !!window.__tp.pane().querySelector('.knowledge-md')`, 'the entry', 8000);
            const p = await ev(`(() => { const a = window.__tp.pane(), r = a.getBoundingClientRect(), b = a.querySelector('.detail-back'), t = a.querySelector('.detail-title'), bb = b.getBoundingClientRect(), tb = t.getBoundingClientRect(), cs = getComputedStyle(b); return { full: r.width === innerWidth && r.height === innerHeight, back: b.textContent.replace(/\\s+/g, ' ').trim(), font: cs.fontSize + ' ' + cs.fontWeight, beside: tb.top < bb.bottom - 1 && tb.left >= bb.right - 2, h: Math.round(bb.height), w: Math.round(bb.width), grip: getComputedStyle(a.querySelector('.detail-grip')).display, scrollX: document.documentElement.scrollWidth > innerWidth }; })()`);
            assert.ok(p.full, 'the pane covers the screen'); assert.equal(p.back, '\u2190 Knowledge'); assert.equal(p.font, '13px 500'); assert.ok(p.beside, 'beside the title'); assert.ok(p.h >= 44 && p.w >= 44, `a 44 px target (${p.w}x${p.h})`);
            await shot('knowledge-sidebar-phone');
            assert.equal(p.grip, 'none', 'no handle on a phone'); assert.equal(p.scrollX, false, 'the page does not scroll sideways');
            await ev(`window.__tp.pane().querySelector('.detail-back').click(); true`); await settle(300);
            assert.equal(await ev(`window.__tp.pane() === null`), true, 'the way back closes the view'); assert.ok(await ev(`!!window.__tp.table()`), 'the table is there again');
        });
        await S.run('on a phone an entry opened by a tap leaves its title with no focus ring (:focus-visible does not match), and one opened from the keyboard keeps it', async () => {
            await ev(`window.__tp.pane() && window.__tp.pane().querySelector('.detail-close').click(); document.activeElement.blur(); true`); await settle(200); // the close puts the focus back on the row by script, which would carry its ring to the next focus: a person's tap starts from nothing focused
            const state = () => ev(`(() => { const h = window.__tp.pane().querySelector('.detail-title'), a = document.activeElement; return { onTitle: a === h, focusVisible: !!a && a.matches(':focus-visible'), outline: getComputedStyle(h).outlineStyle }; })()`);
            const pt = await ev(`(() => { const b = [...window.__tp.table().querySelectorAll('button')].find(x => /^Index$/.test(window.__na.name(x))); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
            await client.Input.dispatchTouchEvent({ type: 'touchStart', touchPoints: [pt] }); await client.Input.dispatchTouchEvent({ type: 'touchEnd', touchPoints: [] });
            await waitFor(`!!window.__tp.pane() && document.activeElement === window.__tp.pane().querySelector('.detail-title')`, 'the title to have the focus after the tap', 8000);
            const tapped = await state(); assert.deepEqual(tapped, { onTitle: true, focusVisible: false, outline: 'none' }, 'after a tap: ' + JSON.stringify(tapped));
            await ev(`window.__tp.pane().querySelector('.detail-close').click(); document.activeElement.blur(); true`); await settle(200);
            await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
            await ev(`[...window.__tp.table().querySelectorAll('button')].find(x => /^Index$/.test(window.__na.name(x))).click(); true`);
            await waitFor(`!!window.__tp.pane() && document.activeElement === window.__tp.pane().querySelector('.detail-title')`, 'the title to have the focus after the keyboard', 8000);
            const keyed = await state(); assert.deepEqual([keyed.onTitle, keyed.focusVisible, keyed.outline !== 'none'], [true, true, true], 'after the keyboard: ' + JSON.stringify(keyed));
        });
        await removeBoards(ev, [TEAM]); S.finish(); // finish() exits the process, so the board goes first
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
