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
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, theme, font] of [[390, 'dark', 16], [430, 'dark', 16], [390, 'light', 16], [390, 'dark', 32]]) {
            const at = `${w} ${theme} ${font}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(INBOX_WORLD);
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); document.documentElement.style.fontSize = '${font}px'; true`);
            await ev(`(() => { const real = window.fetch, now = Date.now(), hex = n => n.toString(16).padStart(64, '0');
                const rows = [{ id: hex(1), name: 'Desktop film with local voice over (Samantha, v3).mp4', media_type: 'text/html', size: 900, created_at: new Date(now - 10 * 3600e3).toISOString(), available: true, tags: ['for review'], produced_by: 'Developer experience', review_question: 'v3: fuller captions over the whole film, same words spoken. Good? A longer second sentence that must not make the card taller.', version: 3, earlier_digests: [hex(8), hex(9)] },
                    { id: hex(2), name: 'release-plan.md', media_type: 'text/markdown', size: 1200, created_at: new Date(now - 20 * 3600e3).toISOString(), available: true, tags: ['for review'], produced_by: 'Orchestrator', review_question: 'On v2.0.57, do the main pages look consistent on a phone?' }];
                window.fetch = (u, o = {}) => { const page = window.__reviewFixturePage(u, location.origin, { 'team-a': rows }); if (page) return Promise.resolve(new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json' } })); return real(u, o); }; return true; })()`);
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
            check(m.cards.every(c => c.glyphRight !== null && c.glyphRight <= c.fromLeft + 1), `${at}the glyph clears the sender's name: ` + JSON.stringify(m.cards.map(c => [c.glyphRight, c.fromLeft])));
            check(m.cards.every(c => c.qLines === null || c.qLines <= 1), `${at}the description is one line: ` + JSON.stringify(m.cards.map(c => c.qLines)));
            check(m.sortLabelPx && m.sortLabelPx[0] <= 1 && m.sortLabelPx[1] <= 1, `${at}"Sort by" is for a screen reader, not drawn: ` + JSON.stringify(m.sortLabelPx));
            check(!m.wide && m.cards.every(c => c.rect[0] >= 0 && c.rect[2] <= m.vw && !c.over), `${at}nothing runs off the screen: ` + JSON.stringify([m.wide, m.vw, m.cards.map(c => c.rect)]));
            check(m.tailTop === null || m.tailTop >= b.rect[3], `${at}the footer notice is after the last card, not over it: ` + JSON.stringify([m.tailTop, b.rect[3]]));
            const badge = await ev(`document.getElementById('nav-tab-hub-inbox-badge')?.textContent`);
            check(badge === '2', `${at}the count is the number of cards (2): ` + badge);
            if (w === 390 && theme === 'dark' && font === 16) await shot('phone-cards-390');
            if (w === 430) await shot('phone-cards-430');
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS the phone Needs you is one chat-style card per item at 390 and 430');
})().catch(e => { console.error(e); process.exit(1); });
