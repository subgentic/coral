// #22132 (Operator 11-28: "It can show on hover as an icon"): a Needs you file row's Save for later. At 1280 it is one square outlined icon button (the font's bookmark_border, 30 by 30, grey, tooltip
// "Save for later", named for its file) in the row's hover actions, shown on hover and on keyboard focus in place of the agent's icon and the time; a click sends the existing save decision (POST .../review
// {decision:'save'}, #11641), the row leaves for Saved, and the keyboard lands on the next row. On a phone (390, touch) the row draws no icon: "Save for later" is words in the row's ⋯ menu and sends the same
// write. Two invented files on a stubbed team; Group by None so both rows are on screen. Shots: light and dark at both widths.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');
const { swapTheme } = require('./helpers/theme');
const team = 'savelater-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect(); const { Input } = client;
    const shot = require('./helpers/scene_shots')(Page);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-group-mode', 'none'); localStorage.setItem('coral-inbox-group-review-goal', 'false');` });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Emulation.setEmulatedMedia({ features: [{ name: 'pointer', value: mobile ? 'coarse' : 'fine' }, { name: 'hover', value: mobile ? 'none' : 'hover' }] });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            if (w === 1280) assert.equal(await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Writer',job_title:'Writer',session_name:'writer-${team}'})}).then(r=>r.status)`), 200);
            await ev(`localStorage.removeItem('coral-inbox-needs-filters'); window.__saves = [];
                const file = (n, name, ago) => ({ id: n.toString(16).padStart(64, '0'), name, media_type: 'text/plain', size: 30, created_at: new Date(Date.now() - ago).toISOString(), task_id: 0, source: 'upload', available: true, session_id: 'w-s', produced_by: 'Writer', tags: ['for review', 'internal'], uri: 'coral://artifacts/' + n.toString(16).padStart(64, '0') });
                const items = [file(1, 'Launch plan.md', 300000), file(2, 'Pricing notes.md', 900000)], saved = new Set(), list = () => items.filter(i => !saved.has(i.id));
                const R = window.fetch, json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
                window.__posts = []; window.fetch = (url, opts = {}) => { if (opts.method === 'POST') window.__posts.push(String(url)); const pageURL = new URL(String(url), location.href), page = pageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(pageURL, location.href, {'${team}': list()}) : null; if (page) return json(page); const u = window.__reviewFixtureURL(String(url), location.origin), m = /^\\/api\\/board\\/${team}\\/artifacts\\/([0-9a-f]{64})\\/review$/.exec(u.pathname);
                    if (m && opts.method === 'POST') { const body = JSON.parse(opts.body || '{}'); window.__saves.push({ id: m[1], decision: body.decision }); if (body.decision === 'save') saved.add(m[1]); return json({ ok: true }); }
                    if (u.pathname === '/api/board/${team}/artifacts' && (opts.method || 'GET') === 'GET') return json({ project: '${team}', artifacts: list(), has_more: false });
                    return R(url, opts); };
                window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true)`);
            const rows = `[...document.querySelectorAll('#group-table-view .nl-row.nl-file')].filter(r => r.getClientRects().length)`;
            await waitFor(`${rows}.length === 2`, `${at}the two file rows`, 15000);
            const look = `(() => { const r = ${rows}[0], b = r.querySelector('.nl-save-later'), vis = e => !!(e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'), rr = r.getBoundingClientRect(), br = b && b.getBoundingClientRect(), i = b && b.querySelector('.nl-icon'), ir = i && i.getBoundingClientRect();
                const probe = document.createElement('span'); probe.style.color = 'var(--text-secondary)'; document.body.append(probe); const grey = getComputedStyle(probe).color; probe.remove();
                return { name: r.querySelector('.nl-file-open')?.textContent || '', shown: vis(b), w: br ? Math.round(br.width) : 0, h: br ? Math.round(br.height) : 0, inRow: !!br && br.left >= rr.left && br.right <= rr.right + 0.5 && br.top >= rr.top && br.bottom <= rr.bottom + 0.5,
                    label: b?.getAttribute('aria-label') || '', title: b?.title || '', glyph: i?.textContent || '', glyphW: ir ? Math.round(ir.width) : 0, border: b ? getComputedStyle(b).borderTopWidth + ' ' + getComputedStyle(b).borderTopStyle : '', color: b ? getComputedStyle(b).color : '', grey,
                    agent: vis(r.querySelector('.goal-decision-agent-icon')), time: vis(r.querySelector('.nl-when')), more: vis(r.querySelector('.nl-more-toggle')) }; })()`;
            if (!mobile) {
                let s = await ev(look);
                assert.equal(s.shown, false, `${at}no Save button until the row is hovered or focused`); assert.ok(s.agent && s.time, `${at}at rest the row shows its agent and its time: ${JSON.stringify(s)}`);
                const box = await ev(`(() => { const r = ${rows}[0].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
                await Input.dispatchMouseEvent({ type: 'mouseMoved', x: box.x, y: box.y });
                await waitFor(`!!${rows}[0].querySelector('.nl-save-later')?.getClientRects().length`, `${at}hover shows Save for later`, 5000);
                s = await ev(look);
                assert.ok(s.inRow && s.w === 30 && s.h === 30, `${at}one square 30 by 30 button inside the row: ${JSON.stringify(s)}`);
                assert.equal(s.glyph, 'bookmark_border', `${at}the outline bookmark`); assert.ok(s.glyphW > 0 && s.glyphW <= 24, `${at}the font draws it as an icon, not its name as text (${s.glyphW} px wide)`);
                assert.equal(s.title, 'Save for later', `${at}its tooltip`); assert.ok(s.label.startsWith('Save for later: Launch plan.md'), `${at}named for its file: "${s.label}"`);
                assert.equal(s.border, '1px solid', `${at}outlined as the other hover buttons`); assert.equal(s.color, s.grey, `${at}grey (--text-secondary), not purple or blue`);
                assert.ok(!s.agent && !s.time, `${at}it takes the agent's and the time's place: ${JSON.stringify(s)}`);
                await swapTheme(ev, 'light'); await waitFor(`document.getAnimations().every(a => a.playState !== 'running')`, 'the theme change has finished drawing', 5000); await shot('needs-save-later-1280-light');
                await swapTheme(ev, 'dark'); await waitFor(`document.getAnimations().every(a => a.playState !== 'running')`, 'the theme change has finished drawing', 5000); await shot('needs-save-later-1280-dark'); await swapTheme(ev, 'light');
                // keyboard: focus on the row shows it too, and Tab reaches it
                await Input.dispatchMouseEvent({ type: 'mouseMoved', x: 5, y: 5 });
                await ev(`${rows}[0].focus(); true`);
                await waitFor(`!!${rows}[0].querySelector('.nl-save-later')?.getClientRects().length`, `${at}keyboard focus shows Save for later`, 5000);
                await ev(`${rows}[0].querySelector('.nl-save-later').focus(); true`);
                assert.equal(await ev(`document.activeElement?.classList.contains('nl-save-later')`), true, `${at}the button takes the keyboard`);
                await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
            } else {
                const s = await ev(look);
                assert.equal(s.shown, false, `${at}a phone row draws no Save icon: ${JSON.stringify(s)}`); assert.ok(s.more && s.agent && s.time, `${at}the row keeps its agent, its time and its ⋯: ${JSON.stringify(s)}`);
                const line = await ev(`(() => { const r = ${rows}[0], m = r.querySelector('.nl-more-toggle').getBoundingClientRect(), a = r.querySelector('.goal-decision-agent-icon').getBoundingClientRect(); return { dy: Math.round(Math.abs((m.top + m.bottom) - (a.top + a.bottom)) / 2), left: m.left >= a.right - 0.5 }; })()`);
                assert.ok(line.dy <= 2 && line.left, `${at}the ⋯ shares the agent's line, at its right, so the row grows no taller: ${JSON.stringify(line)}`);
                await ev(`${rows}[0].querySelector('.nl-more-toggle').scrollIntoView({ block: 'center', behavior: 'instant' }); ${rows}[0].querySelector('.nl-more-toggle').click(); true`);
                await waitFor(`[...${rows}[0].querySelectorAll('.nl-menu [role=menuitem]')].some(b => b.getClientRects().length && b.textContent.trim() === 'Save for later')`, `${at}the ⋯ menu offers Save for later`, 5000);
                assert.ok(await ev(`(() => { const b = [...${rows}[0].querySelectorAll('.nl-menu [role=menuitem]')].find(b => b.textContent.trim() === 'Save for later').getBoundingClientRect(); return b.height >= 44 && b.bottom <= innerHeight && b.top >= 0; })()`), `${at}the menu item is a 44 px target on screen`);
                await swapTheme(ev, 'light'); await waitFor(`document.getAnimations().every(a => a.playState !== 'running')`, 'the theme change has finished drawing', 5000); await shot('needs-save-later-390-light');
                await swapTheme(ev, 'dark'); await waitFor(`document.getAnimations().every(a => a.playState !== 'running')`, 'the theme change has finished drawing', 5000); await shot('needs-save-later-390-dark'); await swapTheme(ev, 'light');
                await ev(`[...${rows}[0].querySelectorAll('.nl-menu [role=menuitem]')].find(b => b.textContent.trim() === 'Save for later').click(); true`);
            }
            await waitFor(`window.__saves.length === 1`, `${at}one save request`, 8000).catch(async e => { throw new Error(e.message + ' ' + await ev(`JSON.stringify({ posts: window.__posts, active: document.activeElement?.className, toast: document.querySelector('#toast-host')?.textContent || '' })`)); });
            assert.deepEqual(await ev(`window.__saves`), [{ id: (1).toString(16).padStart(64, '0'), decision: 'save' }], `${at}the existing save decision for that file`);
            await waitFor(`${rows}.length === 1 && /Pricing notes/.test(${rows}[0].textContent)`, `${at}the saved file leaves Needs you`, 10000);
            await waitFor(`/Saved for later: Launch plan\\.md/.test(document.body.textContent)`, `${at}the notice says it was saved (with Undo)`, 5000);
            if (!mobile) await waitFor(`document.activeElement === ${rows}[0]`, `${at}the keyboard lands on the next row, not the page`, 5000).catch(async e => { throw new Error(e.message + ' ' + await ev(`(() => { const a = document.activeElement; return a ? a.tagName + '.' + a.className + ' ' + (a.dataset?.needsKey || '') + ' conn=' + a.isConnected : 'none'; })()`)); });
        }
        console.log('PASS a Needs you file row has Save for later: an outline bookmark on hover and focus at 1280, words in the ⋯ menu on a phone, both sending the save decision');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
