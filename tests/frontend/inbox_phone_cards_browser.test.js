// The phone's Needs you is one card per item in the agent chat's look (#14144, the Operator: "the Inbox on the phone is a bit jumbled, probably trying to put too much on. Follow the agent chat look."; the mock they approved):
// each file or question is a card with the chat's own card colour, 1 px border and 12 px radius with the small top-left corner, 12 px apart; the glyph clears the sender's name; the message wraps above its footer (#20203); the sort
// controls are two compact chips (the word "Sort by" stays for a screen reader); the count is unread attention while read cards remain visible; the footer notice is after the last card, never over it; nothing runs off the screen. 390 and 430 px,
// dark and light, and 200% text. The review rows are stubbed through the owner list; the Inbox and its fold are real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const { removeBoards } = require('./helpers/board_cleanup');
const board = 'phone-cards-' + Date.now().toString(36);
const BASE = require('./test_base').BASE;
const { coralReady, nextFrame } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client; const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, theme, font] of [[390, 'dark', 16], [430, 'dark', 16], [390, 'light', 16], [390, 'dark', 32], [320, 'dark', 16], [360, 'dark', 16]]) {
            const at = `${w} ${theme} ${font}px: `; let opened = false;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            assert.equal(await ev(`fetch('/api/board/${board}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Writer',job_title:'Writer'})}).then(r=>r.status)`), 200);
            assert.equal(await ev(`fetch('/api/board/${board}',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:'seedteam'})}).then(r=>r.status)`), 200);
            await ev(INBOX_WORLD);
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); document.documentElement.style.fontSize = '${font}px'; true`);
            await ev(`(() => { const real = window.fetch, now = Date.now(), hex = n => n.toString(16).padStart(64, '0');
                const rows = [{ id: hex(1), name: 'Desktop film with local voice over (Samantha, v3).mp4', media_type: 'text/html', size: 900, created_at: new Date(now - 10 * 3600e3).toISOString(), available: true, tags: ['for review'], produced_by: 'Developer experience', review_question: 'v3: fuller captions over the whole film, same words spoken. Good? A longer second sentence that must not make the card taller.', version: 3, earlier_digests: [hex(8), hex(9)] },
                    { id: hex(2), name: 'notes2.md', file_id: 'b'.repeat(32), version: 1, version_line: 'version 1 of notes2.md', goal_id: 1, goal_title: 'Ship the notes', task_id: 1, task_title: 'Publish notes', waits_on_this: {count: 0, closes_goal: 'Ship the notes'}, media_type: 'text/markdown', size: 1200, created_at: new Date(now - 20 * 3600e3).toISOString(), available: true, tags: ['for review'], produced_by: 'Writer', review_question: 'On v2.0.57, do the main pages look consistent on a phone?' }];
                window.fetch = (u, o = {}) => { if (/\\/api\\/board\\/${board}\\/artifacts\\/[0-9a-f]{64}\\/tags/.test(String(u)) && (o.method || 'GET').toUpperCase() === 'PUT') { const id = new URL(String(u), location.href).pathname.split('/').at(-2), tags = JSON.parse(o.body).tags; const item = rows.find(a => a.id === id); if (item) item.tags = tags; return Promise.resolve(new Response(JSON.stringify({ tags }), { status: 200, headers: { 'Content-Type': 'application/json' } })); } const page = window.__reviewFixturePage(u, location.origin, { '${board}': {team: 'seedteam', artifacts: rows} }); if (page) return Promise.resolve(new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json' } })); return real(u, o); }; return true; })()`);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length === 2`, `${at}two cards`, 15000);
            await waitFor(`!!document.querySelector('#group-table-view .dt-box.dt-folded')`, `${at}folded to phone rows`, 5000);
            await waitFor(`document.getElementById('nav-tab-hub-inbox-badge')?.textContent === '2'`, `${at}two unread cards count before either is opened`);
            await new Promise(r => setTimeout(r, 800)); // sleep-ok: the fold settles after the first paint
            const m = await ev(`(() => { const rows = [...document.querySelectorAll('#group-table-view tbody tr.dt-row')], rc = e => e.getBoundingClientRect();
                const probe = Object.assign(document.createElement('div'), { className: 'chat-bubble assistant' }); document.body.append(probe); const pc = getComputedStyle(probe); const chat = { bg: pc.backgroundColor, border: pc.borderTopColor, radius: pc.borderTopRightRadius, tl: pc.borderTopLeftRadius }; probe.remove();
                const cards = rows.map(r => { const cs = getComputedStyle(r), from = r.querySelector('.inbox-review-from'), glyph = r.querySelector('.inbox-kind-icon'), q = r.querySelector('.inbox-file-question'), lh = q ? parseFloat(getComputedStyle(q).lineHeight) || 16 : 16;
                    return { bg: cs.backgroundColor, border: cs.borderTopColor, bw: cs.borderTopWidth, radius: cs.borderTopRightRadius, tl: cs.borderTopLeftRadius, rect: [rc(r).left, rc(r).top, rc(r).right, rc(r).bottom], glyphRight: glyph ? rc(glyph).right : null, fromLeft: from ? rc(from).left : null, qLines: q ? Math.round(rc(q).height / lh) : null, over: r.scrollWidth > r.clientWidth + 1 }; });
                const count = document.querySelector('#group-table-view .list-count, #group-table-view .view-count, .inbox-needs-count')?.textContent;
                const sortLabel = document.querySelector('#group-table-view .dt-sortbar-label'), lr = sortLabel && rc(sortLabel);
                const tail = [...document.querySelectorAll('#group-table-view *')].find(e => /Get an alert when an agent waits/.test(e.textContent) && e.children.length < 3);
                return { chat, cards, count, sortLabelPx: lr ? [Math.round(lr.width), Math.round(lr.height)] : null, tailTop: tail ? rc(tail).top : null, wide: document.documentElement.scrollWidth > innerWidth + 1, vw: innerWidth }; })()`);
            const [a, b] = m.cards;
            if (w === 390 && font === 16) {
                const linked = await ev(`(() => { const tr = [...document.querySelectorAll('#group-table-view tr.dt-row')].find(r => r.textContent.includes('notes2.md')), item = tr.querySelector('.inbox-review-item'), board = item.querySelector('.inbox-header-board'), meta = item.querySelector('.inbox-phone-meta'), pills = [...item.querySelectorAll('.inbox-pill')], closes = tr.querySelector('.inbox-blocks-closes'), range = document.createRange(); range.selectNodeContents(meta); const rects = [...range.getClientRects()].filter(r => r.width > 1 && r.height > 1), cs = closes && getComputedStyle(closes); return {board: board?.textContent, boardFits: !!board && board.scrollWidth <= board.clientWidth + 1, meta: meta.textContent, grid: getComputedStyle(item).gridTemplateAreas, columns:getComputedStyle(item).gridTemplateColumns, metaLines: new Set(rects.map(r => Math.round(r.top))).size, pills: pills.map(p => ({text:p.textContent,top:Math.round(p.getBoundingClientRect().top)})), closes: closes?.textContent, border: cs?.borderTopWidth, radius: cs?.borderTopLeftRadius}; })()`);
                check(linked.board === 'seedteam' && linked.boardFits, at+'goal-linked team name is whole: '+JSON.stringify(linked));
                check(linked.meta.includes('version 1 of notes2.md') && linked.metaLines === 1, at+'goal-linked version line stays whole: '+JSON.stringify(linked));
                check(linked.pills.length === 2 && linked.pills[0].top === linked.pills[1].top, at+'Goal and Task chips share one row: '+JSON.stringify(linked));
                check(linked.closes?.includes('Ship the notes') && linked.border !== '0px' && parseFloat(linked.radius) > 0, at+'Closes goal is a muted pill: '+JSON.stringify(linked));
                await ev(`(() => { const tr = [...document.querySelectorAll('#group-table-view tr.dt-row')].find(r => r.textContent.includes('notes2.md')); window.__goalScroll = []; for(let n=tr;n;n=n.parentElement)window.__goalScroll.push([n,n.scrollTop]); tr.scrollIntoView({block:'start'}); return true; })()`);
                await nextFrame(ev);
                await shot('goal-linked-'+w+'-'+theme);
                await ev(`window.__goalScroll.forEach(([n,y])=>n.scrollTop=y);true`);
                await nextFrame(ev);
            }

            // #21161 (the Operator's approved look): an unread card carries the 12% accent tint; a read one is the chat's colour
            const tint = await ev(`(() => { const e = document.createElement('span'); e.style.background = 'color-mix(in srgb, var(--accent) 12%, var(--bg-secondary))'; document.body.append(e); const c = getComputedStyle(e).backgroundColor; e.remove(); return c; })()`);
            check(m.cards.length === 2 && m.cards.every(c => (c.bg === m.chat.bg || c.bg === tint) && c.bw === '1px' && c.border === m.chat.border), `${at}each item is a card in the chat's colour (unread: the accent tint) with its 1 px border: ` + JSON.stringify({ chat: m.chat, cards: m.cards.map(c => [c.bg, c.bw, c.border]) }));
            check(m.cards.every(c => c.radius === m.chat.radius && c.tl === m.chat.tl), `${at}and its corners (12 px, the small top-left one): ` + JSON.stringify([m.chat.radius, m.chat.tl, m.cards.map(c => [c.radius, c.tl])]));
            check(b.rect[1] - a.rect[3] >= 10 && b.rect[1] - a.rect[3] <= 14, `${at}the cards are 12 px apart: ${Math.round(b.rect[1] - a.rect[3])}`);
            { const st = await ev(`[...document.querySelectorAll('#group-table-view tbody tr.dt-row')].map(tr => { const star = tr.querySelector('.dt-star, .inbox-review-star'), btns = [...tr.querySelectorAll('.inbox-review-actions .btn')].filter(b => b.getBoundingClientRect().width > 2 && b.getBoundingClientRect().height > 2), r = e => { const x = e.getBoundingClientRect(); return [Math.round(x.left), Math.round(x.top), Math.round(x.right), Math.round(x.bottom)]; }, hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]; const sr = star && star.getClientRects().length ? r(star) : null; return { star: sr, btns: btns.map(r), overlap: !!sr && btns.some(b => hit(sr, r(b))) }; })`); check(st.every(x => !x.overlap), `${at}the star does not sit over a button of the card (#14627): ` + JSON.stringify(st)); }

            check(m.cards.every(c => c.glyphRight !== null && c.glyphRight <= c.fromLeft + 1), `${at}the glyph clears the sender's name: ` + JSON.stringify(m.cards.map(c => [c.glyphRight, c.fromLeft])));
            check(await ev(`[...document.querySelectorAll('#group-table-view tbody tr.dt-row')].every(r => { const message = r.querySelector('.inbox-message'), footer = r.querySelector('.inbox-v4-footer'); return message && footer && message.getBoundingClientRect().bottom <= footer.getBoundingClientRect().top + 1 && getComputedStyle(message).webkitLineClamp === 'none'; })`), `${at}the full review message sits above its footer without a one-line clamp (#20203)`);
            check(!m.sortLabelPx || (m.sortLabelPx[0] <= 1 && m.sortLabelPx[1] <= 1), `${at}a phone has no Sort by band (the order is the Filters panel's Sort, #14574, the approved phone design); if one is drawn its word is for a screen reader: ` + JSON.stringify(m.sortLabelPx));
            check(await ev(`!document.querySelector('#group-table-view .dt-sortbar:not([hidden])')`), `${at}no Sort by and Ascending band above the cards`);
            check(!m.wide && m.cards.every(c => c.rect[0] >= 0 && c.rect[2] <= m.vw && !c.over), `${at}nothing runs off the screen: ` + JSON.stringify([m.wide, m.vw, m.cards.map(c => c.rect)]));
            check(m.tailTop === null || m.tailTop >= b.rect[3], `${at}the footer notice is after the last card, not over it: ` + JSON.stringify([m.tailTop, b.rect[3]]));
            // QA's SHOULD: an unread (or hovered) row's tint must never paint over the card: the row is the chat's colour and none of its cells paints a colour of its own
            await Input.dispatchMouseEvent({ type: 'mouseMoved', x: Math.round(a.rect[0] + 40), y: Math.round(a.rect[1] + 30) });
            const paint = await ev(`(() => { const trs = [...document.querySelectorAll('#group-table-view tbody tr.dt-row')]; return trs.map(tr => ({ unread: tr.classList.contains('dt-unread'), bg: getComputedStyle(tr).backgroundColor, cells: [...tr.children].map(td => getComputedStyle(td).backgroundColor).filter(c => c !== 'rgba(0, 0, 0, 0)') })); })()`);
            check(paint.some(p => p.unread) && paint.every(p => p.cells.length === 0) && paint.filter(p => p.unread).every(p => p.bg === tint), `${at}an unread row is the accent tint on the card and no cell paints one over it (the tint, the hover): ` + JSON.stringify({ chat: m.chat.bg, paint }));
            // the Operator: "the search bar is offset": ONE left edge, 12 px, for everything on the page (text, controls and cards), at this width
            const edges = await ev(`(() => { const left = e => e && Math.round(e.getBoundingClientRect().left), cs = e => getComputedStyle(e), view = document.getElementById('group-table-view');
                const text = e => { const w2 = document.createTreeWalker(e, NodeFilter.SHOW_TEXT, { acceptNode: n => n.textContent.trim() ? 1 : 3 }), n = w2.nextNode(); if (!n) return null; const rg = document.createRange(); rg.selectNodeContents(n); return Math.round(rg.getBoundingClientRect().left); };
                const vis = e => !!e && !!e.getClientRects().length && e.getBoundingClientRect().width > 0;
                const search = [...document.querySelectorAll('input[type=search]')].find(vis), tog = view.querySelector('.inbox-group-review-toggle'), sel = view.querySelector('.dt-sortbar-select'), note = view.querySelector('.inbox-alerts-link'), alerts = note && note.querySelector('button');
                const h2 = view.querySelector('h2'), tabs = view.querySelector('.inbox-needs-tabs .inbox-needs-tab'); return { title: h2 && h2.getBoundingClientRect().width > 1 ? text(h2) : null, tabs: tabs && vis(tabs) ? left(tabs) : null, search: search && Math.round(search.getBoundingClientRect().left + parseFloat(cs(search).paddingLeft) + parseFloat(cs(search).borderLeftWidth)), chips: sel && sel.getClientRects().length ? left(sel) : null, card: left(view.querySelector('tbody tr.dt-row')), note: note && text(note), alerts: alerts && text(alerts) - parseFloat(cs(alerts).paddingLeft) + parseFloat(cs(alerts).paddingLeft) }; })()`);
            check(Object.entries(edges).filter(([, v]) => v !== null && v !== undefined).every(([, v]) => Math.abs(v - 12) <= 1), `${at}one left edge (12 px) for the title, the search, the chips, the cards and the notice: ` + JSON.stringify(edges));
            // UI Reviewer's MUST (#14503): the grouping box has a left edge to hold too: open Filters, require the box visible, measure it, and shut the panel again (the other edges are measured with it shut)
            await ev(`document.getElementById('inbox-needs-toggle').click(); true`);
            await waitFor(`(() => { const t = document.querySelector('#group-table-view .inbox-group-review-toggle'); return !!t && t.getClientRects().length > 0 && t.getBoundingClientRect().width > 0; })()`, `${at}Filters opens and the Group by goal box is visible`, 8000);
            const grp = await ev(`(() => { const t = document.querySelector('#group-table-view .inbox-group-review-toggle'), panel = t.closest('.list-bar-menu'), box = t.querySelector('select'); return { toggle: Math.round(t.getBoundingClientRect().left), panel: panel ? Math.round(panel.getBoundingClientRect().left) : null, box: Math.round(box.getBoundingClientRect().left), inside: !!panel && panel.contains(t) }; })()`);
            check(grp.inside && grp.panel !== null && Math.abs(grp.panel - 12) <= 1, `${at}the Filters panel that holds the grouping box keeps the one left edge, 12 px: ` + JSON.stringify(grp));
            check(grp.toggle >= grp.panel && grp.toggle - grp.panel <= 16 && grp.box >= grp.toggle, `${at}the Group by option sits inside the panel by the panel's own inset (at most 16 px), its choice after its label (#14729): ` + JSON.stringify(grp));
            await ev(`document.getElementById('inbox-needs-toggle').click(); true`);
            if (w === 390 && theme === 'dark' && font === 16) await shot('phone-cards-390');
            if (w === 430) await shot('phone-cards-430');
            // the whole question is ONE TAP away: a tap on the card opens the file, and its header says the full question the card cut
            if (w === 390 && theme === 'dark' && font === 16) {
                await ev(`document.querySelector('#group-table-view tbody tr.dt-row .dt-primary').click(); true`);
                await waitFor(`(() => { const v = document.getElementById('artifact-viewer'); return !!v && !v.hidden; })()`, `${at}one tap opens the file`, 8000);
                // the sender's question is in Details (#19771: the header is one row): on a phone Details is an item of the ⋯ menu
                await ev(`document.querySelector('#artifact-viewer .artifact-viewer-more').click(); true`);
                await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-details-item') && document.querySelector('#artifact-viewer .artifact-viewer-details-item').getClientRects().length > 0`, `${at}the Details item is in the menu`, 6000);
                await ev(`document.querySelector('#artifact-viewer .artifact-viewer-details-item').click(); true`);
                await waitFor(`(() => { const f = document.querySelector('#artifact-viewer .artifact-viewer-from'); return !!f && f.getClientRects().length > 0; })()`, `${at}Details shows the question`, 6000);
                const said = await ev(`(document.getElementById('artifact-viewer').innerText || '').replace(/\\s+/g, ' ')`);
                check(said.includes('A longer second sentence that must not make the card taller.'), `${at}the file's Details carry the whole question the card cut: ` + JSON.stringify(said.slice(0, 300)));
                await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close')?.click(); true`);
                opened = true;
                await waitFor(`document.getElementById('nav-tab-hub-inbox-badge')?.textContent === '1'`, `${at}opening marks one card read and drops unread attention`);
                check(await ev(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length === 2 && document.querySelectorAll('#group-table-view tbody tr.dt-row.dt-read').length === 1`), `${at}the read card remains visible alongside the unread card`);
            }
            const badge = await ev(`document.getElementById('nav-tab-hub-inbox-badge')?.textContent`);
            check(badge === (opened ? '1' : '2'), `${at}the badge counts unread cards (${opened ? 1 : 2}), while both cards remain listed: ` + badge);
            // The corrected chip row remains part of the long-press selection surface.
            if (w === 390 && font === 16) {
                const point = await ev(`(() => { const chip = document.querySelector('#group-table-view [data-goal-pill="1"]'); chip.scrollIntoView({block:'center'}); const r=chip.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
                await Input.dispatchTouchEvent({type:'touchStart',touchPoints:[{...point,id:1}]});
                await waitFor(`document.querySelectorAll('#group-table-view tr.dt-selected').length === 1`, at+'long-press on the Goal chip selects its card', 3000);
                await Input.dispatchTouchEvent({type:'touchEnd',touchPoints:[]});
                await nextFrame(ev);
                check(await ev(`!!document.querySelector('#group-table-view tr.dt-selected [data-goal-pill="1"]') && document.querySelector('.dt-bar-count')?.textContent === '1 selected'`), at+'long-press on a chip keeps Inbox open with that card selected');
                await ev(`document.querySelector('.dt-bar-cancel').click();true`);
            }

        }
    } finally { await removeBoards(ev, [board]); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS the phone Needs you is one chat-style card per item at 390 and 430');
})().catch(e => { console.error(e); process.exit(1); });
