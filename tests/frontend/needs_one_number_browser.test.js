// Needs you counts from one number (#15118, Beta walk 3 N5, N6, N24): the Inbox badge, the folder's count, the list's own summary and the words 'N unread, M in the list' say the same two numbers (unread, listed), with the
// welcome tiles in neither, before and after one of the files is put away. #22094: the list is the Needs you ledger (needs_ledger.js): rows are article.nl-row, its summary .nl-summary reads 'N items · M new' and the
// phone title bar's .nl-phone-count 'N · M new'; its All / Unread / Questions pills carry no count, so the summary stands where the old All chip's number was.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await guardSettings(); // the bulk Dismiss on the phone saves inbox_welcome_done to the server: put back at the end (#15755)
    const S = `(window.__coralStatic || '/static/')`, team = 'one-number-' + Date.now().toString(36), problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const w of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile: w < 768 }); await Emulation.setTouchEmulationEnabled({ enabled: w < 768 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Dev', job_title: 'Developer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch.bind(window), json = b => Promise.resolve(Response.json(b)), hex = n => n.toString(16).padStart(64, '0');
                window.__rows = [1, 2, 3].map(i => ({ id: hex(i), name: 'file-' + i + '.md', uri: 'coral://artifacts/' + hex(i), produced_by: 'Dev', session_id: 'p' + i, created_at: new Date(Date.now() - i * 60000).toISOString(), media_type: 'text/markdown', available: true, tags: ['for review'], starred: false, series_id: 'series-' + i, version: 1 }));
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href); if (u.pathname === '/api/team-artifacts') return json(window.__reviewFixturePage(u, location.href, { '${team}': window.__rows })); if (u.pathname === '/api/board/${team}/artifacts') return json({ artifacts: window.__rows, has_more: false }); if (opts.method === 'PUT' && /\\/artifacts\\/[0-9a-f]{64}\\/tags$/.test(u.pathname)) { const row = window.__rows.find(r => u.pathname.includes(r.id)); if (row) row.tags = JSON.parse(opts.body).tags; return json({ ok: true, tags: row ? row.tags : [] }); } if (opts.method === 'POST' && /\\/artifacts\\/[0-9a-f]{64}\\/review$/.test(u.pathname)) { const i = window.__rows.findIndex(r => u.pathname.includes(r.id)); if (i >= 0) window.__rows.splice(i, 1); return json({ ok: true }); } return original(url, opts); }; return true; })()`);
            await ev(`T.state.settings = { ...T.state.settings, inbox_welcome: 'off', inbox_welcome_done: '' }; window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view .needs-ledger .nl-row').length === 3`, `${w}: the rows`, 15000);
            await ev(`new Promise(r => setTimeout(r, 600))`); // sleep-ok: the list settles
            const numbers = () => ev(`(() => { const txt = e => e ? e.textContent.replace(/\\s+/g, ' ').trim() : '', row = [...document.querySelectorAll('.view-list-item')].find(r => /Needs you/.test((r.querySelector('.view-list-label') || {}).textContent || ''));
                return { totalRows: document.querySelectorAll('#group-table-view .needs-ledger .nl-row').length, badge: (document.getElementById('nav-tab-hub-inbox-badge') || {}).textContent, summary: txt(document.querySelector('#group-table-view .nl-summary')), phone: txt(document.querySelector('#top-phone-bar .nl-phone-count')), folder: row ? row.getAttribute('aria-label') : '', rows: [...document.querySelectorAll('#group-table-view .needs-ledger .nl-row')].filter(r => !r.querySelector('.inbox-welcome-name')).length }; })()`);
            // The summary counts all listed rows and the new ones; Getting started is off here (its items count like any row: inbox_welcome_counts_browser); badge and folder words keep unread counts (#16548).
            const read = n => { const summary = /^(\d+) items? ?· (\d+) new/.exec(n.summary), phone = /^(\d+) · (\d+) new$/.exec(n.phone), words = /(\d+) unread, (\d+) in the list/.exec(n.folder || ''), plain = /^Needs you, (\d+)$/.exec(n.folder || '');
                return { badge: Number(n.badge || 0), summary: summary ? [Number(summary[1]), Number(summary[2])] : null, phone: phone ? [Number(phone[1]), Number(phone[2])] : null, words: words ? [Number(words[1]), Number(words[2])] : plain ? [Number(plain[1]), Number(plain[1])] : null, rows: n.rows, totalRows: n.totalRows }; };
            const agree = (at, unread, listed) => waitFor(`(() => 1)()`, at, 100).then(async () => { const n = read(await numbers()); const ok = n.badge === unread && n.summary && n.summary[0] === n.totalRows && n.summary[0] === listed && n.summary[1] === unread && n.phone && n.phone[0] === listed && n.phone[1] === unread && n.words && n.words[0] === unread && n.words[1] === listed && n.rows === listed; if (!ok) problems.push(`${at}: the badge, the summary, the phone count, the folder's words and the rows are not ${unread} unread of ${listed}: ` + JSON.stringify(n)); });
            await agree(`${w}: three files, none read`, 3, 3);
            await ev(`import(${S} + 'inbox_reviews.js').then(m => { const r = m.reviewItems().find(x => x.name === 'file-1.md'); return m.setReviewRead(r, true); }).then(() => true)`);
            await ev(`new Promise(r => setTimeout(r, 800))`); // sleep-ok: the counts are drawn again
            await agree(`${w}: one read`, 2, 3);
            await ev(`Promise.all([import(${S} + 'artifact_review.js'), import(${S} + 'inbox_reviews.js')]).then(([A, m]) => { const r = m.reviewItems().find(x => x.name === 'file-2.md'); return A.ignoreRow(r.team, r); }).then(() => true)`);
            await ev(`new Promise(r => setTimeout(r, 1200))`); // sleep-ok: the list and the counts are drawn again
            await agree(`${w}: one put away`, 1, 2);


        }
    } finally { await ev(`fetch('/api/board/${team}', { method: 'DELETE' })`).catch(() => {}); await client.close(); await guard.restore(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('needs_one_number_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
