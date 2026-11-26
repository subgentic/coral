// #21652: the team label link's 44 px tap area (a transparent ::after on a 15 px line, #21642) must not take taps meant for the controls beside it. At a phone and a tablet width (the phone's rows draw no team link beside a single team's controls, so there the check only proves nothing is stolen) with touch emulation, over the
// Needs you rows: every other control's centre and four points inside its edges hit that control, never the team link; the link is there (so the check is not vacuous), its own centre hits it, and 11 px above and below its centre still hit it (the tap area exists). The area is clipped by its table cell, so it cannot reach another row.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');
const BASE = require('./test_base').BASE;

const TAP = `(() => {
    const links = [...document.querySelectorAll('#group-table-view .team-label-link')].filter(a => a.getBoundingClientRect().width);
    const out = { links: links.length, stolen: [], linkOwn: 0, reach: 0 };
    for (const a of links) { const r = a.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (e && e.closest('a.team-label-link') === a) out.linkOwn++; const up = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2 - 11), down = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2 + 11); if ([up, down].every(x => x && x.closest('a.team-label-link') === a)) out.reach++; }
    for (const el of document.querySelectorAll('#group-table-view button, #group-table-view a[href]:not(.team-label-link), #group-table-view input:not([type=hidden])')) {
        const r = el.getBoundingClientRect(); if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
        const pts = [[r.width / 2, r.height / 2], [4, r.height / 2], [r.width - 4, r.height / 2], [r.width / 2, 4], [r.width / 2, r.height - 4]];
        for (const [dx, dy] of pts) { const x = r.left + dx, y = r.top + dy; const hit = document.elementFromPoint(x, y); if (hit && hit.closest('a.team-label-link')) out.stolen.push((el.getAttribute('aria-label') || el.textContent.trim()).slice(0, 30) + ' @' + Math.round(x) + ',' + Math.round(y)); }
    }
    return out;
})()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await guardSettings(); // the bulk Dismiss on the phone saves inbox_welcome_done to the server: put back at the end (#15755)
    const S = `(window.__coralStatic || '/static/')`, team = 'one-number-' + Date.now().toString(36), problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const w of [390, 820]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 1180, deviceScaleFactor: 2, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Dev', job_title: 'Developer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch.bind(window), json = b => Promise.resolve(Response.json(b)), hex = n => n.toString(16).padStart(64, '0');
                window.__rows = [1, 2, 3].map(i => ({ id: hex(i), name: 'file-' + i + '.md', uri: 'coral://artifacts/' + hex(i), produced_by: 'Dev', session_id: 'p' + i, created_at: new Date(Date.now() - i * 60000).toISOString(), media_type: 'text/markdown', available: true, tags: ['for review'], starred: false, series_id: 'series-' + i, version: 1 }));
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href); if (u.pathname === '/api/team-artifacts') return json(window.__reviewFixturePage(u, location.href, { '${team}': window.__rows })); if (u.pathname === '/api/board/${team}/artifacts') return json({ artifacts: window.__rows, has_more: false }); if (opts.method === 'PUT' && /\\/artifacts\\/[0-9a-f]{64}\\/tags$/.test(u.pathname)) { const row = window.__rows.find(r => u.pathname.includes(r.id)); if (row) row.tags = JSON.parse(opts.body).tags; return json({ ok: true, tags: row ? row.tags : [] }); } if (opts.method === 'POST' && /\\/artifacts\\/[0-9a-f]{64}\\/review$/.test(u.pathname)) { const i = window.__rows.findIndex(r => u.pathname.includes(r.id)); if (i >= 0) window.__rows.splice(i, 1); return json({ ok: true }); } return original(url, opts); }; return true; })()`);
            await ev(`T.state.settings = { ...T.state.settings, inbox_welcome: 'off', inbox_welcome_done: '' }; window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 3`, `${w}: the rows`, 15000);
            await waitFor(`(${w} < 768 || document.querySelectorAll('#group-table-view .team-label-link').length >= 1) && document.querySelectorAll('#group-table-view button').length >= 3`, `${w}: the rows' links and buttons are drawn`, 15000);
            const t = await ev(TAP); if (!t.links) { if (w >= 768) problems.push(w + ': no team link in the rows (the check would be empty)'); } else if (t.linkOwn !== t.links) problems.push(w + ': a team link is covered at its own centre (' + t.linkOwn + ' of ' + t.links + ' hit it)'); if (t.links && t.reach !== t.links) problems.push(w + ': the link has no tap area beyond its 15 px line (' + t.reach + ' of ' + t.links + ' reached 11 px above and below its centre)'); if (t.stolen.length) problems.push(w + ': the team link takes taps meant for other controls (' + t.stolen.length + '): ' + t.stolen.join(' | '));
        }
    } finally { await ev(`fetch('/api/board/${team}', { method: 'DELETE' })`).catch(() => {}); await client.close(); await guard.restore(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('PASS team_link_tap_area_browser: the 44 px link area leaves the controls beside it their taps');

})().catch(e => { console.error(e); process.exit(1); });