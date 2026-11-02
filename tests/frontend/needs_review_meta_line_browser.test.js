// A Needs you review row's "version 2 · 1 earlier version" is one unit (#12019, Mobile Beta Tester at 390 and 430): on a phone it started a line with a stray "·" ("· version 2"), at 430 "version 2" floated beside the file's name
// while "· 1 earlier version" wrapped to a line of its own. The two are one nowrap unit with no leading dot on a phone; on a desktop they follow the file's name after a dot, as before.
// A second upload by name (no recorded series), so the row's number comes from its earlier version. 390, 430 and 1280 px. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const team = 'meta-' + Date.now().toString(36), S = `(window.__coralStatic || '/static/')`, T = '#group-table-view';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[390, true], [430, true], [1280, false]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const mk = i => ({ id: hex(i), name: 'sprout-design.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review'], produced_by: 'Lead Developer', review_question: 'Ship it?' });
                const items = [mk(1), mk(2)];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                    if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    return original(url, opts); }; return true; })()`);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 1`, at + 'the row', 15000);
            await ev(framesJs(4));
            const m = await ev(`(() => { const tr = document.querySelector('${T} tbody tr'), v = tr.querySelector('.inbox-review-version'), e = tr.querySelector('.inbox-review-earlier'), meta = tr.querySelector('.inbox-review-meta'), name = tr.querySelector('.inbox-review-name'), when = tr.querySelector('.inbox-row-when');
                if (!v || !e || !meta) return null; const r = x => x.getBoundingClientRect();
                return { version: v.textContent, earlier: e.textContent, sameLine: Math.abs(r(v).top - r(e).top) < 3, metaDot: getComputedStyle(meta, '::before').content, earlierDot: getComputedStyle(e, '::before').content, beside: !!when && Math.abs(r(v).top - r(when).top) < 6 && r(v).left > r(name).right, metaLeft: Math.round(r(meta).left), nameLeft: Math.round(r(name).left) }; })()`);
            check(!!m, at + 'the row has its version and its earlier versions'); if (!m) continue;
            check(m.version === 'version 2' && m.earlier === '1 earlier version', at + 'the words: ' + JSON.stringify([m.version, m.earlier]));
            check(m.sameLine, at + '"version 2" and "1 earlier version" are on one line: ' + JSON.stringify(m));
            check(/·/.test(m.earlierDot), at + 'a dot between them: ' + m.earlierDot);
            if (mobile) check(m.metaDot === 'none' || m.metaDot === 'normal' || m.metaDot === '""', at + 'a phone line does not start with a dot: ' + m.metaDot);
            else check(/·/.test(m.metaDot), at + 'on a desktop a dot follows the file name: ' + m.metaDot);
            if (mobile) check(!m.beside, at + 'the number does not float beside the waiting time: ' + JSON.stringify(m));
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_review_meta_line_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
