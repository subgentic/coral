// Chats (#7157, UI/UX's #7148 findings 7 to 9): Resume is a quiet button, primary only on the person's last (newest) chat; the copy-branch icon is a 44 px target on a phone; the empty pane's hint is a small
// plain line (14/400, the page's text colour), not the page's biggest heading; and at 390 px a long chat title wraps to two lines with the provider badge under it instead of being cut with an ellipsis. Drives Chrome over CDP through
// agent_view_harness.js with the history list and two chats answered at the page's fetch.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a chat draws after the click
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, font] of [[1280, 900, false, ''], [390, 844, true, ''], [390, 844, true, '32px']]) {
            const tag = `${w} px${font ? ', 200% text' : ''}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            if (font) await ev(`document.documentElement.style.fontSize = '${font}'; true`);
            await ev(`(() => { const real = window.fetch; const json = o => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const at = (dd, hh) => { const d = new Date(); d.setDate(d.getDate() - dd); d.setHours(hh, 0, 0, 0); return d.toISOString(); };
                const rows = [ { session_id: 'aaaaaa1', title: 'The newest chat', source_type: 'claude', display_name: 'Ada', last_timestamp: at(0, 14), branch: 'feat/flaky' },
                    { session_id: 'aaaaaa2', title: 'An older chat', source_type: 'claude', display_name: 'Ada', last_timestamp: at(1, 9), branch: 'feat/flaky' },
                    { session_id: 'eeeeee1', title: 'An extremely long chat title that goes on and on and on, well past what one row of the sidebar can hold at any size at all', source_type: 'codex', display_name: 'A-long-agent-name', last_timestamp: at(6, 11) } ];
                const chat = sid => json({ session_id: sid, agent_type: 'claude', messages: [{ type: 'user', content: 'Hello' }, { type: 'assistant', text: 'Hi' }], total: 2, start: 0 });
                window.fetch = (u, o) => { const p = new URL(String(u), location.href).pathname;
                    if (p === '/api/sessions/history') return json({ sessions: rows, total: rows.length, page: 1, page_size: 50 });
                    if (p === '/api/sessions/history/aaaaaa1') return chat('aaaaaa1'); if (p === '/api/sessions/history/aaaaaa2') return chat('aaaaaa2');
                    if (p.startsWith('/api/sessions/history/aaaaaa1/') || p.startsWith('/api/sessions/history/aaaaaa2/')) return json([]);
                    return real(u, o); };
                return true; })()`);
            await ev(`window.switchNavTab('history'); Promise.all([import((window.__coralStatic||'/static/')+'sidebar.js'), import((window.__coralStatic||'/static/')+'view_switch.js')]).then(([sb, vs]) => { sb.showSidebarPane('history'); vs.showView('chats-empty-view'); document.body.setAttribute('data-nav-tab', 'history'); return true; })`); await sleep(800); // sleep-ok: the list draws after the tab opens
            await ev(`(async () => { const m = await import(${S} + 'history_list.js'); const hf = await import(${S} + 'history_filters.js'); await hf.loadHistoryFiltered(); return true; })().catch(() => true)`); // the list the hub's Chats tab loads when it opens
            await waitFor(`document.querySelectorAll('#history-sessions-list li[data-session-id]').length === 3`, 'three chats', 10000);
            // On a wide screen the tab opens on its first group's table (#7443): the empty pane is what shows with no chat and no group, so it is put on screen here to be measured
            if (!mobile) {
                assert.ok(await ev(`document.getElementById('group-table-view').checkVisibility() && !!document.querySelector('#group-table-view table.dt-table')`), `${tag}: the Chats tab opens on its first group's table`);
                await ev(`(async () => { const u = await import(${S} + 'utils.js'); u.showView('chats-empty-view'); return true; })()`);
            }
            // the empty pane
            const empty = await ev(`(() => { const v = document.getElementById('chats-empty-view'); const h = v && v.querySelector('.empty-state-line'); if (!h || !h.getClientRects().length) return null; const c = getComputedStyle(h); return { text: h.textContent, size: c.fontSize, weight: c.fontWeight, color: c.color, primary: (() => { const t = document.createElement('i'); t.style.color = 'var(--text-secondary)'; document.body.append(t); const v = getComputedStyle(t).color; t.remove(); return v; })() }; })()`);
            if (!mobile) { assert.ok(empty && empty.text === 'No chats yet.' && empty.size === '14px' && empty.weight === '400' && empty.color === empty.primary, `${tag}: the empty pane is one 14/400 line in the secondary colour: ` + JSON.stringify(empty)); }
            // the long title wraps with the badge below it (a phone)
            if (mobile) {
                const row = await ev(`(() => { const li = document.querySelector('#history-sessions-list li[data-session-id="eeeeee1"]'); const l = li.querySelector('.session-label'), b = li.querySelector('.chip'); const lr = l.getBoundingClientRect(), br = b.getBoundingClientRect(); const lh = parseFloat(getComputedStyle(l).lineHeight) || parseFloat(getComputedStyle(l).fontSize) * 1.3; return { lines: Math.round(lr.height / lh), cut: getComputedStyle(l).textOverflow === 'ellipsis' && l.scrollWidth > l.clientWidth + 1, badgeBelow: br.top >= lr.bottom - 2 }; })()`);
                assert.ok(row.lines === 2 && !row.cut && !row.badgeBelow, `${tag}: a long title wraps to two lines with the badge beside it, not under it (#7722): ` + JSON.stringify(row));
            }
            // Resume: primary only on the newest chat; the copy-branch icon is a 44 px target on a phone
            await ev(`window.selectHistorySession('aaaaaa1'); true`);
            await waitFor(`document.getElementById('btn-resume-session') && document.getElementById('btn-resume-session').getClientRects().length > 0`, 'Resume on the newest chat', 8000); await sleep(300); // sleep-ok: the header settles
            assert.equal(await ev(`document.getElementById('btn-resume-session').classList.contains('btn-primary')`), true, `${tag}: Resume is the primary button on the newest chat`);
            if (mobile) {
                const cb = await ev(`(() => { const b = document.querySelector('#history-session-branch .copy-branch-btn'); const r = b.getBoundingClientRect(), after = getComputedStyle(b, '::after'); return { w: Math.round(Math.max(r.width, parseFloat(after.width) || 0)), h: Math.round(Math.max(r.height, parseFloat(after.height) || 0)) }; })()`); // the dense icon button is a 24 px box with a 44 px hit area (its ::after, #9484)
                assert.ok(cb.w >= 44 && cb.h >= 44, `${tag}: the copy-branch icon is a 44 px target: ` + JSON.stringify(cb));
            }
            await ev(`window.selectHistorySession('aaaaaa2'); true`);
            await waitFor(`document.getElementById('history-session-title') && /older/i.test(document.getElementById('history-session-title').textContent)`, 'the older chat', 8000); await sleep(300); // sleep-ok: the header settles
            assert.equal(await ev(`document.getElementById('btn-resume-session').classList.contains('btn-primary')`), false, `${tag}: Resume is a quiet button on an older chat`);
        }
        console.log('PASS chats fixes');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
