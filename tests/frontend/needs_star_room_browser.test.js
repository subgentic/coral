// A starred row in Needs you keeps its text out from under the star (#14968, the Operator: the star sat on 'dropbox-share-' in the description of 'dropbox-share-mock.html'): the star has its own room at the end of the row, so no line of the row's text, the
// name, the question, the uploader or the version line, reaches under it, however long the question is. Measured at 1280 and 390 px, light and dark, for a starred and an unstarred row.
'use strict';
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'star-room-' + Date.now().toString(36);
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, theme] of [[1280, 'light'], [390, 'light'], [1280, 'dark'], [390, 'dark']]) {
            const at = `${width} px ${theme}: `;
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width <= 760 }); await Emulation.setTouchEmulationEnabled({ enabled: width <= 760 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Dev', job_title: 'Developer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch.bind(window), json = b => Promise.resolve(Response.json(b)), hex = n => n.toString(16).padStart(64, '0');
                const question = 'Share via Dropbox: one item in a file\\u2019s More actions menu and beside chat Export. Does this look right? Reply with what to change and I will send the next version of it straight away.';
                window.__rows = [1, 2].map(i => ({ id: hex(i), name: i === 1 ? 'dropbox-share-mock.html' : 'notes.md', uri: 'coral://artifacts/' + hex(i), produced_by: 'Dropbox Integration', session_id: 'same-producer', created_at: new Date(Date.now() - i * 60000).toISOString(), media_type: 'text/html', available: true, tags: ['for review'], starred: i === 1, series_id: 'series-' + i, version: 1, review_question: question, file_id: 'ec8282a07c78342642f226811dd0c0e3', version_line: 'version 1 of ' + (i === 1 ? 'dropbox-share-mock.html' : 'notes.md') + ' (file ec8282a07c78342642f226811dd0c0e3)' }));
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href); if (u.pathname === '/api/team-artifacts') return json(window.__reviewFixturePage(u, location.href, { '${team}': window.__rows })); if (u.pathname === '/api/board/${team}/artifacts') return json({ artifacts: window.__rows, has_more: false }); return original(url, opts); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('.inbox-needs-results .dt-row').length >= 2 && !!document.querySelector('.inbox-review-star')`, `${at}the two rows, one starred`, 15000);
            await ev(`new Promise(r => setTimeout(r, 400))`); // sleep-ok: the row's layout settles after its fonts and the table's width
            const over = await ev(`(() => { const hit = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
                return [...document.querySelectorAll('.inbox-needs-results .inbox-review-star')].map(star => { const sr = star.getBoundingClientRect(), row = star.closest('tr'), out = [];
                    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let n; while ((n = walker.nextNode())) { if (!n.textContent.trim() || star.contains(n)) continue; const range = document.createRange(); range.selectNodeContents(n); for (const r of range.getClientRects()) if (r.width && hit(r, sr)) out.push(n.textContent.trim().slice(0, 30) + ' in ' + n.parentElement.className); }
                    return { star: [Math.round(sr.left), Math.round(sr.top), Math.round(sr.right), Math.round(sr.bottom)], under: out }; }); })()`);
            if (!over.length || over.some(o => o.under.length)) problems.push(`${at}text runs under the star: ${JSON.stringify(over)}`);
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('needs_star_room_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
