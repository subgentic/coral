// Needs you counts from one number (#15118, Beta walk 3 N5, N6, N24): the Inbox badge, the folder's count, the list's title, the All chip and the words 'N unread, M in the list' say the same two numbers (unread, listed), with the
// welcome tiles in neither, before and after one of the files is put away.
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
            await ev(`T.state.settings = { ...T.state.settings, inbox_welcome: 'on', inbox_welcome_done: '' }; window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 4`, `${w}: the rows`, 15000);
            await ev(`new Promise(r => setTimeout(r, 600))`); // sleep-ok: the list settles
            const numbers = () => ev(`(() => { const txt = e => e.textContent.replace(/\\s+/g, ' ').trim(), all = [...document.querySelectorAll('button.goals-chip')].map(txt).find(t => /^All/.test(t)) || '', row = [...document.querySelectorAll('.view-list-item')].find(r => /Needs you/.test((r.querySelector('.view-list-label') || {}).textContent || ''));
                return { badge: (document.getElementById('nav-tab-hub-inbox-badge') || {}).textContent, chip: all, folder: row ? row.getAttribute('aria-label') : '', rows: [...document.querySelectorAll('#group-table-view tbody tr')].filter(tr => !tr.querySelector('.inbox-welcome-name')).length }; })()`);
            // what each says: the chip is always 'All N' (every visible row, #16734) and the folder says 'Needs you, N unread, M in the list' or 'Needs you, N' when they match
            const read = n => { const chip = /^All (\d+)(?: of (\d+))?$/.exec(n.chip), words = /(\d+) unread, (\d+) in the list/.exec(n.folder || ''), plain = /^Needs you, (\d+)$/.exec(n.folder || '');
                return { badge: Number(n.badge || 0), chip: chip ? [Number(chip[1]), Number(chip[2] || chip[1])] : null, words: words ? [Number(words[1]), Number(words[2])] : plain ? [Number(plain[1]), Number(plain[1])] : null, rows: n.rows }; };
            const agree = (at, unread, listed) => waitFor(`(() => 1)()`, at, 100).then(async () => { const n = read(await numbers()); const ok = n.badge === unread && n.chip && n.chip[0] === listed && n.chip[1] === listed && n.words && n.words[0] === unread && n.words[1] === listed && n.rows === listed; if (!ok) problems.push(`${at}: the badge, the chip, the folder's words and the rows are not ${unread} unread of ${listed}: ` + JSON.stringify(n)); });
            await agree(`${w}: three files, none read`, 3, 3);
            await ev(`import(${S} + 'inbox_reviews.js').then(m => { const r = m.reviewItems().find(x => x.name === 'file-1.md'); return m.setReviewRead(r, true); }).then(() => true)`);
            await ev(`new Promise(r => setTimeout(r, 800))`); // sleep-ok: the counts are drawn again
            await agree(`${w}: one read`, 2, 3);
            await ev(`Promise.all([import(${S} + 'artifact_review.js'), import(${S} + 'inbox_reviews.js')]).then(([A, m]) => { const r = m.reviewItems().find(x => x.name === 'file-2.md'); return A.ignoreRow(r.team, r); }).then(() => true)`);
            await ev(`new Promise(r => setTimeout(r, 1200))`); // sleep-ok: the list and the counts are drawn again
            await agree(`${w}: one put away`, 1, 2);
            if (w === 390) { // a bulk Dismiss that cannot put one away says which: the welcome tile with only Got it (N6)
                await ev(`T.state.settings = { ...T.state.settings, inbox_welcome: 'on', inbox_welcome_done: '' }; import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return true; })`);
                await ev(`new Promise(r => setTimeout(r, 600))`); // sleep-ok: the list is drawn again
                const names = await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(r => r.textContent.replace(/\\s+/g, ' ').trim().slice(0, 50))`);
                const pickRow = async match => { await ev(`(() => { const row = [...document.querySelectorAll('#group-table-view tbody tr')].find(r => ${match}), pick = row.querySelector('button[role="checkbox"], .dt-check input'); pick.click(); return true; })()`); await ev(`new Promise(r => setTimeout(r, 300))`); }; // sleep-ok: the rows are drawn again when selecting starts
                await pickRow(`/file-3/.test(r.textContent)`);
                await pickRow(`!!r.querySelector('.inbox-welcome-name') && [...r.querySelectorAll('button')].some(b => b.textContent === 'Got it')`);
                await waitFor(`!!document.querySelector('.dt-bar') && /2 selected/.test(document.querySelector('.dt-bar').textContent)`, 'two selected in the bar', 8000);
                await ev(`[...document.querySelectorAll('.dt-bar button')].find(b => (b.getAttribute('aria-label') || b.textContent).trim().startsWith('Dismiss')).click(); true`);
                await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Dismissed 1 of 2/.test(t.textContent))`, 'the toast says Dismissed 1 of 2', 8000).catch(() => {});
                const toast = await ev(`[...document.querySelectorAll('.toast')].map(t => t.textContent.replace(/\\s+/g, ' ').trim()).join(' | ')`);
                const gotIt = await ev(`(() => { const row = [...document.querySelectorAll('#group-table-view tbody tr')].find(r => r.querySelector('.inbox-welcome-name') && [...r.querySelectorAll('button')].some(b => b.textContent === 'Got it')); return row ? (row.querySelector('.inbox-welcome-name').textContent || '').trim() : ''; })()`);
                if (!/Dismissed 1 of 2/.test(toast) || /that one/.test(toast) || !gotIt || !toast.includes(gotIt.slice(0, 20))) problems.push(`${w}: the toast names the item that could not be dismissed (${JSON.stringify(gotIt)}): ` + JSON.stringify(toast) + ' rows ' + JSON.stringify(names));
            }

        }
    } finally { await ev(`fetch('/api/board/${team}', { method: 'DELETE' })`).catch(() => {}); await client.close(); await guard.restore(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('needs_one_number_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
