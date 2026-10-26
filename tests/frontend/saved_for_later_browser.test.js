// Save for Later (#4510): a bookmark button on each message of an agent's Chat view (next to Copy), filled when saved, with an accessible name and aria-pressed;
// the Saved tab of the right sidebar, opened by the top bar's button (Open and Done, newest saved first, Done, Remove); clicking an item opens that agent and pages up to the message, which is
// marked and focused; a message that is gone is said so, with its snippet kept. The bookmarks are the real server's (/api/saved, the isolated test server's
// database); the agent and its transcript are the harness's, with each message's key added the way the server adds it.
//
// Drives Chrome over CDP through agent_view_harness.js; run_cdp_suites.mjs finds CDP suites by that name.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');

const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const { assertPinnedBar } = require('./helpers/pinned_bar');
const hex = i => i.toString(16).padStart(20, '0');

(async () => {
    const { client, Page, Emulation, Input, ev, waitFor, sleep, PRELOAD, install, select } = await connect();
    const shot = async (name) => {
        if (!process.env.CORAL_SCREENSHOT_DIR) return;
        await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); true`);
        fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    };
    const key = async (k, code, vk) => { for (const type of ['keyDown', 'keyUp']) await client.Input.dispatchKeyEvent({ type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(type === 'keyDown' && k === 'Enter' ? { text: '\r' } : {}) }); };
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const saved = async (q = '') => (await api('GET', '/api/saved' + q)).body;
    const C = `document.getElementById('live-history-messages')`;
    const ROWS = '#saved-table tbody tr'; // the dock's Saved tab is the Inbox's Saved table, filtered to the page's scope (#7631)
    const rowWith = text => `[...document.querySelectorAll('${ROWS}')].find(tr => tr.textContent.includes(${JSON.stringify(text)}))`;
    const INBOX_SAVED = `(() => { const t = document.getElementById('group-table-view'); return t.getClientRects().length > 0 && t.dataset.group === 'hub-inbox:saved'; })()`;
    // The Saved tab of the right sidebar is shown: its panel is the active one and the sidebar is not collapsed.
    const TAB_OPEN = `(() => { const p = document.getElementById('agentic-panel-saved'), a = document.getElementById('agentic-state'); return p.classList.contains('active') && getComputedStyle(p).display !== 'none' && !a.classList.contains('collapsed') && p.getBoundingClientRect().width > 0; })()`;

    // The server adds "key" to each chat message (the harness's mock does not): a key from the message's absolute index, and ?find_key= answered from it.
    const MOCK = `(() => {
        const prev = window.fetch;
        window.fetch = async (url, opts = {}) => {
            const u = String(url);
            // The real server marks a bookmark whose transcript it cannot read (#5802), and the harness's agents have none on disk: the marks are what the mock transcripts say.
            if (/^\\/api\\/saved(\\?.*)?$/.test(u) && (opts.method || 'GET').toUpperCase() === 'GET') {
                const resp = await prev(url, opts);
                const body = await resp.clone().json().catch(() => null);
                if (!body || !Array.isArray(body.items)) return resp;
                body.items = body.items.map(it => {
                    if (it.kind !== 'agent') return it;
                    if (it.ref === 'dead0000-0000-4000-8000-000000000002') return { ...it, reason: 'not_reachable' }; // the agent with no transcript (7c)
                    const idx = parseInt(it.key, 16);
                    let total = it.ref === 'dead0000-0000-4000-8000-000000000001' ? 150 : 0; // the ended agent's mock history (7c)
                    if (!total) { try { total = window.__m.byPathSeg(it.title).msgs.length; } catch (e) { total = 0; } }
                    return { ...it, reason: idx >= 0 && idx < total ? '' : 'gone' };
                });
                return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            const m = u.match(/\\/api\\/sessions\\/live\\/([^/?]+)\\/chat\\?(.*)$/);
            if (!m) return prev(url, opts);
            const p = new URLSearchParams(m[2]);
            const total = window.__m.byPathSeg(m[1]).msgs.length;
            if (p.has('find_key')) {
                const k = p.get('find_key'); const idx = /^[0-9a-f]{20}$/.test(k) ? parseInt(k, 16) : -1;
                return new Response(JSON.stringify({ found: idx >= 0 && idx < total, index: Math.max(idx, 0), total }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            const resp = await prev(url, opts);
            const body = await resp.clone().json().catch(() => null);
            if (!body || !body.messages) return resp;
            const start = Number.isInteger(body.start) ? body.start : (Number(p.get('after') || 0));
            body.messages = body.messages.map((x, i) => ({ ...x, key: (start + i).toString(16).padStart(20, '0') }));
            return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        };
    })()`;
    const btnState = idx => ev(`(() => { const b = ${C}.querySelector('[data-msg-key="${hex(idx)}"] .chat-save-btn'); return b ? { pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label'), hidden: b.hidden } : null; })()`);

    let BOARD = ''; // the board this suite makes, taken away again in the finally (#4959)
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE });
        await Page.loadEventFired();
        await install();
        await ev(`localStorage.clear(); localStorage.setItem('coral-live-view-mode', 'chat')`);
        await ev(MOCK);
        // A clean slate: whatever an earlier suite of this shard saved is removed.
        for (const it of (await saved()).items) await api('DELETE', `/api/saved/${it.id}`);
        await ev(`(() => { window.__m.add('sv-a', 'S', 260, { sleeping: false }); T.render.renderLiveSessions(T.state.liveSessions); })()`);
        await select('sv-a');
        await waitFor(`${C}.querySelectorAll('[data-msg-key]').length > 20`, 'the newest page', 8000);

        console.log('1. A bookmark button on each message, with its name and state');
        const first = await ev(`(() => { const bs = [...${C}.querySelectorAll('[data-msg-key]')]; const k = bs[bs.length - 1].dataset.msgKey; return { n: bs.length, k, human: !!${C}.querySelector('.chat-bubble.human .chat-save-btn'), assistant: !!${C}.querySelector('.chat-bubble.assistant .chat-save-btn'), copyAlso: !!${C}.querySelector('.chat-bubble.assistant .chat-copy-btn') }; })()`);
        assert.ok(first.human && first.assistant && first.copyAlso, 'on your messages and the agent\'s, beside Copy: ' + JSON.stringify(first));
        const lastIdx = parseInt(first.k, 16);
        let st = await btnState(lastIdx);
        assert.deepEqual({ ...st, label: st.label.split(':')[0] }, { pressed: 'false', label: 'Save for later', hidden: false }); // the name goes on with the message it is on

        console.log('2. Saving by the keyboard (a real Enter on the focused button): filled, named "Remove from saved", on the server');
        await ev(`${C}.querySelector('[data-msg-key="${hex(lastIdx)}"] .chat-save-btn').focus(); true`);
        await key('Enter', 'Enter', 13);
        await waitFor(`${C}.querySelector('[data-msg-key="${hex(lastIdx)}"] .chat-save-btn').getAttribute('aria-pressed') === 'true'`, 'the button to show saved', 6000);
        st = await btnState(lastIdx);
        assert.deepEqual({ ...st, label: st.label.split(':')[0] }, { pressed: 'true', label: 'Remove from saved', hidden: false });
        assert.equal(await ev(`document.activeElement.classList.contains('chat-save-btn')`), true, 'the focus stays on the button');
        const toast1 = await ev(`(() => { const t = document.querySelector('.toast'); return t ? { text: t.querySelector('.toast-message').textContent, action: (t.querySelector('.toast-action') || {}).textContent } : null; })()`);
        assert.deepEqual(toast1, { text: 'Saved.', action: 'View saved' }, 'a toast says so and offers the list');
        assert.equal(await ev(`!!${C}.querySelector('[data-msg-key="${hex(lastIdx)}"] .chat-save-btn svg') && !${C}.querySelector('[data-msg-key="${hex(lastIdx)}"] .chat-save-btn .material-icons')`), true, 'the bookmark is an inline SVG');
        await waitFor(`document.querySelector('#saved-btn .saved-count').textContent === '1'`, 'the top bar count', 6000);
        let list = await saved();
        assert.equal(list.items.length, 1); assert.equal(list.items[0].kind, 'agent'); assert.equal(list.items[0].key, hex(lastIdx));
        assert.match(list.items[0].snippet, /^[SU]?\d*|lorem/); assert.ok(list.items[0].title, 'the agent\'s name is kept');
        // A redraw keeps the state (the page of messages is drawn again from the cache).
        await select('sv-a');
        await waitFor(`${C}.querySelector('[data-msg-key="${hex(lastIdx)}"] .chat-save-btn')?.getAttribute('aria-pressed') === 'true'`, 'the state after a redraw', 6000);
        console.log('   ✓');

        console.log('2b. Removing says so with Undo; Undo saves it again; the "View saved" toast opens the list');
        const sb = `${C}.querySelector('[data-msg-key="${hex(lastIdx)}"] .chat-save-btn')`;
        await ev(`${sb}.click(); true`);
        await waitFor(`${sb}.getAttribute('aria-pressed') === 'false'`, 'the bookmark to be removed', 6000);
        await waitFor(`[...document.querySelectorAll('.toast')].some(t => t.querySelector('.toast-message').textContent === 'Removed from saved.' && (t.querySelector('.toast-action') || {}).textContent === 'Undo')`, 'the Removed toast with Undo', 4000);
        assert.equal((await saved()).items.length, 0, 'removed on the server');
        await waitFor(`document.querySelector('#saved-btn .saved-count').hidden === true`, 'the count to go', 6000);
        await ev(`[...document.querySelectorAll('.toast')].find(t => t.querySelector('.toast-action').textContent === 'Undo').querySelector('.toast-action').click(); true`);
        await waitFor(`${sb}.getAttribute('aria-pressed') === 'true'`, 'Undo to save it again', 6000);
        assert.equal((await saved()).items.length, 1, 'saved again on the server'); assert.equal((await saved()).items[0].key, hex(lastIdx));
        await ev(`${sb}.click(); true`);
        await waitFor(`${sb}.getAttribute('aria-pressed') === 'false'`, 'removed again', 6000);
        await ev(`${sb}.click(); true`);
        await waitFor(`[...document.querySelectorAll('.toast')].some(t => (t.querySelector('.toast-action') || {}).textContent === 'View saved')`, 'the Saved toast with View saved', 6000);
        await ev(`[...document.querySelectorAll('.toast')].find(t => (t.querySelector('.toast-action') || {}).textContent === 'View saved').querySelector('.toast-action').click(); true`);
        await waitFor(TAB_OPEN, 'View saved to open the list', 6000);
        console.log('   ✓');

        console.log('3. An old message saved, then the Saved tab of the right sidebar from the top bar');
        // Page up to an old message and save it by its button.
        const OLD = 12;
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'live_chat.js'); return m.jumpToLiveMessage(${JSON.stringify(hex(OLD))}, ${OLD}); })()`);
        await waitFor(`!!${C}.querySelector('[data-msg-key="${hex(OLD)}"] .chat-save-btn')`, 'the old message', 8000);
        await ev(`${C}.querySelector('[data-msg-key="${hex(OLD)}"] .chat-save-btn').click(); true`);
        await waitFor(`${C}.querySelector('[data-msg-key="${hex(OLD)}"] .chat-save-btn').getAttribute('aria-pressed') === 'true'`, 'the old message saved', 6000);
        list = await saved();
        assert.equal(list.items.length, 2); assert.equal(list.items[0].key, hex(OLD), 'newest saved first');
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'saved.js'); await m.openSaved(); return true; })()`); // the page's own Saved tab; the top bar's bookmark is the Inbox's (#4905)
        await waitFor(`${TAB_OPEN} && document.querySelectorAll('${ROWS}').length === 2`, 'the Saved tab with two items', 6000)
            .catch(async e => { throw new Error(`${e.message} | ${JSON.stringify(await ev(`({ open: ${TAB_OPEN}, rows: document.querySelectorAll('${ROWS}').length, text: (document.getElementById('saved-table') || {}).textContent?.slice(0, 160) })`))}`); }); // what the tab showed when it gave up (#7955)
        await waitFor(`document.getElementById('agentic-panel-saved').contains(document.activeElement)`, 'the focus to move into the Saved tab', 6000);
        assert.equal(await ev(`document.querySelector('#saved-table .dt-sortbar').hidden`), true, 'the existing Saved sort control is the only sort bar');
        const dlg = await ev(`(() => { const rows = [...document.querySelectorAll('${ROWS}')]; return { first: rows[0].querySelector('.dt-primary').textContent, saved: rows[0].cells[1].textContent.trim(), state: rows[0].cells[2].textContent.trim(), pressed: [...document.querySelectorAll('#saved-table .group-chip')].map(c => c.getAttribute('aria-pressed')), counts: [...document.querySelectorAll('#saved-table .group-chip-count')].map(c => c.textContent), inside: !!document.activeElement.closest('#agentic-panel-saved') }; })()`);
        assert.match(dlg.first, /^sv-a, /, 'the row is named by its source and its text'); assert.equal(dlg.state, 'Open'); assert.match(dlg.saved, /ago|now/); assert.deepEqual(dlg.pressed, ['true', 'false'], 'Open is the chip on'); assert.deepEqual(dlg.counts, ['2', '0']); assert.ok(dlg.inside, 'the focus is inside the tab');
        // The table is built detached, initially using the desktop viewport's width.
        // Its ResizeObserver folds it for the dock's narrow box on the next layout.
        await waitFor(`!!document.querySelector('#saved-table .dt-box.dt-folded')`, 'the Saved table to fold for its dock width', 6000,
            `(() => { const box = document.querySelector('#saved-table .dt-box'), b = document.querySelector('#saved-table button.dt-quiet'); return { boxClass: box?.className, boxWidth: box?.clientWidth, viewport: innerWidth, coarse: matchMedia('(pointer: coarse)').matches, minHeight: b && getComputedStyle(b).minHeight, height: b?.getBoundingClientRect().height }; })()`);
        console.log('Saved action after fold:', await ev(`(() => { const b = document.querySelector('#saved-table button.dt-quiet'), s = getComputedStyle(b); return { height: b.getBoundingClientRect().height, minHeight: s.minHeight, transition: s.transition, animations: b.getAnimations().map(a => ({ property: a.transitionProperty, state: a.playState })) }; })()`));
        // The inherited button transition includes min-height; folding starts its 32 -> 28px transition.
        await waitFor(`Math.round(document.querySelector('#saved-table button.dt-quiet').getBoundingClientRect().height) === 28`, 'the folded Saved action height to settle', 6000);
        assert.equal(await ev(`Math.round(document.querySelector('#saved-table button.dt-quiet').getBoundingClientRect().height)`), 28, 'fine-pointer secondary actions use the compact shared height');
        await shot('saved-tab-desktop');

        console.log('4. Done moves an item to the Done chip; it can be opened again');
        await ev(`document.querySelector('#saved-table .dt-quiet').click(); true`);
        await waitFor(`document.querySelectorAll('${ROWS}').length === 1 && [...document.querySelectorAll('#saved-table .group-chip-count')].map(c => c.textContent).join() === '1,1'`, 'the item to leave Open', 6000);
        await ev(`document.querySelectorAll('#saved-table .group-chip')[1].click(); true`);
        await waitFor(`document.querySelectorAll('${ROWS}').length === 1 && document.querySelector('#saved-table .dt-quiet').textContent === 'Reopen'`, 'the Done chip', 6000);
        await ev(`document.querySelector('#saved-table .dt-quiet').click(); true`);
        await waitFor(`document.querySelectorAll('${ROWS}').length === 0`, 'Reopen to bring it back', 6000);
        await ev(`document.querySelectorAll('#saved-table .group-chip')[0].click(); true`);
        await waitFor(`document.querySelectorAll('${ROWS}').length === 2`, 'both open again', 6000);
        console.log('   \u2713');

        console.log('5. Click a row: the message opens as a sheet over the dock (the person stays with the agent), Back returns to the table with the focus on the row, Open goes to the chat, pages up to the message, which is marked and has the focus');
        await select('sv-a'); // the newest page again: the old message is not on screen
        await waitFor(`!${C}.querySelector('[data-msg-key="${hex(OLD)}"]')`, 'the old message to be off screen', 6000);
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'saved.js'); await m.openSaved(); return true; })()`); // the page's own Saved tab; the top bar's bookmark is the Inbox's (#4905)
        await waitFor(`document.querySelectorAll('${ROWS}').length === 2`, 'the Saved tab', 6000);
        const SHEET = '#agentic-saved-detail-pane';
        await ev(`document.querySelector('#saved-table .dt-primary[data-id="local:${list.items[0].id}"]').click(); true`);
        await waitFor(`!!document.querySelector('${SHEET} .detail-foot .btn-primary')`, 'the message as a sheet over the dock, with its Open button', 8000);
        assert.equal(await ev(`!!document.querySelector('#group-table-view:not([hidden])') && getComputedStyle(document.getElementById('group-table-view')).display !== 'none'`), false, 'the person is not sent to the Inbox');
        const sheet = await ev(`(() => { const s = document.querySelector('${SHEET}'), p = document.getElementById('agentic-panel-saved'); const r = s.getBoundingClientRect(), q = p.getBoundingClientRect(); return { covers: Math.abs(r.top - q.top) < 2 && Math.abs(r.bottom - q.bottom) < 2 && Math.abs(r.left - q.left) < 2 && Math.abs(r.right - q.right) < 2, title: s.querySelector('.detail-title').textContent, snippet: s.querySelector('.inbox-saved-snippet').textContent, foot: [...s.querySelectorAll('.detail-foot .btn')].map(b => b.textContent), focus: document.activeElement === s.querySelector('.detail-title') }; })()`);
        assert.ok(sheet.covers, 'the sheet is over the dock panel'); assert.ok(sheet.snippet.length > 0 && sheet.title.length > 0); assert.equal(sheet.foot.length, 2); assert.deepEqual(sheet.foot, ['Remove from saved', 'Open chat'], 'the bar\'s one order (#7684): Remove, then the primary, Open chat, last'); assert.ok(sheet.focus, 'the keyboard starts at its heading');
        await waitFor(`!!document.querySelector('${SHEET} .ibx-saved-body .md, ${SHEET} .ibx-saved-body .ibx-why')`, 'the whole text in the sheet, read at once', 6000);
        assert.equal(await ev(`!!document.querySelector('${SHEET} .ibx-saved-toggle')`), false, 'no Read the whole message button: the text is there');
        await assertPinnedBar(ev, `${SHEET} .detail-foot`, 'the Saved sheet');
        await shot('saved-sheet-desktop');
        await ev(`document.querySelector('${SHEET} .group-back').click(); true`);
        await waitFor(`document.querySelector('${SHEET}').hidden && document.activeElement && document.activeElement.classList.contains('dt-primary') && document.activeElement.dataset.id === 'local:${list.items[0].id}'`, 'Back to bring the table back with the focus on the row', 4000);
        await ev(`document.querySelector('#saved-table .dt-primary[data-id="local:${list.items[0].id}"]').click(); true`);
        await waitFor(`!!document.querySelector('${SHEET} .detail-foot .btn-primary')`, 'the sheet again', 8000);
        await key('Escape', 'Escape', 27);
        await waitFor(`document.querySelector('${SHEET}').hidden`, 'Escape to close the sheet', 4000);
        await ev(`document.querySelector('#saved-table .dt-primary[data-id="local:${list.items[0].id}"]').click(); true`);
        await waitFor(`!!document.querySelector('${SHEET} .detail-foot .btn-primary')`, 'the sheet a third time', 8000);
        await ev(`document.querySelector('${SHEET} .detail-foot .btn-primary').click(); true`);
        await waitFor(`!!${C}.querySelector('[data-msg-key="${hex(OLD)}"].chat-search-target')`, 'the jump to the old message', 12000);
        const at = await ev(`(() => { const t = ${C}.querySelector('[data-msg-key="${hex(OLD)}"]'); const r = t.getBoundingClientRect(), c = ${C}.getBoundingClientRect(); return { focused: document.activeElement === t, visible: r.top >= c.top - 1 && r.bottom <= c.bottom + 1 }; })()`);
        assert.ok(at.focused, 'the focus is on the message'); assert.ok(at.visible, 'the message is in view');
        await waitFor(`!!document.getElementById('saved-jumpbar') && !!${C}.querySelector('[data-msg-key="${hex(OLD)}"].saved-jump')`, 'the jump bar and the Saved tag on the message', 6000);
        assert.equal(await ev(`document.querySelector('#saved-jumpbar .btn').textContent`), 'Back to Saved', 'a way back to the list');
        await shot('saved-jump-desktop');
        await ev(`document.querySelector('#saved-jumpbar .btn').click(); true`);
        await waitFor(`${TAB_OPEN} && !document.getElementById('saved-jumpbar')`, 'Back to Saved to bring the agent\'s Saved tab back (the jump began in the dock)', 6000);
        console.log('   \u2713');

        console.log('6. A message that is gone: its row says Gone, its page says why and can only remove it');
        const gone = await api('POST', '/api/saved', { kind: 'agent', ref: list.items[0].ref, key: hex(9999), agent_type: 'claude', title: 'sv-a', snippet: 'A message the transcript no longer has', said_at: '2026-10-17T08:00:00Z' });
        assert.equal(gone.status, 200);
        await select('sv-a');
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'saved.js'); await m.openSaved(); return true; })()`); // the page's own Saved tab; the top bar's bookmark is the Inbox's (#4905)
        await waitFor(`document.querySelectorAll('${ROWS}').length === 3`, 'three items', 6000);
        await waitFor(`!!${rowWith('no longer has')} && ${rowWith('no longer has')}.cells[2].textContent.trim() === 'Gone'`, 'the gone message to be found when the list opens', 8000);
        assert.equal(await ev(`${rowWith('no longer has')}.querySelectorAll('.dt-quiet').length`), 0, 'a gone row has no Done button');
        const heights = await ev(`[...document.querySelectorAll('${ROWS}')].map(r => Math.round(r.getBoundingClientRect().height))`);
        assert.ok(Math.max(...heights) - Math.min(...heights) <= 1, 'Open and Gone folded rows have equal height: ' + heights);
        // #5802: the list's own answer marks the gone ones, so opening the tab asks nothing per bookmark (QA's #5796: it was one request per row, up to 200)
        const seen = await ev(`(async () => { const prev = window.fetch; const urls = []; window.fetch = (u, o) => { urls.push(String(u)); return prev(u, o); }; try { const m = await import((window.__coralStatic || '/static/') + 'saved.js'); await m.openSaved(); await new Promise(r => setTimeout(r, 800)); } finally { window.fetch = prev; } return urls; })()`); // sleep-ok: a negative check: for 800 ms after the list opens nothing else is asked
        assert.equal(seen.filter(u => /\/api\/saved(\?|$)/.test(u)).length, 1, 'the list is read once: ' + JSON.stringify(seen));
        assert.deepEqual(seen.filter(u => /messages\/all\?|find_key=|\/api\/sessions\/history\//.test(u)), [], 'no request per bookmark');
        await shot('saved-gone-desktop');
        await ev(`${rowWith('no longer has')}.querySelector('.dt-primary').click(); true`);
        await waitFor(`!!document.querySelector('#agentic-saved-detail-pane .inbox-saved-why')`, 'the gone message\'s sheet', 8000);
        const g = await ev(`(() => ({ why: document.querySelector('#agentic-saved-detail-pane .inbox-saved-why').textContent, snippet: document.querySelector('#agentic-saved-detail-pane .inbox-saved-snippet').textContent, bar: [...document.querySelectorAll('#agentic-saved-detail-pane .detail-foot .btn')].map(b => b.textContent) }))()`);
        assert.equal(await ev(`getComputedStyle(document.querySelector('#agentic-saved-detail-pane .inbox-saved-why')).fontSize`), '13px', 'the reason line is at the normal hint size, not 11 px grey (UI/UX, #7660)');
        assert.match(g.why, /no longer has this message|transcript is gone/); assert.match(g.snippet, /no longer has/); assert.deepEqual(g.bar, ['Remove from saved'], 'a gone message cannot be opened: only Remove is in the bar');
        await ev(`document.querySelector('#agentic-saved-detail-pane .detail-foot .btn').click(); true`);
        await waitFor(`document.getElementById('agentic-saved-detail-pane').hidden && document.querySelectorAll('${ROWS}').length === 2`, 'the gone item removed, back at the dock table', 6000);
        console.log('   \u2713');

        console.log('7. The tab works with the keyboard: Enter on its tab shows it; the top bar button opens the Inbox with the focus inside; the link in the toast opens the sidebar on it');
        await select('sv-a'); // back on the agent's page (the gone message was removed from the Inbox's page)
        await ev(`(() => { const a = document.getElementById('agentic-state'); if (a.classList.contains('collapsed')) window.toggleAgenticPanel(true); return true; })()`);
        await ev(`document.getElementById('agentic-tab-files').click(); true`);
        await waitFor(`!document.getElementById('agentic-panel-saved').classList.contains('active')`, 'another tab to be shown', 4000);
        await ev(`document.getElementById('agentic-tab-saved').focus(); true`);
        await key('Enter', 'Enter', 13);
        await waitFor(TAB_OPEN, 'Enter on the Saved tab to show it', 6000, `({ active: document.activeElement && (document.activeElement.id || document.activeElement.tagName), tabCls: document.getElementById('agentic-tab-saved').className, tabDisp: getComputedStyle(document.getElementById('agentic-tab-saved')).display, panelCls: document.getElementById('agentic-panel-saved').className, collapsed: document.getElementById('agentic-state').className })`);
        assert.equal(await ev(`document.activeElement.id`), 'agentic-tab-saved', 'the focus stays on the tab, as with every tab');
        assert.equal(await ev(`document.getElementById('agentic-tab-saved').getAttribute('aria-label')`), 'Saved for later on this page'); // not the top bar button's name: that one opens everything's list
        await ev(`document.getElementById('agentic-tab-files').click(); true`);
        // The top bar's bookmark is the Inbox's, from an agent's page too (#4905): Enter on it opens the page with the focus on its Saved sub-tab, and pressing it again goes back to the agent.
        await ev(`document.getElementById('saved-btn').focus(); true`);
        await key('Enter', 'Enter', 13);
        await waitFor(`(() => { const t = document.getElementById('group-table-view'); return t.getClientRects().length > 0 && t.dataset.group === 'hub-inbox:saved'; })() && document.getElementById('group-table-view').contains(document.activeElement)`, 'the Inbox at Saved with the focus inside it', 6000);
        await ev(`document.getElementById('saved-btn').click(); true`); // pressed again: back to the agent
        await waitFor(`!(() => { const t = document.getElementById('group-table-view'); return t.getClientRects().length > 0 && t.dataset.group === 'hub-inbox:saved'; })()`, 'the Inbox left', 6000);
        await ev(`document.getElementById('agentic-state').classList.add('collapsed'); true`); // the sidebar closed
        await ev(`document.getElementById('agentic-tab-saved').classList.add('tab-hidden'); true`); // and the user hid the Saved tab: the toast's link and Back to Saved still open it
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'saved.js'); await m.openSaved(); return true; })()`);
        await waitFor(`${TAB_OPEN} && document.getElementById('agentic-panel-saved').contains(document.activeElement)`, 'the sidebar open on Saved with the focus inside it', 6000);
        assert.equal(await ev(`document.querySelector('#agentic-tab-saved .agentic-tab-count').textContent`), '2', 'the count is on the tab too');
        console.log('   ✓');

        console.log('7b. A board message: saved from its row, listed as a Board item, the jump opens the team page at the message, a deleted one is gone');
        BOARD = 'saved-4510-board';
        await api('POST', `/api/board/${BOARD}/subscribe`, { subscriber_id: 'Saver', job_title: 'Saver' });
        for (const c of ['first board message', 'the one to save', 'the one to delete']) { const r = await api('POST', `/api/board/${BOARD}/messages`, { subscriber_id: 'Saver', content: c }); assert.equal(r.status, 200, 'post: ' + JSON.stringify(r)); }
        const got = await api('GET', `/api/board/${BOARD}/messages/all?limit=10`);
        assert.equal(got.status, 200, JSON.stringify(got));
        const bm = got.body.messages || got.body;
        const keep = bm.find(m => m.content === 'the one to save'), drop = bm.find(m => m.content === 'the one to delete');
        assert.ok(keep && drop, 'the board has its messages');
        await ev(`(async () => { localStorage.setItem('coral.board.view', 'chat'); window.switchNavTab('agents', { fromHistory: true }); const m = await import((window.__coralStatic || '/static/') + 'team_page.js'); await m.openTeamPage(${JSON.stringify(BOARD)}, { tab: 'messages' }); return true; })()`);
        await waitFor(`document.querySelectorAll('#mb-messages .mb-message').length === 3`, 'the team page Board chat rows', 8000);
        assert.equal(await ev(`location.pathname`), `/team/${BOARD}/board`, 'saving starts on the team page');
        const bb = await ev(`(() => { const b = document.querySelector('#mb-messages [data-message-id="${keep.id}"] .mb-save-btn'); return b ? { label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), hidden: b.hidden } : null; })()`);
        assert.deepEqual({ ...bb, label: bb.label.split(':')[0] }, { label: 'Save for later', pressed: 'false', hidden: false });
        for (const id of [keep.id, drop.id]) {
            await ev(`document.querySelector('#mb-messages [data-message-id="${id}"] .mb-save-btn').click(); true`);
            await waitFor(`document.querySelector('#mb-messages [data-message-id="${id}"] .mb-save-btn').getAttribute('aria-pressed') === 'true'`, 'the board message saved', 6000);
        }
        const bl = await saved('?kind=board&conv=' + BOARD);
        assert.equal(bl.items.length, 2); assert.equal(bl.items.find(i => i.key === String(keep.id)).snippet, 'the one to save');
        assert.equal((await api('DELETE', `/api/board/${BOARD}/messages/${drop.id}`)).status, 200, 'the message is deleted from the board');
        // Leaving the team page awaits its settings guard. The mobile wrapper
        // drops the exported selector's promise even on desktop; await the real
        // selector so no late selection can navigate away after Saved opens.
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'sessions.js'); await m.selectLiveSession('sv-a', 'claude', 'sv-a-id', 'local'); await m.selectLiveSession('', '', '', 'local'); return true; })()`); // home: this list reads every conversation
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'saved.js'); await m.openSaved(); return true; })()`); // the page's own Saved tab; the top bar's bookmark is the Inbox's (#4905)
        const INBOX_ROWS = '#group-table-view tbody tr';
        await waitFor(`${INBOX_SAVED} && [...document.querySelectorAll('${INBOX_ROWS} .dt-primary')].filter(e => e.textContent.toLowerCase().includes('saved-4510-board')).length === 2`, 'the board items (home\'s list is the Inbox\'s, everything\'s)', 6000);
        await waitFor(`[...document.querySelectorAll('${INBOX_ROWS}')].some(tr => tr.textContent.includes('the one to delete') && tr.cells[2].textContent.trim() === 'Gone')`, 'the exact deleted board message to be found gone', 8000);
        const goneClick = await ev(`(async () => { const tr = [...document.querySelectorAll('${INBOX_ROWS}')].find(tr => tr.textContent.includes('the one to delete')); const b = tr.querySelector('.dt-primary'); const m = await import((window.__coralStatic || '/static/') + 'saved.js'); const it = m.findSavedItem(b.dataset.id); const facts = it && m.savedItemFacts(it); b.click(); return { id: b.dataset.id, facts, page: document.getElementById('inbox-page').textContent, dock: document.getElementById('agentic-saved-detail-pane').textContent }; })()`);
        await waitFor(`!!document.querySelector('#inbox-page .inbox-saved-why')`, 'the gone message\'s page', 8000, `({ click: ${JSON.stringify(goneClick)}, nav: document.body.dataset.navTab, path: location.pathname, page: document.getElementById('inbox-page').textContent, hidden: document.getElementById('inbox-page').hidden, dock: document.getElementById('agentic-saved-detail-pane').textContent })`);
        assert.match(await ev(`document.querySelector('#inbox-page .inbox-saved-why').textContent`), /deleted from the board, or the board was/);
        await ev(`document.querySelector('#inbox-page .group-back:not(.inbox-phone-back)').click(); true`);
        await waitFor(`${INBOX_SAVED} && [...document.querySelectorAll('${INBOX_ROWS}')].some(tr => tr.textContent.includes('the one to save'))`, 'back at the Saved table with the kept board message', 6000,
            `(async () => { const m = await import((window.__coralStatic || '/static/') + 'saved.js'); const v = m.savedView(); return { group: document.getElementById('group-table-view').dataset.group, rows: [...document.querySelectorAll('${INBOX_ROWS}')].map(tr => ({ key: tr.dataset.key, text: tr.textContent, id: tr.querySelector('.dt-primary')?.dataset.id })), saved: v.shown.map(i => ({ id: i.id, key: i.key, title: i.title, snippet: i.snippet, reason: i.reason })), scoped: v.scoped, page: document.getElementById('inbox-page').textContent, hidden: document.getElementById('inbox-page').hidden, nav: document.body.dataset.navTab, click: ${JSON.stringify(goneClick)} }; })()`);
        await ev(`[...document.querySelectorAll('${INBOX_ROWS}')].find(tr => tr.textContent.includes('the one to save')).querySelector('.dt-primary').click(); true`);
        await waitFor(`!!document.querySelector('#inbox-page .item-bar .btn-primary:not([disabled])')`, 'the board message\'s page with its Open button', 8000);
        await ev(`document.querySelector('#inbox-page .item-bar .btn-primary').click(); true`);
        await waitFor(`!!document.querySelector('#mb-messages [data-message-id="${keep.id}"].chat-search-target')`, 'the jump into the board', 10000, `({ view: getComputedStyle(document.getElementById('team-page-view')).display, rows: document.querySelectorAll('#mb-messages .mb-message').length, targets: document.querySelectorAll('.chat-search-target').length, tip: document.getElementById('saved-status').textContent, gone: [...document.querySelectorAll('.why:not([hidden])')].map(e => e.textContent) })`);
        assert.equal(await ev(`location.pathname`), `/team/${BOARD}/board/${keep.id}`, 'a saved message opens its exact team page address');
        assert.equal(await ev(`document.activeElement === document.querySelector('#mb-messages [data-message-id="${keep.id}"]')`), true, 'the focus is on the message');
        await waitFor(`!!document.getElementById('saved-jumpbar') && !!document.querySelector('#mb-messages .saved-jump')`, 'the jump bar and the Saved tag', 6000);
        assert.equal(await ev(`document.querySelector('#saved-jumpbar .btn').textContent`), 'Back to Saved');
        await shot('saved-board-jump');
        for (const it of (await saved()).items) await api('DELETE', `/api/saved/${it.id}`);
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'sessions.js'); await m.selectLiveSession('sv-a', 'claude', 'sv-a-id', 'local'); return true; })()`);
        // two items again for the phone
        await ev(`(async () => { for (const k of [${JSON.stringify(hex(3))}, ${JSON.stringify(hex(4))}]) await fetch('/api/saved', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'agent', ref: 'sv-a-id', key: k, agent_type: 'claude', title: 'sv-a', snippet: 'a saved message', said_at: '2026-10-17T08:00:00Z' }) }); })()`);
        console.log('   ✓');

        console.log('7c. An agent that has ended: the saved item opens it in History at the message; a conversation with no transcript is gone');
        const ENDED = 'dead0000-0000-4000-8000-000000000001', MISSING = 'dead0000-0000-4000-8000-000000000002';
        await ev(`(() => {
            const prev = window.fetch; const N = 150;
            window.fetch = async (url, opts = {}) => {
                const u = String(url); const m = u.match(/\\/api\\/sessions\\/history\\/([^/?]+)(\\?(.*))?$/);
                if (!m) return prev(url, opts);
                const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
                if (m[1] === ${JSON.stringify(MISSING)}) return json({ error: 'not found' }, 404);
                if (m[1] !== ${JSON.stringify(ENDED)}) return prev(url, opts);
                const p = new URLSearchParams(m[3] || '');
                const all = Array.from({ length: N }, (_, i) => ({ type: i % 2 ? 'assistant' : 'user', ...(i % 2 ? { text: 'ended message ' + i, tool_uses: [] } : { content: 'ended message ' + i }), timestamp: '2026-10-16T10:00:' + String(i % 60).padStart(2, '0') + 'Z', key: i.toString(16).padStart(20, '0') }));
                if (p.has('find_key')) { const idx = all.findIndex(x => x.key === p.get('find_key')); return json({ found: idx >= 0, index: Math.max(idx, 0), total: N }); }
                const limit = Number(p.get('limit') || N), offset = Number(p.get('offset') || 0);
                const end = Math.max(N - offset, 0), start = Math.max(end - limit, 0);
                return json({ session_id: ${JSON.stringify(ENDED)}, agent_type: 'claude', messages: all.slice(start, end), total: N, start });
            };
        })()`);
        const e1 = await api('POST', '/api/saved', { kind: 'agent', ref: ENDED, key: hex(20), agent_type: 'claude', title: 'ended agent', snippet: 'ended message 20', said_at: '2026-10-16T10:00:20Z' });
        const e2 = await api('POST', '/api/saved', { kind: 'agent', ref: MISSING, key: hex(1), agent_type: 'claude', title: 'no transcript', snippet: 'a message of a transcript that is gone', said_at: '2026-10-16T10:00:01Z' });
        assert.equal(e1.status, 200); assert.equal(e2.status, 200);
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'sessions.js'); await m.selectLiveSession('', '', '', 'local'); return true; })()`); // home: the list is of the agent or team on screen (#4792), and these are three agents'
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'saved.js'); await m.openSaved(); return true; })()`); // the page's own Saved tab; the top bar's bookmark is the Inbox's (#4905)
        const IR = '#group-table-view tbody tr';
        await waitFor(`${INBOX_SAVED} && document.querySelectorAll('${IR}').length === 4 && document.getElementById('group-table-view').textContent.includes('transcript that is gone')`, 'the four items (home\'s list is the Inbox\'s)', 6000);
        await waitFor(`[...document.querySelectorAll('${IR}')].some(tr => tr.textContent.includes('transcript that is gone') && tr.cells[2].textContent.trim() === 'Gone')`, 'the missing transcript to be found gone', 8000);
        await ev(`[...document.querySelectorAll('${IR}')].find(tr => tr.textContent.includes('transcript that is gone')).querySelector('.dt-primary').click(); true`);
        await waitFor(`!!document.querySelector('#inbox-page .inbox-saved-why')`, 'the missing transcript\'s page', 8000);
        assert.match(await ev(`document.querySelector('#inbox-page .inbox-saved-why').textContent`), /transcript is gone/);
        await ev(`document.querySelector('#inbox-page .group-back:not(.inbox-phone-back)').click(); true`);
        await waitFor(`${INBOX_SAVED}`, 'back at the Saved table', 6000);
        await ev(`[...document.querySelectorAll('${IR}')].find(tr => tr.textContent.includes('ended message 20')).querySelector('.dt-primary').click(); true`);
        await waitFor(`!!document.querySelector('#inbox-page .item-bar .btn-primary:not([disabled])')`, 'the ended agent\'s page with its Open button', 8000);
        assert.equal(await ev(`document.querySelector('#inbox-page .item-bar .btn-primary').getAttribute('aria-label')`), 'Open in Chats: ended agent', 'an ended agent opens in Chats (#6580)');
        await ev(`document.querySelector('#inbox-page .item-bar .btn-primary').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('history-session-view')).display !== 'none'`, 'History to open', 8000);
        await waitFor(`!!document.querySelector('#history-messages [data-msg-key="${hex(20)}"]')`, 'the message in History', 8000);
        await waitFor(`!!document.querySelector('#history-messages .chat-search-target')`, 'the message to be marked', 8000);
        const hb = await ev(`(() => { const t = document.querySelector('#history-messages .chat-search-target'); const b = document.querySelector('#history-messages [data-msg-key="${hex(20)}"] .chat-save-btn'); return { text: t.textContent.trim().slice(0, 20), saveHidden: b ? b.hidden : null, pressed: b ? b.getAttribute('aria-pressed') : null }; })()`);
        assert.match(hb.text, /ended message 20/); assert.equal(hb.saveHidden, false, 'History messages have the button too');
        await waitFor(`document.querySelector('#history-messages [data-msg-key="${hex(20)}"] .chat-save-btn')?.getAttribute('aria-pressed') === 'true'`, 'the saved state in History', 6000, `({ btn: (() => { const b = document.querySelector('#history-messages [data-msg-key="${hex(20)}"] .chat-save-btn'); return b ? { pressed: b.getAttribute('aria-pressed'), hidden: b.hidden, cls: b.className } : null; })(), cur: T.state.currentSession && { type: T.state.currentSession.type, name: T.state.currentSession.name }, total: document.querySelectorAll('#history-messages .chat-save-btn').length })`);
        await waitFor(`(() => { const t = document.querySelector('#history-messages .chat-search-target'); const c = document.getElementById('history-messages'); if (!t) return false; const r = t.getBoundingClientRect(), cr = c.getBoundingClientRect(); return r.top >= cr.top - 1 && r.bottom <= cr.bottom + 1; })()`, 'the message to be scrolled into view in History', 8000);
        await shot('saved-history-jump');
        for (const it of (await saved()).items) await api('DELETE', `/api/saved/${it.id}`);
        await select('sv-a');
        await ev(`(async () => { for (const k of [${JSON.stringify(hex(3))}, ${JSON.stringify(hex(4))}]) await fetch('/api/saved', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'agent', ref: 'sv-a-id', key: k, agent_type: 'claude', title: 'sv-a', snippet: 'a saved message', said_at: '2026-10-17T08:00:00Z' }) }); })()`);
        console.log('   ✓');

        console.log('8. A phone (390 px): the side panel overlay opens on Saved, it fits, the controls are 44 px, nothing scrolls sideways');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true });
        // The top bar keeps the Saved button on a phone, with its count.
        await ev(`document.dispatchEvent(new CustomEvent('coral:saved-changed')); true`); // the test changed the bookmarks behind the page's back
        await waitFor(`document.querySelector('#saved-btn .saved-count').textContent === '2'`, 'the count to follow the list', 6000);
        const tbtn = await ev(`(() => { const b = document.getElementById('saved-btn'); const r = b.getBoundingClientRect(); return { shown: getComputedStyle(b).display !== 'none' && r.width > 0, w: Math.round(r.width), h: Math.round(r.height), count: b.querySelector('.saved-count').textContent, name: b.getAttribute('aria-label'), page: document.documentElement.scrollWidth <= document.documentElement.clientWidth }; })()`);
        assert.ok(tbtn.shown && tbtn.w >= 44 && tbtn.h >= 44 && tbtn.page, 'the top bar button is there, 44 px, and the page does not scroll sideways: ' + JSON.stringify(tbtn));
        assert.equal(tbtn.count, '2'); assert.equal(tbtn.name, 'Saved for later, 2 open');
        await select('sv-a');
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'saved.js'); await m.openSaved(); return true; })()`); // the page's own Saved tab; the top bar's bookmark is the Inbox's (#4905)
        await waitFor(`document.getElementById('agentic-state').classList.contains('mobile-panel-overlay') && ${TAB_OPEN} && document.querySelectorAll('${ROWS}').length === 2`, 'the side panel overlay open on Saved on the phone', 8000);
        const ph = await ev(`(() => { const vw = document.documentElement.clientWidth; const m = document.getElementById('agentic-state').getBoundingClientRect();
            const small = []; for (const e of document.querySelectorAll('#agentic-panel-saved button')) { const r = e.getBoundingClientRect(); if (r.width && (r.height < 43.5 || r.width < 43.5)) small.push((e.className || e.id) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
            return { vw, left: Math.round(m.left), right: Math.round(m.right), page: document.documentElement.scrollWidth, small }; })()`);
        assert.ok(ph.left >= 0 && ph.right <= ph.vw && ph.page <= ph.vw, 'the panel fits the phone: ' + JSON.stringify(ph));
        assert.deepEqual(ph.small, [], 'every control is a 44 px target: ' + JSON.stringify(ph.small));
        await shot('saved-tab-phone');
        // Opening an item on a phone gives the overlay way, so the jump is seen.
        await ev(`document.querySelector('#saved-table .dt-primary').click(); true`);
        await waitFor(`!!document.querySelector('#agentic-saved-detail-pane .detail-foot .btn-primary')`, 'the message sheet on the phone', 8000);
        const sh = await ev(`(() => { const s = document.getElementById('agentic-saved-detail-pane'), vw = document.documentElement.clientWidth, r = s.getBoundingClientRect(); const small = [...s.querySelectorAll('button')].filter(b => b.getBoundingClientRect().width && (b.getBoundingClientRect().height < 43.5 || b.getBoundingClientRect().width < 43.5)).map(b => (b.className || b.textContent) + ' ' + Math.round(b.getBoundingClientRect().width) + 'x' + Math.round(b.getBoundingClientRect().height)); return { left: Math.round(r.left), right: Math.round(r.right), vw, page: document.documentElement.scrollWidth, small }; })()`);
        assert.ok(sh.left >= 0 && sh.right <= sh.vw && sh.page <= sh.vw, 'the sheet fits the phone: ' + JSON.stringify(sh)); assert.deepEqual(sh.small, [], 'every control of the sheet is a 44 px target: ' + JSON.stringify(sh.small));
        assert.equal(await ev(`(() => { const e = document.querySelector('#agentic-saved-detail-pane .ibx-why'); return e ? getComputedStyle(e).fontSize : '13px'; })()`), '13px', 'the component\'s reason line in the sheet is 13 px too');
        await shot('saved-sheet-phone');
        await ev(`document.querySelector('#agentic-saved-detail-pane .detail-foot .btn-primary').click(); true`);
        await waitFor(`!document.getElementById('agentic-state').classList.contains('mobile-panel-overlay')`, 'the overlay to give way to the conversation', 12000);
        // The message button is a 44 px target on a phone too.
        await select('sv-a');
        await waitFor(`${C}.querySelectorAll('.chat-save-btn').length > 3`, 'the chat on the phone', 6000);
        const tb = await ev(`(() => { const b = ${C}.querySelector('.chat-bubble.assistant .chat-save-btn'); const r = b.getBoundingClientRect(); const cb = ${C}.querySelector('.chat-bubble.assistant .chat-copy-btn'); const c = cb.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), copyW: Math.round(c.width), copyH: Math.round(c.height), opacity: getComputedStyle(b).opacity, copyOpacity: getComputedStyle(cb).opacity, overlapsCopy: r.left < c.right - 1 && r.right > c.left + 1 && r.top < c.bottom - 1 && r.bottom > c.top + 1 }; })()`);
        assert.ok(tb.w >= 44 && tb.h >= 44, 'the Save button is 44 px on touch: ' + JSON.stringify(tb));
        assert.ok(tb.copyW >= 44 && tb.copyH >= 44, 'Copy is 44 px on touch too: ' + JSON.stringify(tb)); assert.equal(tb.opacity, '1', 'always visible on touch'); assert.equal(tb.copyOpacity, '1', 'Copy too');
        assert.equal(tb.overlapsCopy, false, 'it does not sit on Copy: ' + JSON.stringify(tb));
        // The 44 px Save and Copy sit in a gap of their own under a message, not over the next one (UX's phone finding).
        const gap = await ev(`(() => { const out = []; const bubbles = [...${C}.querySelectorAll('.chat-bubble')]; for (let i = 0; i < bubbles.length - 1; i++) { const b = bubbles[i], next = bubbles[i + 1]; if (!b.querySelector('.chat-save-btn')) continue;
            const nt = next.getBoundingClientRect().top; for (const btn of b.querySelectorAll('.chat-save-btn, .chat-copy-btn')) { const r = btn.getBoundingClientRect(); if (r.width && r.bottom > nt + 1) out.push(Math.round(r.bottom - nt)); } } return { over: out, checked: bubbles.length }; })()`);
        assert.ok(gap.checked > 4); assert.deepEqual(gap.over, [], 'no button hangs over the next message: ' + JSON.stringify(gap));
        await shot('saved-button-phone');
        console.log('9. A phone at 200% text: Saved keeps its bookmark and Inbox folder, with no gear-menu duplicate');
        await ev(`document.documentElement.style.fontSize = '32px'; true`);
        await waitFor(`document.body.classList.contains('saved-bar-wrap') && (() => { const b = document.getElementById('saved-btn').getBoundingClientRect(), s = document.getElementById('nav-select').getBoundingClientRect(); return s.top >= b.bottom; })()`, 'the view selector to wrap at large text', 6000);
        const big = await ev(`(() => { const b = document.getElementById('saved-btn'), br = b.getBoundingClientRect(); const sel = document.querySelector('.nav-select'), sr = sel.getBoundingClientRect(); const label = document.getElementById('nav-select-label'); return { btn: getComputedStyle(b).display, count: b.querySelector('.saved-count').textContent, w: br.width, h: br.height, right: br.right, selW: sr.width, separate: sr.top >= br.bottom, labelFits: label.scrollWidth <= label.clientWidth + 1 }; })()`);
        assert.notEqual(big.btn, 'none', 'the bookmark stays visible at large text');
        assert.ok(big.w >= 44 && big.h >= 44 && big.right <= 390, 'the bookmark remains an on-screen touch target: ' + JSON.stringify(big));
        assert.equal(big.count, '2');
        assert.ok(big.selW >= 100 && big.separate && big.labelFits, 'the view selector keeps its name on its own row: ' + JSON.stringify(big));
        await ev(`document.querySelector('[data-on-click="m-toggle-top-bar-settings"]').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('top-bar-settings-menu')).display !== 'none'`, 'the settings menu', 4000);
        assert.equal(await ev(`document.getElementById('top-bar-settings-menu').querySelector('[data-on-click="m-close-top-bar-settings-then-show-saved"]') === null`), true, 'the gear menu has no Saved duplicate');
        await ev(`document.querySelector('[data-on-click="m-toggle-top-bar-settings"]').click(); document.getElementById('saved-btn').click(); true`);
        await waitFor(`${INBOX_SAVED} && true`, 'the bookmark to open the Inbox at Saved', 8000);
        await shot('saved-bookmark-phone-200');
        // The folder remains a second way in, through the ordinary Inbox navigation.
        await ev(`document.getElementById('saved-btn').click(); window.switchNavTab('hub-inbox'); true`);
        await waitFor(`!!document.querySelector('#inbox-nav-list .view-list-item[data-key="saved"]')`, 'the Inbox Saved folder', 6000);
        await ev(`document.querySelector('#inbox-nav-list .view-list-item[data-key="saved"]').click(); true`);
        await waitFor(`${INBOX_SAVED} && true`, 'the Inbox folder to open Saved', 8000);
        await ev(`document.documentElement.style.fontSize = ''; true`);
        await waitFor(`!document.body.classList.contains('saved-bar-wrap')`, 'the view selector to return to one row at normal text', 6000);
        console.log('   ✓');

        await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Emulation.clearDeviceMetricsOverride();
        console.log('\nAll Save for Later checks passed');
    } finally {
        await require('./helpers/saved_cleanup').clearSaved(api).catch(() => {}); // the bookmarks this suite saved are taken off again whichever way it ended (#4916, #5083)
        await removeBoards(ev, [BOARD]);
        await client.close();
    }
})().catch(err => {
    console.error(err);
    process.exit(1);
});
