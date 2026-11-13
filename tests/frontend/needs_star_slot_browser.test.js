// A starred row in Needs you keeps its text out from under the star (#14968, the Operator: the star sat on 'dropbox-share-' in the description of 'dropbox-share-mock.html'): the star has its own room at the end of the row, so no line of the row's text, the
// name, the question, the uploader or the version line, reaches under it, however long the question is. #15084 (the Operator, v2.0.63 Mac app: the star still sat on the subtitle): measured at every width from 1920 to 320 px,
// for a starred and an unstarred row, on the text that is SEEN (a line cut by its box's overflow is clipped first), and the star must sit inside its row's cell (a folded row is a card: its top right, #15540).
'use strict';
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'star-slot-' + Date.now().toString(36);
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        let loadedMobile = null; // one page load per device kind, not per width (#15994: eleven full loads in one suite met the 30 s load timeout under a full run): a width change is a resize of the loaded page, which re-lays the rows out
        for (const [width, theme] of [1920, 1440, 1280, 1100, 1024, 900, 820, 768, 600, 390, 320].map(w => [w, 'light'])) {
            const at = `${width} px ${theme}: `;
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width <= 760 }); await Emulation.setTouchEmulationEnabled({ enabled: width <= 760 });
            if (loadedMobile !== (width <= 760)) { loadedMobile = width <= 760; await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings'); }
            else await ev(`(() => { window.switchNavTab('agents'); return true; })()`); // leave the inbox so the next select renders the rows afresh at this width
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
                    const seen = (r, node) => { let c = { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; for (let el = node.parentElement; el && el !== row; el = el.parentElement) { if (getComputedStyle(el).overflow === 'visible') continue; const b = el.getBoundingClientRect(); c = { left: Math.max(c.left, b.left), right: Math.min(c.right, b.right), top: Math.max(c.top, b.top), bottom: Math.min(c.bottom, b.bottom) }; } return c.right > c.left && c.bottom > c.top ? c : null; };
                    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let n; while ((n = walker.nextNode())) { if (!n.textContent.trim() || star.contains(n)) continue; const range = document.createRange(); range.selectNodeContents(n); for (const r of range.getClientRects()) { const v = r.width && seen(r, n); if (v && hit(v, sr)) out.push(n.textContent.trim().slice(0, 30) + ' in ' + n.parentElement.className); } }
                    const wide = innerWidth > 760, cr = (wide && !row.closest('.dt-folded') ? star.closest('td') : row).getBoundingClientRect(); if (sr.left < cr.left - 1 || sr.right > cr.right + 1) out.push('the star leaves its ' + (wide ? 'cell' : 'card'));
                    const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)].join(','); }, anchor = star.parentElement;
                    return { star: [Math.round(sr.left), Math.round(sr.top), Math.round(sr.right), Math.round(sr.bottom)], under: out, anchor: anchor.className + ' ' + box(anchor), cell: box(star.closest('td')), name: box(anchor.querySelector('.inbox-review-name')), ctx: box(anchor.querySelector('.inbox-pinned-context')), kids: [...anchor.children].map(c => c.className.split(' ')[0] + ' ' + box(c)).join(' | '), rowCells: [...row.children].map(c => box(c)).join(' ; ') }; }); })()`);
            if (!over.length || over.some(o => o.under.length)) problems.push(`${at}text runs under the star: ${JSON.stringify(over)}`);
        }
    } finally { await Promise.race([removeBoards(ev, [team]).catch(() => {}), new Promise(r => setTimeout(r, 15000))]); /* sleep-ok: the cap on a cleanup that a stalled page would hold */ await client.close().catch(() => {}); } // a page that stalled must not hold the cleanup (or the board) for the rest of the suite's budget
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('needs_star_slot_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
