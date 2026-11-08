// An edit made in Dropbox, held for the Operator, is an item of the Inbox's Needs you (Dropbox stage 5a piece 3, #14777): one row a held edit with
// Coral's name for the file, "edited in Dropbox", the version Coral saw and that it has not shown what changed; Use as version N, Keep separate and
// Open in Dropbox (a new tab, noopener noreferrer); counted in the Inbox tab's badge; a decision posts once and the row leaves. This computer's
// Dropbox status is stood in at GET /api/dropbox/status and the decision at POST /api/dropbox/edits/{doc}/{action}. 1280, 1440 and 390 px, isolated dev
// server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const A = 'a'.repeat(32), B = 'b'.repeat(32);
const ITEMS = [
    { doc_id: A, name: 'report.md', size: 2048, media_type: 'text/markdown', seen_at: '2026-11-08T10:00:00Z', next_version: 3, dropbox_url: `https://www.dropbox.com/home/Apps/coralhub/v1/aaa/${A}/v2-12345678.md` },
    // a name with a control, zero-width and reordering character: written out, never passed to the page
    { doc_id: B, name: 'plan\u0007\u200b\u202e.md', size: 10, media_type: 'application/octet-stream', seen_at: '2026-11-08T11:00:00Z', next_version: 2, dropbox_url: `https://www.dropbox.com/home/Apps/coralhub/v1/bbb/${B}/v1-87654321.md` },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [1440, 900, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`(() => { const real = window.fetch; const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
                window.__items = ${JSON.stringify(ITEMS)}; window.__posts = [];
                window.fetch = (u, o = {}) => { const p = new URL(String(u && u.url || u), location.origin);
                    if (p.pathname === '/api/dropbox/status') return json({ app_key_set: true, connected: true, state: 'connected', account_id: 'dbid:AAA', edits: { open: window.__items.length, waiting: 0, items: window.__items } });
                    const m = p.pathname.match(/^\\/api\\/dropbox\\/edits\\/([0-9a-f]{32})\\/(promote|separate)$/);
                    if (m && (o.method || 'GET') === 'POST') { window.__posts.push(m[1] + ':' + m[2]); window.__items = window.__items.filter(i => i.doc_id !== m[1]); return json(m[2] === 'promote' ? { decision: 'promoted', version: 3 } : { decision: 'separate', doc_id: 'c'.repeat(32) }); }
                    return real(u, o); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox', { folder: 'needs' }); true`);
            await waitFor(`/report\\.md/.test(document.getElementById('group-table-view')?.innerText || '')`, 'the edit rows in Needs you', 10000);
            const view = await ev(`(() => { const v = document.getElementById('group-table-view'); return { text: v.innerText, html: v.innerHTML }; })()`);
            check(`${tag}: a row names the file and says it was edited in Dropbox`, mobile ? /Edited in Dropbox/.test(view.text) && /report\.md/.test(view.text) : /report\.md was edited in Dropbox/.test(view.text), view.text.slice(0, 300));
            const bad = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
            check(`${tag}: no hidden character reaches the page (written out)`, !bad.test(view.text) && !bad.test(view.html) && /plan<U\+0007><U\+200B><U\+202E>\.md/.test(view.text), JSON.stringify(view.text.match(/plan.{0,40}/)));
            if (!mobile) {
                check(`${tag}: it says the version Coral saw, and that Coral has not shown what changed`, /the version Coral saw on/.test(view.text) && /Coral has not shown you what changed/.test(view.text));
                const row = `Array.from(document.querySelectorAll('#group-table-view tr.dt-row')).find(r => /report\\.md/.test(r.textContent))`;
                const acts = await ev(`(() => { const r = ${row}; return { buttons: Array.from(r.querySelectorAll('button')).map(b => b.textContent.trim()), link: (() => { const a = r.querySelector('a.inbox-dropbox-look'); return a ? { href: a.getAttribute('href'), target: a.target, rel: a.rel } : null; })() }; })()`);
                check(`${tag}: the actions are Use as version 3 and Keep separate`, acts.buttons.includes('Use as version 3') && acts.buttons.includes('Keep separate'), JSON.stringify(acts.buttons));
                check(`${tag}: Open in Dropbox opens Dropbox's own view in a new tab, noopener noreferrer`, acts.link && acts.link.href.startsWith('https://www.dropbox.com/') && acts.link.target === '_blank' && /noopener/.test(acts.link.rel) && /noreferrer/.test(acts.link.rel), JSON.stringify(acts.link));
                check(`${tag}: the Inbox tab counts the held edits`, /^[2-9]\d*$/.test(await ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`)));
                await ev(`(() => { const r = ${row}; Array.from(r.querySelectorAll('button')).find(b => /Use as version/.test(b.textContent)).click(); return true; })()`);
                await waitFor(`window.__posts.length === 1`, 'the decision', 6000);
                check(`${tag}: Use as version posts the promote once`, (await ev(`window.__posts.join(',')`)) === `${A}:promote`);
                await waitFor(`!/report\\.md/.test(document.getElementById('group-table-view').innerText)`, 'the row to leave', 8000);
                check(`${tag}: the decided edit leaves Needs you`, true);
            }
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Dropbox edit Inbox checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
