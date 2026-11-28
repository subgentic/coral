// Needs you rows on a computer, compact (#15722, the Operator's annotated screenshot and the layouts picked from #15723's mockups): the select box, the kind icon and the sender on the first line with the team and
// how long it has waited at the right; a question's whole text on its own line under the sender; every action a labelled button (Comment, Save, More, Star: no bare icons) on the bottom line, at the right, the star
// among them. A phone's rows are not touched (icons stay). 1440 and 960 wide, light and dark, and a phone at 390. Drives Chrome over CDP through agent_view_harness.js.
// On the ledger (#22094) the row is article.nl-row: select box, kind icon, then the title (a file's name, or the question itself) with its sender line (.nl-meta) under it, and the time (.nl-when)
// at the right; a computer's actions are hover actions (.nl-hover-actions) at the right. Kept: four rows and no sideways scroll; the select box, icon and title on the first line, the heading at the
// icon's top (#20203); the question whole; the time last at the right and a long wait (23 h 59 min) inside the row, clear of the rest of the side; every hover control named (a word, or an aria-label
// with the row's name); a question's buttons under its icon. Retired (approved v19 mock): the file row's Approve, Request changes, Save, Star and More words in a bottom bar (decisions stay in the
// viewer, needs_actions_b; Save for later is the bookmark icon of #22132, needs_save_later_icon; no star, star placement retired by the Orchestrator 2026-11-28 09:33; More is a phone's ⋯ only,
// needs_menu_fit); the team beside the wait at the top right (the team is in the sender line, needs_ledger); the question under the sender (v19 puts the sender under the question); the message
// directly above a footer (there is no footer).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'hover-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));` });
        for (const [w, h, mobile] of [[1440, 1000, false], [960, 1000, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = (i, tags) => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags, produced_by: 'Plan Writer', review_question: 'Ship plan ' + i + '?' });
                const items = [item(1, ['for review']), item(2, ['for review', 'read']), item(3, ['for review'])];
                window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': items}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                    if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    return original(url, opts); };
                return true; })()`);
            await ev(`(() => { const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify([{ board: '${team}', kind: 'ask', id: 71, asker: 'Lead', text: 'Which port should the test server use for the integration run, and should it be the same one the dashboard is on? Say which, and why.', at: new Date(Date.now() - 300000).toISOString() }]), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} .nl-row.nl-file').length >= 3 && !!document.querySelector('${T} .nl-row.nl-question')`, at + 'the review rows and the question', 15000);
            await ev(framesJs(4));
            await ev(`(() => { const st = document.createElement('style'); st.textContent = '*, *::before, *::after { transition: none !important; }'; document.head.append(st); return true; })()`);
            const ROWS = `[...document.querySelectorAll('${T} .nl-row')].filter(r => r.getClientRects().length)`;
            const geo = () => ev(`(() => { const R = e => e && e.getClientRects().length ? e.getBoundingClientRect() : null, cy = r => r ? r.top + r.height / 2 : null;
                return { over: document.documentElement.scrollWidth > innerWidth + 1, rows: ${ROWS}.map(tr => { const rb = tr.getBoundingClientRect(), ask = tr.classList.contains('nl-question'), file = tr.classList.contains('nl-file');
                    const icon = R(tr.querySelector(':scope > .nl-icon')), check = R(tr.querySelector(':scope > .nl-check-hit .nl-check')), title = tr.querySelector('.nl-title'), tb = R(title), meta = R(tr.querySelector('.nl-body > .nl-meta')), side = tr.querySelector('.nl-side'), sb = R(side), when = R(side && side.querySelector('.nl-when'));
                    const others = side ? [...side.children].filter(e => !e.matches('.nl-when') && R(e)).map(e => R(e)) : [], acts = [...tr.querySelectorAll('.nl-body .nl-actions button')].filter(b => R(b)), actTop = acts.length ? Math.round(Math.min(...acts.map(b => R(b).top)) - rb.top) : null;
                    const cut = e => !!e && (e.scrollWidth > e.clientWidth + 1 || getComputedStyle(e).textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth);
                    const qText = ask ? (title.textContent + ' ' + ((tr.querySelector('.nl-question-box') || {}).textContent || '')) : '';
                    const words = [...tr.querySelectorAll('button')].filter(b => R(b) && !b.closest('.nl-menu')).map(b => ({ t: b.textContent.replace(/bookmark_border|bookmark|more_horiz/g, '').trim(), l: b.getAttribute('aria-label') || '' }));
                    return { h: Math.round(rb.height), ask, file, name: (title && title.textContent || '').trim().slice(0, 40), headingTop: tb && Math.round(tb.top), iconTop: icon && Math.round(icon.top), iconBottom: icon ? Math.round(icon.bottom - rb.top) : null, actTop,
                        line: [cy(icon), cy(check)].filter(v => v != null).map(v => Math.round(v - rb.top)), titleLine: tb ? Math.round(Math.min(tb.top + 10, cy(tb)) - rb.top) : null, metaBelow: !meta || !tb || meta.top >= tb.top + 4,
                        waitRight: when ? Math.round(rb.right - when.right) : null, waitLast: !!when && others.every(o => o.right <= when.left + 1 || o.bottom <= when.top + 1 || o.top >= when.bottom - 1), waitIn: !!when && !!sb && when.left >= sb.left - 1 && when.right <= sb.right + 1 && when.right <= rb.right && !cut(side.querySelector('.nl-when')),
                        qWhole: ask ? !cut(title) && /Say which, and why\./.test(qText) : null, words }; }) }; })()`);
            await ev(`(() => { for (const w of document.querySelectorAll('${T} .nl-row .nl-when')) w.textContent = '23 h 59 min'; return true; })()`); // a long wait stays inside its own track (#19122)
            for (const theme of ['light', 'dark']) {
                await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); true`); await ev(framesJs(3));
                const g = await geo(), a = at + theme + ': ';
                check(g.rows.length === 4 && !g.over, a + 'four rows, and the page does not scroll sideways: ' + JSON.stringify({ n: g.rows.length, over: g.over }));
                for (const [i, r] of g.rows.entries()) {
                    const what = (r.ask ? 'question row ' : 'file row ') + JSON.stringify(r);
                    check(r.line.length === (mobile ? r.line.length : 2) && r.line.length >= 1 && Math.max(...r.line) - Math.min(...r.line) <= 4 && r.titleLine != null && Math.abs(r.titleLine - r.line[0]) <= 12, a + 'the select box (a phone shows it in Select only), the icon and the title are on the first line: ' + what);
                    check(r.waitRight != null && r.waitRight <= 24 && r.waitLast && r.waitIn, a + 'the wait is last at the right, and a long wait (23 h 59 min) stays inside the row, clear of the rest of the side: ' + what);
                    if (r.ask) check(r.qWhole === true && r.metaBelow, a + 'the question is whole, its sender under it: ' + what);
                    if (!mobile) {
                        check(r.headingTop != null && r.iconTop != null && Math.abs(r.headingTop - r.iconTop) < 4, a + 'the heading starts at the icon top (#20203): ' + what);
                        if (r.ask) check(r.actTop != null && r.iconBottom != null && r.actTop >= r.iconBottom, a + "the question's buttons are under the icon: " + what);
                        const c = await ev(`(() => { const b = ${ROWS}[${i}].getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + 10) }; })()`);
                        await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: c.x, y: c.y }); await ev(framesJs(2));
                        const hov = await ev(`(() => { const tr = ${ROWS}[${i}], rb = tr.getBoundingClientRect(), name = tr.getAttribute('aria-label') || ''; return [...tr.querySelectorAll('.nl-hover-actions button')].filter(b => b.getClientRects().length).map(b => { const r = b.getBoundingClientRect(); return { t: b.textContent.replace(/bookmark_border|bookmark/g, '').trim(), l: b.getAttribute('aria-label') || '', inRow: r.right <= rb.right && r.left >= rb.left, right: Math.round(rb.right - r.right), named: !!b.textContent.replace(/bookmark_border|bookmark/g, '').trim() || (!!name.trim() && (b.getAttribute('aria-label') || '').includes(name.trim())) }; }); })()`);
                        check(hov.length >= 1 && hov.every(b => b.named && b.inRow && b.right <= 24 + 80), a + 'under the mouse the row shows its actions at the right, each one named (a word, or an aria-label with the row\'s name): ' + JSON.stringify({ row: r.name, hov }));
                        await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 2, y: 2 });
                    } else if (r.file) check(!r.words.some(x => /^(Comment|Save|Save for later|More|Star)$/.test(x.t)), a + 'a phone keeps its icons (no worded Save, Star or More on the row): ' + what);
                }
                await shot((mobile ? 'phone-' : 'computer-') + w + '-' + theme);
            }
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    assert.equal(failures.length, 0, [...new Set(failures)].join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
