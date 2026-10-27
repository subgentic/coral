// The team's Board as a table (#7921, goal #33; UI/UX's mock #7916): one row a message (arrow, sender, one line of the message, quiet tags, time) under day lines, a row opens in place to the whole message
// (80 characters wide) with Reply, Copy link and More, the replies are indented and listed under their message, a Table | Chat switch (Table is the default, the choice is remembered), the pills
// All / Questions / Mentions me, Expand all and Collapse all in the search bar's More menu, Reply puts "@Sender " in the composer and posts with reply_to, Copy link is the message's own address and
// opening it lands on the message. At 1280 px and 390 px (two-line rows, the tags with the open message, 44 px targets), in the dark and the light theme. Real board over the API. Drives Chrome over CDP
// through agent_view_harness.js against the isolated dev server; with CORAL_SCREENSHOT_DIR set it also saves a picture of each.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect(); const Input = client.Input;
    const B = 'tbl-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const { settle } = require('./helpers/wait').bind(ev);
    const post = async (who, content, extra = {}) => { const r = await api('POST', `/api/board/${B}/messages`, { subscriber_id: who, content, ...extra }); assert.equal(r.status, 200, `${who} posts: ${JSON.stringify(r)}`); return r.body.id || (r.body.message && r.body.message.id); };
    const ROWS = `[...document.querySelectorAll('#mb-messages > .mb-message')]`;
    const open = async (w, h, mobile, theme, view = 'table', path = `/team/${B}/messages`) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
        await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(async () => { const sc = await import((window.__coralStatic || '/static/') + 'settings_core.js'); sc.clearCustomThemeVars(); sc.applyTheme(${JSON.stringify(theme)}); try { localStorage.setItem('coral.board.view', ${JSON.stringify(view)}); } catch {} return true; })()`);
        await Page.navigate({ url: BASE + path }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await waitFor(`document.querySelectorAll('#mb-messages > .mb-message').length >= 6`, 'the board rows', 15000);
        await settle(400);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        for (const [id, t] of [['Orchestrator', 'Orchestrator'], ['QA Engineer', 'QA Engineer'], ['Backend Dev', 'Backend Dev'], ['Lead Developer', 'Lead Developer']]) assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: t, session_name: id + '-s' })).status, 200);
        const firstId = await post('QA Engineer', 'Review of the Inbox patch: approved with two small follow-ups for the empty states. @Orchestrator #7740');
        const qid = await post('Lead Developer', 'Question for @Backend Dev: should group posts reach members, or only the ones they tag?\n\nToday a plain read returns tagged messages.\n\n- the read includes the group\'s posts\n- group posts stay tagged-only\n\nI lean to the second. #7757', { ask: true });
        const rid = await post('Backend Dev', 'Agreed with the second; the count already follows the read.', { reply_to: qid });
        await post('Orchestrator', 'Fine. @Operator please look at the plan when you can: ' + 'a long line that goes on and on to be cut by the row and shown whole when open, '.repeat(4) + '#7809');
        await post('Backend Dev', 'Summary posted. #7809');
        await post('Lead Developer', '@Backend Dev @QA Engineer @Orchestrator six marks in one message #7790', { ask: true, reply_to: firstId }); // a reply, three mentions, a task and a question: six marks

        console.log('1. Desktop: Table is the default, one row a message');
        await open(1280, 800, false, 'dark');
        const t = await ev(`(() => { const rows = ${ROWS}.map(r => { const h = r.querySelector(':scope > .mb-row-toggle'), hr = h.getBoundingClientRect(), body = r.querySelector('.mb-message-body'); return { h: Math.round(hr.height), who: h.querySelector('.mb-row-who').textContent, snippetCut: h.querySelector('.mb-row-snippet').scrollWidth > h.querySelector('.mb-row-snippet').clientWidth, tags: [...h.querySelectorAll('.mb-row-tag, .mb-ask-badge')].filter(x => x.getClientRects().length).map(x => x.textContent.trim()), who500: getComputedStyle(h.querySelector('.mb-row-who')).fontWeight, bodyShown: body.getClientRects().length > 0, expanded: h.getAttribute('aria-expanded'), reply: r.classList.contains('mb-is-reply'), time: !!h.querySelector('time') && getComputedStyle(h.querySelector('time')).opacity }; }); const day = document.querySelector('#mb-messages > .mb-day'); const box = document.getElementById('mb-messages'); return { view: box.dataset.view, rows, day: day && { text: day.textContent, sticky: getComputedStyle(day).position }, sideways: document.documentElement.scrollWidth > innerWidth + 1, switchPressed: [...document.querySelectorAll('.mb-view-btn')].map(b => b.textContent + ':' + b.getAttribute('aria-pressed')), pills: [...document.querySelectorAll('.mb-pill')].map(b => b.textContent + ':' + b.getAttribute('aria-pressed')) }; })()`);
        assert.equal(t.view, 'table'); assert.equal(t.rows.length, 6);
        assert.ok(t.rows.every(r => r.h >= 36 && r.h <= 44 && !r.bodyShown && r.expanded === 'false' && r.time === '1'), 'collapsed rows are one line of 36 to 44 px with no body: ' + JSON.stringify(t.rows.map(r => [r.h, r.bodyShown, r.expanded])));
        assert.ok(t.rows.some(r => r.snippetCut), 'a long message is cut to the row: ' + JSON.stringify(t.rows.map(r => r.snippetCut)));
        assert.deepEqual(t.rows[0].tags, [], 'one line a row (#9686): the mention and task tags are not on the row, they are with the open message: ' + JSON.stringify(t.rows[0].tags));
        assert.ok(t.rows.every(r => r.who500 === '500'), 'the sender is 13/500, nothing bolder: ' + JSON.stringify(t.rows.map(r => r.who500)));
        assert.deepEqual(t.rows[1].tags, [], 'an answered question is not marked on the row (the open message says Question, answered): ' + JSON.stringify(t.rows[1].tags));
        assert.ok(t.rows[2].reply && t.rows[2].tags.length === 0, 'a reply is indented; whom it answers is with the open message: ' + JSON.stringify(t.rows[2]));
        // six marks (#8147): the row shows only the open Question (#9686); the first mention, the "+4" pill and the rest are with the open message, which shows all six
        const six = await ev(`(() => { const r = ${ROWS}[5], tags = r.querySelector(':scope > .mb-row-toggle .mb-row-tags'); const more = tags.querySelector('.mb-row-more-tag'); return { shown: [...tags.children].filter(c => c.getClientRects().length).map(c => c.textContent.trim()), moreShown: !!more && more.getClientRects().length > 0, title: more && more.title, name: more && more.getAttribute('aria-label'), clipped: tags.scrollWidth > tags.clientWidth + 1 }; })()`);
        assert.deepEqual(six.shown, ['Question'], 'the open question alone: ' + JSON.stringify(six)); assert.equal(six.moreShown, false, 'no +N pill on the row');
        assert.equal(six.title, 'Reply to QA Engineer, @QA Engineer, @Orchestrator, #7790', 'the pill lists the rest'); assert.equal(six.name, '4 more: Reply to QA Engineer, @QA Engineer, @Orchestrator, #7790'); assert.equal(six.clipped, false, 'nothing is cut off by the stylesheet');
        await ev(`${ROWS}[5].scrollIntoView({ block: 'center' }); true`); await settle(200); await shot('board-six-marks-1280-dark');
        await ev(`${ROWS}[5].querySelector(':scope > .mb-row-toggle').click(); true`); await settle(250);
        assert.deepEqual(await ev(`[...${ROWS}[5].querySelectorAll(':scope > .mb-row-tags-open > *')].map(c => c.textContent.trim())`), ['Reply to QA Engineer', '@Backend Dev', '@QA Engineer', '@Orchestrator', '#7790', 'Question'], 'the open message shows every mark');
        await ev(`${ROWS}[5].querySelector(':scope > .mb-row-toggle').click(); true`); await settle(150);
        assert.ok(t.day && t.day.text === 'Today' && t.day.sticky === 'sticky', 'a sticky day line: ' + JSON.stringify(t.day));
        assert.equal(t.sideways, false, 'nothing scrolls sideways');
        const fills = await ev(`${ROWS}.map(r => { const a = getComputedStyle(r.querySelector('.mb-row-avatar')); return [a.backgroundColor, a.color]; })`);
        const lum = c => { const [r, g, b] = c.match(/\d+/g).slice(0, 3).map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        for (const [bg, fg] of fills) { assert.ok(!/rgba\(.*, 0\)/.test(bg), 'a solid avatar: ' + bg); const [a, b] = [lum(bg), lum(fg)].sort((x, y) => y - x); assert.ok((a + 0.05) / (b + 0.05) >= 4.5, `the initial reads 4.5:1 on its circle: ${bg} ${fg}`); }
        assert.deepEqual(t.switchPressed, ['Table:true', 'Chat:false']); assert.deepEqual(t.pills, ['All:true', 'Questions:false', 'Mentions me:false']);
        await shot('board-table-1280-dark');

        console.log('2. A row opens in place: the whole message in 80 characters, Reply, Copy link, More; the replies are listed');
        await ev(`document.querySelectorAll('#mb-messages > .mb-message')[1].querySelector('.mb-row-toggle').click(); true`); await settle(200);
        const o = await ev(`(() => { const r = document.querySelectorAll('#mb-messages > .mb-message')[1]; const h = r.querySelector(':scope > .mb-row-toggle'), b = r.querySelector('.mb-message-body'), br = b.getBoundingClientRect(); const px = parseFloat(getComputedStyle(b).fontSize); return { expanded: h.getAttribute('aria-expanded'), controls: h.getAttribute('aria-controls'), bodyId: b.id, shown: br.height > 0, ch: br.width / (px * 0.5), actions: [...r.querySelectorAll('.mb-row-actions button')].map(x => x.textContent + ':' + Math.round(x.getBoundingClientRect().height)), replies: r.querySelector('.mb-row-replies').textContent, snippetHidden: getComputedStyle(h.querySelector('.mb-row-snippet')).visibility, hasList: !!b.querySelector('ul'), name: h.textContent.replace(/\\s+/g, ' ').trim() }; })()`);
        assert.equal(o.expanded, 'true'); assert.equal(o.controls, o.bodyId); assert.ok(o.shown && o.hasList, 'the whole message with its list is shown');
        assert.ok(o.ch <= 180, 'the column is about 80 characters (box ' + Math.round(o.ch) + ' half-em units)');
        assert.deepEqual(o.actions.map(a => a.split(':')[0]), ['Open task #7757', 'Reply', 'Copy link', 'More']); assert.ok(/Replies \(1\)/.test(o.replies) && /Backend Dev/.test(o.replies), 'the replies are listed: ' + o.replies);
        assert.equal(o.snippetHidden, 'hidden');
        await shot('board-table-open-1280-dark');
        await ev(`document.querySelectorAll('#mb-messages > .mb-message')[1].querySelector('.mb-row-toggle').click(); true`); await settle(150);
        assert.equal(await ev(`document.querySelectorAll('#mb-messages > .mb-message')[1].querySelector('.mb-row-toggle').getAttribute('aria-expanded')`), 'false', 'a second press closes it');

        console.log('3. Keyboard: Enter and Space open and close a row; one Tab stop a row');
        await ev(`(() => { const h = document.querySelectorAll('#mb-messages > .mb-message')[0].querySelector('.mb-row-toggle'); h.focus(); return document.activeElement === h; })()`);
        const key = async (k, code) => { await Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, text: k === 'Enter' ? '\r' : ' ' }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code }); await settle(120); };
        await key('Enter', 'Enter');
        assert.equal(await ev(`document.activeElement.getAttribute('aria-expanded')`), 'true', 'Enter opens'); await key(' ', 'Space');
        assert.equal(await ev(`document.activeElement.getAttribute('aria-expanded')`), 'false', 'Space closes');
        assert.equal(await ev(`${ROWS}.every(r => r.querySelectorAll(':scope > .mb-row-toggle').length === 1 && getComputedStyle(r.querySelector('.mb-message-header .mb-msg-more')).display === 'none')`), true, 'the chat\'s per-row buttons are not Tab stops in the table');

        console.log('4. Pills: Questions and Mentions me');
        await ev(`[...document.querySelectorAll('.mb-pill')].find(b => b.textContent === 'Questions').click(); true`); await settle(150);
        assert.equal(await ev(`${ROWS}.filter(r => r.getClientRects().length).length`), 2, 'Questions shows the two questions');
        await ev(`[...document.querySelectorAll('.mb-pill')].find(b => b.textContent === 'Mentions me').click(); true`); await settle(150);
        assert.equal(await ev(`${ROWS}.filter(r => r.getClientRects().length).map(r => r.querySelector('.mb-row-who').textContent).join()`), 'Orchestrator', 'Mentions me shows the message that names the Operator');
        await ev(`[...document.querySelectorAll('.mb-pill')].find(b => b.textContent === 'All').click(); true`); await settle(150);
        assert.equal(await ev(`${ROWS}.filter(r => r.getClientRects().length).length`), 6);

        console.log('5. Expand all and Collapse all are in the search bar\'s More menu');
        const more = async label => { await ev(`(() => { const b = [...document.querySelectorAll('#mb-tools button')].find(x => x.getAttribute('aria-label') === 'More board actions' || /More/.test(x.getAttribute('aria-label') || '')); b.click(); return true; })()`); await settle(150); await ev(`[...document.querySelectorAll('#mb-tools [role=menuitem], #mb-tools .list-bar-more-menu button, #mb-tools [role=menu] button')].find(x => x.textContent.trim() === ${JSON.stringify(label)}).click(); true`); await settle(250); };
        await more('Expand all');
        assert.equal(await ev(`${ROWS}.every(r => r.classList.contains('mb-open') && r.querySelector('.mb-row-toggle').getAttribute('aria-expanded') === 'true')`), true, 'Expand all opens every row');
        await more('Collapse all');
        assert.equal(await ev(`${ROWS}.every(r => !r.classList.contains('mb-open'))`), true, 'Collapse all closes them');

        console.log('6. Reply puts the name in the composer; the post carries reply_to');
        await ev(`document.querySelectorAll('#mb-messages > .mb-message')[0].querySelector('.mb-row-toggle').click(); true`); await settle(150);
        await ev(`document.querySelectorAll('#mb-messages > .mb-message')[0].querySelector('.mb-row-actions').querySelectorAll('button').forEach(b => { if (b.textContent === 'Reply') b.click(); }); true`); await settle(150);
        const c = await ev(`({ value: document.getElementById('mb-post-input').value, focused: document.activeElement === document.getElementById('mb-post-input') })`);
        assert.deepEqual(c, { value: '@QA Engineer ', focused: true });
        await ev(`(() => { const i = document.getElementById('mb-post-input'); i.value += 'thanks, noted'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#mb-board .mb-post-send-btn').click(); return true; })()`);
        await waitFor(`document.querySelectorAll('#mb-messages > .mb-message').length >= 7`, 'the reply row', 10000);
        const posted = await ev(`fetch('/api/board/${B}/messages/all?limit=20').then(r => r.json())`);
        const list = Array.isArray(posted) ? posted : (posted.messages || []);
        const mine = list.find(m => /thanks, noted/.test(m.content));
        assert.ok(mine && mine.reply_to, 'the post carries reply_to: ' + JSON.stringify(mine));
        assert.ok(await ev(`document.querySelectorAll('#mb-messages > .mb-message')[0].classList.contains('mb-open')`), 'the open row stayed open when a message arrived');

        console.log('6b. A Question that is answered says so on its collapsed row, without a reload (#8170)');
        const liveQ = await post('Lead Developer', '@Backend Dev is the live question answered yet?', { ask: true });
        const badgeOf = id => ev(`(() => { const r = document.querySelector('#mb-messages > .mb-message[data-message-id="${id}"]'); if (!r) return null; return { head: [...r.querySelectorAll(':scope > .mb-row-toggle .mb-ask-badge')].map(b => b.textContent.trim()), chat: [...r.querySelectorAll(':scope > .mb-message-header .mb-ask-badge')].map(b => b.textContent.trim()), open: r.classList.contains('mb-open') }; })()`);
        await waitFor(`!!document.querySelector('#mb-messages > .mb-message[data-message-id="${liveQ}"]')`, 'the live question', 25000);
        assert.deepEqual(await badgeOf(liveQ), { head: ['Question'], chat: ['Question'], open: false }, 'a Question nobody has answered');
        await post('Backend Dev', 'Yes, answered.', { reply_to: liveQ });
        await waitFor(`(() => { const r = document.querySelector('#mb-messages > .mb-message[data-message-id="${liveQ}"]'); return !!r && /answered/.test(r.querySelector(':scope > .mb-row-toggle .mb-ask-badge').textContent); })()`, 'the Question says it is answered', 25000);
        assert.deepEqual(await badgeOf(liveQ), { head: ['Question · answered'], chat: ['Question · answered'], open: false }, 'the collapsed row, and the chat header, say answered without a reload');
        console.log('   ✓');
        console.log('7. Copy link is the message\'s own address, and opening it lands on the message');
        const link = await ev(`(() => { let got = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { got = t; } } }); document.querySelectorAll('#mb-messages > .mb-message')[0].querySelectorAll('.mb-row-actions button').forEach(b => { if (b.textContent === 'Copy link') b.click(); }); return new Promise(r => setTimeout(() => r(got), 200)); })()`);
        const first = await ev(`document.querySelectorAll('#mb-messages > .mb-message')[0].dataset.messageId`);
        assert.ok(link.endsWith(`/team/${B}/board/${first}`), 'the link: ' + link);
        await open(1280, 800, false, 'dark', 'table', `/team/${B}/messages/${qid}`);
        await waitFor(`document.querySelector('#mb-messages > .mb-message[data-message-id="${qid}"].mb-open')`, 'the linked message opens', 10000);

        console.log('8. Chat view: the same rows, the table\'s head hidden; the choice is remembered');
        await ev(`[...document.querySelectorAll('.mb-view-btn')].find(b => b.textContent === 'Chat').click(); true`); await settle(300);
        const ch = await ev(`({ view: document.getElementById('mb-messages').dataset.view, head: ${ROWS}.some(r => r.querySelector(':scope > .mb-row-toggle').getClientRects().length), body: ${ROWS}.every(r => r.querySelector('.mb-message-body').getClientRects().length), stored: localStorage.getItem('coral.board.view') })`);
        assert.deepEqual(ch, { view: 'chat', head: false, body: true, stored: 'chat' });
        await shot('board-chat-1280-dark');
        await open(1400, 900, false, 'dark', 'chat');
        assert.equal(await ev(`document.getElementById('mb-messages').dataset.view`), 'chat', 'a reload keeps Chat');
        // The Table fills the pane (#8504); Chat keeps its reading width (#8553).
        // Require room beyond the cap so this cannot pass on a narrow column by accident.
        const chatWidth = await ev(`(() => {
            const feed = document.getElementById('mb-messages');
            return { table: feed.classList.contains('mb-table'), feed: Math.round(feed.getBoundingClientRect().width), column: Math.round(document.getElementById('mb-board').getBoundingClientRect().width) };
        })()`);
        assert.equal(chatWidth.table, false, 'the width check measures Chat, not Table');
        assert.ok(chatWidth.column > 840, 'at 1400 px the column leaves room to exercise the Chat cap: ' + JSON.stringify(chatWidth));
        assert.equal(chatWidth.feed, 840, 'Chat caps its feed at 840 px even when its column is wider');

        console.log('9. Light theme');
        await open(1280, 800, false, 'light', 'table');
        await ev(`document.querySelectorAll('#mb-messages > .mb-message')[1].querySelector('.mb-row-toggle').click(); true`); await settle(200);
        await shot('board-table-open-1280-light');

        console.log('10. Phone: one-line rows (the avatar is the sender), the tags with the open message, 44 px targets');
        for (const theme of ['dark', 'light']) {
            await open(390, 844, true, theme, 'table');
            const p = await ev(`(() => ({ rows: ${ROWS}.map(r => { const h = r.querySelector(':scope > .mb-row-toggle'), s = h.querySelector('.mb-row-snippet'), lh = parseFloat(getComputedStyle(s).lineHeight) || 16; return { h: Math.round(h.getBoundingClientRect().height), lines: Math.round(s.getBoundingClientRect().height / lh), tags: [...h.querySelectorAll('.mb-row-tags > *')].filter(x => x.getClientRects().length).length }; }), sideways: document.documentElement.scrollWidth > innerWidth + 1 }))()`);
            assert.ok(p.rows.every(r => r.h >= 44 && r.h <= 48 && r.lines <= 1 && r.tags <= 1), `${theme}: one line, 44 px, nothing on the folded row but an open question's dot: ` + JSON.stringify(p.rows));
            assert.equal(p.sideways, false, 'nothing scrolls sideways');
            const av = await ev(`${ROWS}.map(r => Math.round(r.querySelector('.mb-row-avatar').getBoundingClientRect().left))`);
            assert.equal(new Set(av).size, 1, `${theme}: the folded rows' avatars start at one edge: ` + JSON.stringify(av));
            await shot(`board-table-390-${theme}`);
            await ev(`document.querySelectorAll('#mb-messages > .mb-message')[1].querySelector('.mb-row-toggle').click(); true`); await settle(250);
            const q = await ev(`(() => { const r = document.querySelectorAll('#mb-messages > .mb-message')[1]; return { tagsOpen: r.querySelector(':scope > .mb-row-tags-open') && r.querySelector(':scope > .mb-row-tags-open').getClientRects().length > 0, buttons: [...r.querySelectorAll('.mb-row-actions button, .mb-row-reply')].map(b => Math.round(b.getBoundingClientRect().height)), wide: Math.round(r.querySelector('.mb-message-body').getBoundingClientRect().width) }; })()`);
            assert.ok(q.tagsOpen && q.buttons.length >= 4 && q.buttons.every(h => h >= 44), `${theme}: the tags are with the open message and its buttons are 44 px: ` + JSON.stringify(q));
            await shot(`board-table-open-390-${theme}`);
            // The open row's tags are not under the sticky day line: a row opened while its top is scrolled under the line is brought into view with 8 px or more below the line.
            await ev(`document.querySelectorAll('#mb-messages > .mb-message')[1].querySelector('.mb-row-toggle').click(); true`); await settle(200);
            await ev(`(() => { const box = document.getElementById('mb-messages'), r = document.querySelectorAll('#mb-messages > .mb-message')[1]; box.scrollTop = r.offsetTop - box.offsetTop + 12; return true; })()`); await settle(200);
            await ev(`document.querySelectorAll('#mb-messages > .mb-message')[1].querySelector('.mb-row-toggle').click(); true`); await settle(300);
            const under = await ev(`(() => { const r = document.querySelectorAll('#mb-messages > .mb-message')[1], d = document.querySelector('#mb-messages > .mb-day').getBoundingClientRect(); return { open: r.classList.contains('mb-open'), gap: Math.round(r.getBoundingClientRect().top - d.bottom) }; })()`);
            assert.ok(under.open && under.gap >= 8, `${theme}: the opened row starts 8 px or more below the day line: ` + JSON.stringify(under));
            await shot(`board-table-open-below-day-390-${theme}`);
        }
        console.log('PASS the Board as a table');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(err => { console.error(err); process.exit(1); });
