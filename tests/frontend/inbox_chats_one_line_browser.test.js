// #8961 (Goal #79, #8935's list items 3 and 4): the Inbox's chat folders and Board history show ONE line per chat: Title | Agent | When (| Server with more than one machine); the agent's role and the first message are
// in the chat that opens, not on the row. The shared one-row table (#8931): it never folds and drops Server, then Agent as the box narrows, so a phone keeps Title and When. 1280 and 390; the history list is stubbed in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const fs = require('node:fs'), path = require('node:path');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const stub = () => ev(`(() => { const R = window.fetch; const now = Date.now();
        const sessions = Array.from({ length: 6 }, (_, i) => ({ session_id: 'chat-' + i, type: i === 5 ? 'group' : 'agent', title: i === 5 ? 'release-crew' : 'A deliberately long chat title that must be cut with an ellipsis, chat ' + i, summary: i === 5 ? 'release-crew - 3 messages, 2 participants' : 'The first message of chat ' + i + ', which used to be a second line on the row',
            agent_name: 'Backend Dev', display_name: 'Backend Dev', last_timestamp: new Date(now - i * 3600000).toISOString(), duration_sec: 600, source_type: 'claude', starred: false, archived: false, active: i === 1, tags: [] }));
        const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
            if (url.pathname === '/api/sessions/history/counts') return json({ all: 5, group: 1, notes: 0, active: 1, starred: 0, archived: 0, by_agent_type: { claude: 5 }, tags: [] });
            if (url.pathname === '/api/sessions/history') { const ty = url.searchParams.get('type'), list = ty === 'group' ? sessions.filter(x => x.type === 'group') : sessions.filter(x => x.type !== 'group'); return json({ sessions: list, total: list.length, page: 1, page_size: 50 }); }
            return R(u, o); }; return true; })()`);
    const open = async (w, mobile, folder) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); await stub();
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab(${JSON.stringify(folder)})).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length >= 1`, 'the chats', 15000);
    };
    const failures = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, mobile] of [[1280, false], [390, true]]) for (const [folder, n] of [['chats', 5], ['chats-group', 1]]) {
            const at = `${width} ${folder}: `;
            try {
                await open(width, mobile, folder);
                await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length === ${n}`, at + 'the rows', 8000);
                // a phone's row is a mail row (#9545): the agent and the chat's title on the line, the time at the right (.dt-mail-time)
                const rows = await ev(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)')].map(r => { const v = e => !!e && e.getClientRects().length > 0, rect = e => { const b = e.getBoundingClientRect(); return { x: b.x, mid: b.y + b.height / 2 }; };
                    const title = r.querySelector('button.dt-primary'), when = r.querySelector('.dt-time, .dt-mail-time'); const box = r.closest('.dt-box');
                    return { title: v(title) && rect(title), when: v(when) && rect(when), h: Math.round(r.getBoundingClientRect().height), snippet: !!r.querySelector('.dt-chat-snippet'), ran: [...r.children].some(c => c.dataset.key === 'ran' && v(c)), folded: box.classList.contains('dt-folded'), scrolls: box.scrollWidth - box.clientWidth, agentShown: [...r.children].some(c => c.dataset.key === 'agent' && v(c)) }; })`);
                for (const r of rows) {
                    assert.ok(r.title && r.when, at + 'title and when are on the row: ' + JSON.stringify(r));
                    assert.ok(Math.abs(r.title.mid - r.when.mid) < 8, at + 'they share one line: ' + JSON.stringify(r));
                    assert.ok(r.h <= 56, at + 'one line: ' + r.h + ' px'); assert.equal(r.snippet, false, at + 'no first message on the row'); assert.equal(r.ran, false, at + 'no Ran on the row'); assert.equal(r.folded, false, at + 'the table does not fold'); assert.ok(r.scrolls <= 1, at + 'no sideways scroll');
                    if (folder === 'chats') assert.equal(r.agentShown, width === 1280, at + (width === 1280 ? 'the agent is a column' : 'the phone drops the agent column'));
                }
                // #9458: nothing in a row is cut by its cell (the star and archive buttons were 99 px in an 80 px cell: a stray mark at the table's edge), and the When header is over its cell's right edge
                const cut = await ev(`(() => { const t = document.querySelector('#group-table-view .dt-table'), th = k => t.querySelector('thead th[data-key="' + k + '"]'), out = []; for (const tr of t.querySelectorAll('tbody tr:not(.dt-group)')) for (const c of tr.children) if (c.dataset.key !== 'title' && c.getClientRects().length && [c, ...c.querySelectorAll('*')].some(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible' || c.scrollWidth > c.clientWidth + 1)) out.push(c.dataset.key); const w = th('when'), cell = t.querySelector('tbody tr:not(.dt-group) td[data-key="when"]'); return { cut: [...new Set(out)], whenOff: w && cell ? Math.abs(w.getBoundingClientRect().right - cell.getBoundingClientRect().right) : null }; })()`);
                // one chip a row at most, and what the row no longer draws is on the hover: the agent after the title (#9730)
                const chips = await ev(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)')].map(r => ({ tags: [...r.querySelectorAll('.dt-tag, .dt-chip')].filter(e => e.getClientRects().length).length, tip: (r.querySelector('button.dt-primary') || {}).title || '' }))`);
                assert.ok(chips.every(c => c.tags <= 1), at + 'at most one chip a row: ' + JSON.stringify(chips));
                if (folder === 'chats' && !mobile) assert.ok(chips.every(c => / \u00b7 Backend Dev$/.test(c.tip)), at + 'the row\'s hover names the agent: ' + JSON.stringify(chips));
                if (!mobile) assert.deepEqual(cut.cut, [], at + 'no cell but the title (its ellipsis is the design) is cut by its box: ' + JSON.stringify(cut));
                if (!mobile) assert.ok(cut.whenOff !== null && cut.whenOff <= 2, at + 'the When header is over its cell: ' + JSON.stringify(cut));
                const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out'));
                if (dir) { fs.mkdirSync(dir, { recursive: true }); for (const theme of ['light', 'dark']) { await setTheme(ev, theme); fs.writeFileSync(path.join(dir, `inbox-${folder}-one-line-${width}-${theme}.png`), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } }
                console.log(`PASS ${at}one line per chat`);
            } catch (e) { failures.push(at + e.message); console.error(failures.at(-1)); }
        }
        assert.deepEqual(failures, []);
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
