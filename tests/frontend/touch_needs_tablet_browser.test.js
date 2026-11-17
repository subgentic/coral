// Touch census of the Needs you list on a tablet (walk 80 item 10, #17694): at 820 x 1180 with a coarse pointer every visible button, link or field in the list is 44 x 44 CSS px (the compact card's 32 px file name and its 40 and 35 px Save for later and Star buttons were for a mouse).
// Needs you counts from one number (#15118, Beta walk 3 N5, N6, N24): the Inbox badge, the folder's count, the list's title, the All chip and the words 'N unread, M in the list' say the same two numbers (unread, listed), with the
// welcome tiles in neither, before and after one of the files is put away.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');
const BASE = require('./test_base').BASE;

const UNDERSIZED = `(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, a[href], [role=button], input:not([type=hidden]), select, summary, [onclick], [data-on-click]')) {
        // A checkbox or radio inside its label is tapped through the label.
        const hit = el.matches('input[type=checkbox], input[type=radio]') && el.closest('label') ? el.closest('label') : el;
        const r = hit.getBoundingClientRect(); const cs = getComputedStyle(el);
        if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none') continue;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        // A dense glyph button (.btn-xs) keeps a 24 px box and is a 44 px target through its transparent ::after (#9332).
        // It counts only when it is invisible (no fill, no border) and centred on the control: an inset of -10px on a 24 px box, not any absolute pseudo-element.
        const after = getComputedStyle(el, '::after'); let w = r.width, h = r.height;
        const left = parseFloat(after.left), top = parseFloat(after.top), aw = parseFloat(after.width), ah = parseFloat(after.height);
        const invisible = after.backgroundColor === 'rgba(0, 0, 0, 0)' && parseFloat(after.borderTopWidth) === 0 && after.backgroundImage === 'none';
        const centred = Math.abs((left + aw / 2) - r.width / 2) <= 1 && Math.abs((top + ah / 2) - r.height / 2) <= 1;
        if (after.content !== 'none' && after.position === 'absolute' && invisible && centred) { w = Math.max(w, aw || 0); h = Math.max(h, ah || 0); }
        if (w >= 44 && h >= 44) continue;
        out.push(Math.round(r.width) + 'x' + Math.round(r.height) + ' ' + (el.id ? '#' + el.id : el.className) + ' [' + (el.getAttribute('aria-label') || el.title || el.textContent.trim()).slice(0, 30) + ']');
    }
    return out;
})()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await guardSettings(); // the bulk Dismiss on the phone saves inbox_welcome_done to the server: put back at the end (#15755)
    const S = `(window.__coralStatic || '/static/')`, team = 'one-number-' + Date.now().toString(36), problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const w of [820]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 1180, deviceScaleFactor: 2, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Dev', job_title: 'Developer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch.bind(window), json = b => Promise.resolve(Response.json(b)), hex = n => n.toString(16).padStart(64, '0');
                window.__rows = [1, 2, 3].map(i => ({ id: hex(i), name: 'file-' + i + '.md', uri: 'coral://artifacts/' + hex(i), produced_by: 'Dev', session_id: 'p' + i, created_at: new Date(Date.now() - i * 60000).toISOString(), media_type: 'text/markdown', available: true, tags: ['for review'], starred: false, series_id: 'series-' + i, version: 1 }));
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href); if (u.pathname === '/api/team-artifacts') return json(window.__reviewFixturePage(u, location.href, { '${team}': window.__rows })); if (u.pathname === '/api/board/${team}/artifacts') return json({ artifacts: window.__rows, has_more: false }); if (opts.method === 'PUT' && /\\/artifacts\\/[0-9a-f]{64}\\/tags$/.test(u.pathname)) { const row = window.__rows.find(r => u.pathname.includes(r.id)); if (row) row.tags = JSON.parse(opts.body).tags; return json({ ok: true, tags: row ? row.tags : [] }); } if (opts.method === 'POST' && /\\/artifacts\\/[0-9a-f]{64}\\/review$/.test(u.pathname)) { const i = window.__rows.findIndex(r => u.pathname.includes(r.id)); if (i >= 0) window.__rows.splice(i, 1); return json({ ok: true }); } return original(url, opts); }; return true; })()`);
            await ev(`T.state.settings = { ...T.state.settings, inbox_welcome: 'off', inbox_welcome_done: '' }; window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 3`, `${w}: the rows`, 15000);
            await ev(`new Promise(r => setTimeout(r, 600))`); // sleep-ok: the list settles
            const l = await ev(UNDERSIZED); if (l.length) problems.push('controls under 44 px (' + l.length + '): ' + l.join(' | '));
        }
    } finally { await ev(`fetch('/api/board/${team}', { method: 'DELETE' })`).catch(() => {}); await client.close(); await guard.restore(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('touch_needs_tablet_browser: ok');

})().catch(e => { console.error(e); process.exit(1); });