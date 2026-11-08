// The phone's Needs you is one card per item in the agent chat's look (#14144, the Operator: "the Inbox on the phone is a bit jumbled, probably trying to put too much on. Follow the agent chat look."; the mock they approved):
// each file or question is a card with the chat's own card colour, 1 px border and 12 px radius with the small top-left corner, 12 px apart; the glyph clears the sender's name; the description is ONE line; the sort
// controls are two compact chips (the word "Sort by" stays for a screen reader); the count equals the cards drawn; the footer notice is after the last card, never over it; nothing runs off the screen. 390 and 430 px,
// dark and light, and 200% text. The review rows are stubbed through the owner list; the Inbox and its fold are real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client; const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, theme, font] of [[390, 'dark', 16], [430, 'dark', 16], [390, 'light', 16], [390, 'dark', 32], [320, 'dark', 16], [360, 'dark', 16]]) {
            const at = `${w} ${theme} ${font}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(INBOX_WORLD);
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); document.documentElement.style.fontSize = '${font}px'; true`);
            await ev(`(() => { const real = window.fetch, now = Date.now(), hex = n => n.toString(16).padStart(64, '0');
                const rows = [{ id: hex(1), name: 'Desktop film with local voice over (Samantha, v3).mp4', media_type: 'text/html', size: 900, created_at: new Date(now - 10 * 3600e3).toISOString(), available: true, tags: ['for review'], produced_by: 'Developer experience', review_question: 'v3: fuller captions over the whole film, same words spoken. Good? A longer second sentence that must not make the card taller.', version: 3, earlier_digests: [hex(8), hex(9)] },
                    { id: hex(2), name: 'release-plan.md', media_type: 'text/markdown', size: 1200, created_at: new Date(now - 20 * 3600e3).toISOString(), available: true, tags: ['for review'], produced_by: 'Orchestrator', review_question: 'On v2.0.57, do the main pages look consistent on a phone?' }];
                window.fetch = (u, o = {}) => { if (/\\/api\\/board\\/team-a\\/artifacts\\/[0-9a-f]{64}\\/tags/.test(String(u)) && (o.method || 'GET').toUpperCase() === 'PUT') return Promise.resolve(new Response(JSON.stringify({ tags: ['for review', 'read'] }), { status: 200, headers: { 'Content-Type': 'application/json' } })); const page = window.__reviewFixturePage(u, location.origin, { 'team-a': rows }); if (page) return Promise.resolve(new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json' } })); return real(u, o); }; return true; })()`);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length === 2`, `${at}two cards`, 15000);
            await waitFor(`!!document.querySelector('#group-table-view .dt-box.dt-folded')`, `${at}folded to phone rows`, 5000);
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
            check(m.cards.length === 2 && m.cards.every(c => c.bg === m.chat.bg && c.bw === '1px' && c.border === m.chat.border), `${at}each item is a card in the chat's colour with its 1 px border: ` + JSON.stringify({ chat: m.chat, cards: m.cards.map(c => [c.bg, c.bw, c.border]) }));
            check(m.cards.every(c => c.radius === m.chat.radius && c.tl === m.chat.tl), `${at}and its corners (12 px, the small top-left one): ` + JSON.stringify([m.chat.radius, m.chat.tl, m.cards.map(c => [c.radius, c.tl])]));
            check(b.rect[1] - a.rect[3] >= 10 && b.rect[1] - a.rect[3] <= 14, `${at}the cards are 12 px apart: ${Math.round(b.rect[1] - a.rect[3])}`);
            { const st = await ev(`[...document.querySelectorAll('#group-table-view tbody tr.dt-row')].map(tr => { const star = tr.querySelector('.dt-star, .inbox-review-star'), btns = [...tr.querySelectorAll('.inbox-review-actions .btn')].filter(b => b.getBoundingClientRect().width > 2 && b.getBoundingClientRect().height > 2), r = e => { const x = e.getBoundingClientRect(); return [Math.round(x.left), Math.round(x.top), Math.round(x.right), Math.round(x.bottom)]; }, hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]; const sr = star && star.getClientRects().length ? r(star) : null; return { star: sr, btns: btns.map(r), overlap: !!sr && btns.some(b => hit(sr, r(b))) }; })`); check(st.every(x => !x.overlap), `${at}the star does not sit over a button of the card (#14627): ` + JSON.stringify(st)); }
            if (/ 16px/.test(at)) check(m.cards.every(c => c.rect[3] - c.rect[1] <= (w < 360 ? 185 : 165)), `${at}a review card is compact: the sender, the title, the one-line summary and the 44 px button row, no gap where the star's 44 px used to be (#14574, #14627, the approved phone design): ` + JSON.stringify(m.cards.map(c => Math.round(c.rect[3] - c.rect[1]))));
            check(m.cards.every(c => c.glyphRight !== null && c.glyphRight <= c.fromLeft + 1), `${at}the glyph clears the sender's name: ` + JSON.stringify(m.cards.map(c => [c.glyphRight, c.fromLeft])));
            check(m.cards.every(c => c.qLines === null || c.qLines <= 1), `${at}a file's review question is ONE line on a card (the approved mock; needs_three_lines pins the same on a phone): ` + JSON.stringify(m.cards.map(c => c.qLines)));
            check(!m.sortLabelPx || (m.sortLabelPx[0] <= 1 && m.sortLabelPx[1] <= 1), `${at}a phone has no Sort by band (the order is the Filters panel's Sort, #14574, the approved phone design); if one is drawn its word is for a screen reader: ` + JSON.stringify(m.sortLabelPx));
            check(await ev(`!document.querySelector('#group-table-view .dt-sortbar:not([hidden])')`), `${at}no Sort by and Ascending band above the cards`);
            check(!m.wide && m.cards.every(c => c.rect[0] >= 0 && c.rect[2] <= m.vw && !c.over), `${at}nothing runs off the screen: ` + JSON.stringify([m.wide, m.vw, m.cards.map(c => c.rect)]));
            check(m.tailTop === null || m.tailTop >= b.rect[3], `${at}the footer notice is after the last card, not over it: ` + JSON.stringify([m.tailTop, b.rect[3]]));
            // QA's SHOULD: an unread (or hovered) row's tint must never paint over the card: the row is the chat's colour and none of its cells paints a colour of its own
            await Input.dispatchMouseEvent({ type: 'mouseMoved', x: Math.round(a.rect[0] + 40), y: Math.round(a.rect[1] + 30) });
            const paint = await ev(`(() => { const trs = [...document.querySelectorAll('#group-table-view tbody tr.dt-row')]; return trs.map(tr => ({ unread: tr.classList.contains('dt-unread'), bg: getComputedStyle(tr).backgroundColor, cells: [...tr.children].map(td => getComputedStyle(td).backgroundColor).filter(c => c !== 'rgba(0, 0, 0, 0)') })); })()`);
            check(paint.some(p => p.unread) && paint.every(p => p.cells.length === 0) && paint.filter(p => p.unread).every(p => p.bg === m.chat.bg), `${at}an unread row is the chat card's colour and no cell paints one over it (the tint, the hover): ` + JSON.stringify({ chat: m.chat.bg, paint }));
            // the Operator: "the search bar is offset": ONE left edge, 12 px, for everything on the page (text, controls and cards), at this width
            const edges = await ev(`(() => { const left = e => e && Math.round(e.getBoundingClientRect().left), cs = e => getComputedStyle(e), view = document.getElementById('group-table-view');
                const text = e => { const w2 = document.createTreeWalker(e, NodeFilter.SHOW_TEXT, { acceptNode: n => n.textContent.trim() ? 1 : 3 }), n = w2.nextNode(); if (!n) return null; const rg = document.createRange(); rg.selectNodeContents(n); return Math.round(rg.getBoundingClientRect().left); };
                const vis = e => !!e && !!e.getClientRects().length && e.getBoundingClientRect().width > 0;
                const search = [...document.querySelectorAll('input[type=search]')].find(vis), tog = view.querySelector('.inbox-group-review-toggle'), sel = view.querySelector('.dt-sortbar-select'), note = view.querySelector('.inbox-alerts-link'), alerts = note && note.querySelector('button');
                return { title: text(view.querySelector('h2')), search: search && Math.round(search.getBoundingClientRect().left + parseFloat(cs(search).paddingLeft) + parseFloat(cs(search).borderLeftWidth)), chips: sel && sel.getClientRects().length ? left(sel) : null, card: left(view.querySelector('tbody tr.dt-row')), note: note && text(note), alerts: alerts && text(alerts) - parseFloat(cs(alerts).paddingLeft) + parseFloat(cs(alerts).paddingLeft) }; })()`);
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
                const said = await ev(`(document.getElementById('artifact-viewer').innerText || '').replace(/\\s+/g, ' ')`);
                check(said.includes('A longer second sentence that must not make the card taller.'), `${at}the file's header carries the whole question the card cut: ` + JSON.stringify(said.slice(0, 300)));
                await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close')?.click(); true`);
            }
            const badge = await ev(`document.getElementById('nav-tab-hub-inbox-badge')?.textContent`);
            check(badge === '2', `${at}the count is the number of cards (2): ` + badge);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS the phone Needs you is one chat-style card per item at 390 and 430');
})().catch(e => { console.error(e); process.exit(1); });
