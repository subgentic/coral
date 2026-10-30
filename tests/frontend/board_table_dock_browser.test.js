// The agent dock's Board tab is the same table as the team page's (#7922, goal #33): the shared module at dock width. Its rows are always the folded two lines (the tags are inside the open message, not
// squeezed against the snippet), a row opens in place with Reply and Copy link (the dock has no Save or Delete, so no More), the Table | Chat switch is in the tab's head line and is the team page's
// remembered choice, Reply fills the box and posts with reply_to, Copy link is the message's own address. At the default dock width, the narrowest, and a phone; dark and light. Real board over the API.
// Drives Chrome over CDP through agent_view_harness.js against the isolated dev server; with CORAL_SCREENSHOT_DIR set it also saves a picture of each.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const B = 'dock-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const post = async (who, content, extra = {}) => { const r = await api('POST', `/api/board/${B}/messages`, { subscriber_id: who, content, ...extra }); assert.equal(r.status, 200, JSON.stringify(r)); return r.body.id || (r.body.message && r.body.message.id); };
    const ROWS = `[...document.querySelectorAll('#board-panel-msgs > .mb-message')]`;
    const open = async (w, h, mobile, theme, view, dockPx) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        await ev(`(async () => { const st = window.__coralStatic || '/static/'; const sc = await import(st + 'settings_core.js'); sc.clearCustomThemeVars(); sc.applyTheme(${JSON.stringify(theme)}); try { localStorage.setItem('coral.board.view', ${JSON.stringify(view)}); } catch {}
            const agentView = document.getElementById('live-session-view'); if (agentView) agentView.style.display = '';
            let p = document.getElementById('agentic-panel-board'); if (!p) { p = document.createElement('div'); p.id = 'agentic-panel-board'; document.body.appendChild(p); }
            document.body.appendChild(p); p.classList.add('active'); p.hidden = false; p.style.cssText = 'display:flex;flex-direction:column;position:fixed;top:0;right:0;bottom:0;width:${dockPx}px;z-index:50;background:var(--bg-primary)';
            const m = await import(st + 'render.js'); m.showBoardChatTab(${JSON.stringify(B)}); return true; })()`);
        await waitFor(`document.querySelectorAll('#board-panel-msgs > .mb-message').length >= 6`, 'the dock rows', 15000);
        await settle(400);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        for (const [id, t] of [['Orchestrator', 'Orchestrator'], ['QA Engineer', 'QA Engineer'], ['Backend Dev', 'Backend Dev'], ['Lead Developer', 'Lead Developer']]) assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: t, session_name: id + '-s' })).status, 200);
        const firstId = await post('QA Engineer', 'Review of the Inbox patch: approved with two small follow-ups for the empty states. @Orchestrator #7740');
        const qid = await post('Lead Developer', 'Question for @Backend Dev: should group posts reach members, or only the ones they tag?\n\n- the read includes the group\'s posts\n- group posts stay tagged-only\n\n#7757', { ask: true });
        await post('Backend Dev', 'Agreed with the second; the count already follows the read.', { reply_to: qid });
        await post('Orchestrator', 'Fine. @Operator please look at the plan: ' + 'a long line that goes on and on, '.repeat(6) + '#7809');
        await post('Backend Dev', 'Summary posted. #7809');
        await post('Lead Developer', '@Backend Dev @QA Engineer @Orchestrator six marks in one message #7790', { ask: true, reply_to: firstId }); // a reply, three mentions, a task and a question: six marks

        for (const [label, w, h, mobile, dock] of [['default dock width', 1280, 800, false, 420], ['narrowest dock', 1280, 800, false, 280], ['phone', 390, 844, true, 390]]) {
            console.log(`${label}: the dock's Board tab is the table, folded`);
            await open(w, h, mobile, 'dark', 'table', dock);
            const t = await ev(`(() => { const box = document.getElementById('board-panel-msgs'); const rows = ${ROWS}.map(r => { const h = r.querySelector(':scope > .mb-row-toggle'), s = h.querySelector('.mb-row-snippet'), lh = parseFloat(getComputedStyle(s).lineHeight) || 16; return { h: Math.round(h.getBoundingClientRect().height), lines: Math.round(s.getBoundingClientRect().height / lh), tags: [...h.querySelectorAll('.mb-row-tags > *')].filter(x => x.getClientRects().length).length, body: r.querySelector('.mb-message-body').getClientRects().length > 0 }; }); const head = document.querySelector('.board-chat-header'); return { fold: box.classList.contains('mb-fold'), table: box.classList.contains('mb-table'), rows, day: !!box.querySelector(':scope > .mb-day'), sw: [...head.querySelectorAll('.mb-view-btn')].map(b => b.textContent + ':' + b.getAttribute('aria-pressed')), inHead: !!head.querySelector(':scope > .mb-table-tools'), sideways: box.scrollWidth > box.clientWidth + 1, pills: !!document.querySelector('#agentic-panel-board .mb-pill') }; })()`);
            assert.ok(t.table && t.fold, 'the dock draws the table, folded'); assert.equal(t.rows.length, 6);
            assert.ok(t.rows.every(r => r.h >= 44 && r.h <= 48 && r.lines <= 1 && r.tags <= 1 && !r.body), `${label}: one line, nothing on the folded row but an open question's dot: ` + JSON.stringify(t.rows));
            assert.ok(t.day && t.inHead && !t.pills && t.sw.join() === 'Table:true,Chat:false' && !t.sideways, `${label}: day line, the switch in the head line, no pills, nothing sideways: ` + JSON.stringify(t));
            await shot(`dock-table-${label.replace(/ /g, '-')}-dark`);
        }

        console.log('An open row: the tags are inside it, Reply and Copy link, no More');
        await open(1280, 800, false, 'dark', 'table', 420);
        await ev(`document.querySelectorAll('#board-panel-msgs > .mb-message')[1].querySelector('.mb-row-toggle').click(); true`); await settle(250);
        const o = await ev(`(() => { const r = document.querySelectorAll('#board-panel-msgs > .mb-message')[1]; return { exp: r.querySelector('.mb-row-toggle').getAttribute('aria-expanded'), tags: r.querySelector(':scope > .mb-row-tags-open').getClientRects().length > 0, body: r.querySelector('.mb-message-body').getClientRects().length > 0, controls: r.querySelector('.mb-row-toggle').getAttribute('aria-controls') === r.querySelector('.mb-message-body').id, buttons: [...r.querySelectorAll('.mb-row-actions button')].map(b => b.textContent + ':' + Math.round(b.getBoundingClientRect().height)), replies: r.querySelector('.mb-row-replies').textContent }; })()`);
        assert.equal(o.exp, 'true'); assert.ok(o.tags && o.body && o.controls, JSON.stringify(o));
        assert.deepEqual(o.buttons.map(b => b.split(':')[0]), ['Open task #7757', 'Reply', 'Copy link']); assert.ok(o.buttons.every(b => +b.split(':')[1] >= 44), 'folded buttons are 44 px: ' + o.buttons);
        assert.ok(/Replies \(1\)/.test(o.replies));
        await shot('dock-table-open-default-dark');

        console.log('Six marks: the open message in the dock shows every one');
        await ev(`document.querySelectorAll('#board-panel-msgs > .mb-message')[5].querySelector('.mb-row-toggle').click(); true`); await settle(250);
        assert.deepEqual(await ev(`[...document.querySelectorAll('#board-panel-msgs > .mb-message')[5].querySelectorAll(':scope > .mb-row-tags-open > *')].map(c => c.textContent.trim())`), ['Reply to QA Engineer', '@Backend Dev', '@QA Engineer', '@Orchestrator', '#7790', 'Question'], 'all six marks inside the open dock row');
        await ev(`document.querySelectorAll('#board-panel-msgs > .mb-message')[5].querySelector('.mb-row-toggle').click(); true`); await settle(150);
        console.log('Chat view: the same rows, the head hidden; the choice is the page\'s');
        await ev(`[...document.querySelectorAll('.board-chat-header .mb-view-btn')].find(b => b.textContent === 'Chat').click(); true`); await settle(300);
        assert.deepEqual(await ev(`({ view: document.getElementById('board-panel-msgs').dataset.view, head: ${ROWS}.some(r => r.querySelector(':scope > .mb-row-toggle').getClientRects().length), body: ${ROWS}.every(r => r.querySelector('.mb-message-body').getClientRects().length), stored: localStorage.getItem('coral.board.view') })`), { view: 'chat', head: false, body: true, stored: 'chat' });
        await shot('dock-chat-default-dark');
        await ev(`[...document.querySelectorAll('.board-chat-header .mb-view-btn')].find(b => b.textContent === 'Table').click(); true`); await settle(300);

        console.log('Reply fills the box and posts reply_to; Copy link is the message\'s address');
        await ev(`document.querySelectorAll('#board-panel-msgs > .mb-message')[0].querySelector('.mb-row-toggle').click(); true`); await settle(200);
        await ev(`document.querySelectorAll('#board-panel-msgs > .mb-message')[0].querySelector('.mb-row-actions').querySelectorAll('button').forEach(b => { if (b.textContent === 'Reply') b.click(); }); true`); await settle(150);
        assert.deepEqual(await ev(`({ v: document.getElementById('board-panel-input').value, f: document.activeElement === document.getElementById('board-panel-input') })`), { v: '@QA Engineer ', f: true });
        const link = await ev(`(() => { let got = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { got = t; } } }); document.querySelectorAll('#board-panel-msgs > .mb-message')[0].querySelectorAll('.mb-row-actions button').forEach(b => { if (b.textContent === 'Copy link') b.click(); }); return new Promise(r => setTimeout(() => r(got), 200)); })()`);
        const first = await ev(`document.querySelectorAll('#board-panel-msgs > .mb-message')[0].dataset.messageId`);
        assert.ok(link.endsWith(`/team/${B}/board/${first}`), 'the link: ' + link);
        await ev(`(() => { const i = document.getElementById('board-panel-input'); i.value += 'thanks'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#agentic-panel-board .btn-send').click(); return true; })()`);
        await waitFor(`document.querySelectorAll('#board-panel-msgs > .mb-message').length >= 7`, 'the reply row', 10000);
        const list = await ev(`fetch('/api/board/${B}/messages/all?limit=20').then(r => r.json())`);
        const mine = (Array.isArray(list) ? list : list.messages || []).find(m => /thanks/.test(m.content));
        assert.ok(mine && mine.reply_to, 'the post carries reply_to: ' + JSON.stringify(mine));
        assert.ok(await ev(`document.querySelectorAll('#board-panel-msgs > .mb-message')[0].classList.contains('mb-open')`), 'the open row stayed open when the list was drawn again');

        console.log('Light theme, default dock');
        await open(1280, 800, false, 'light', 'table', 420);
        await ev(`document.querySelectorAll('#board-panel-msgs > .mb-message')[1].querySelector('.mb-row-toggle').click(); true`); await settle(250);
        await shot('dock-table-open-default-light');
        await open(390, 844, true, 'light', 'table', 390);
        await shot('dock-table-phone-light');
        console.log('PASS the dock\'s Board tab as a table');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(err => { console.error(err); process.exit(1); });
