// A "For review" row in Needs you says who uploaded the file (#11456): "from Lead Developer", with its team when two or more teams wait, "sender unknown" when no uploader is recorded, for a file with a task and for one with none; text only (what hides or
// reorders it is dropped); the opened item says the same in its header. The artifacts and tasks are stubbed. 1280 (the table) and 390 (the phone's rows).
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const stamp = Date.now().toString(36), t1 = 'rf1-' + stamp, t2 = 'rf2-' + stamp;
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const T = '#group-table-view';
    const rowsOf = () => ev(`[...document.querySelectorAll('${T} tbody tr')].map(tr => ({ text: tr.textContent.replace(/\\s+/g, ' ').trim(), sub: [...tr.querySelectorAll('.dt-subtitle, .inbox-review-from')].filter(e => e.getBoundingClientRect().width > 0).map(e => e.textContent).join('|'), visible: [...tr.querySelectorAll('.dt-subtitle, .inbox-review-from')].filter(e => e.getBoundingClientRect().width > 0).length === 1 }))`); // the one line a width shows: under the name on a table, leading the second line on a phone
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            for (const t of [t1, t2]) await ev(`fetch('/api/board/${t}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Review Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`localStorage.removeItem('coral-inbox-needs-filters'); true`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0'), made = n => new Date(Date.now() - n * 3600000).toISOString();
                const item = (n, name, extra) => ({ id: hex(n), name, media_type: 'text/html', size: 30, created_at: made(n), source: 'upload', available: true, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex(n), ...extra });
                const items = { '${t1}': [item(1, 'checkout-mockup.html', { task_id: 5, task_title: 'Review the mockup', session_id: 'writer-a', produced_by: 'Lead Developer' }), item(2, 'guide-role-design.html', { session_id: 'writer-b', produced_by: 'Frontend\\u202e Dev\\u200b' })], '${t2}': [item(3, 'orphan-notes.html', { produced_by: null, session_id: null })] };
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), m = u.pathname.match(/^\\/api\\/board\\/([^/]+)\\/artifacts$/);
                    if (m && items[m[1]]) return json({ project: m[1], artifacts: !u.searchParams.has('tag') || u.searchParams.get('tag') === 'for review' ? items[m[1]] : [], has_more: false });
                    return original(url, opts); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`['checkout-mockup.html', 'guide-role-design.html', 'orphan-notes.html'].every(n => [...document.querySelectorAll('${T} tbody tr')].some(r => r.textContent.includes(n)))`, at + 'the three for-review rows', 15000);
            const rows = await rowsOf(), by = n => rows.find(r => r.text.includes(n)) || { text: '', sub: '', visible: false };
            const tail = t => (mobile ? '' : ` · ${t}`);
            const a = by('checkout-mockup.html'), b = by('guide-role-design.html'), c = by('orphan-notes.html');
            check(a.sub === `from Lead Developer${tail(t1)}`, at + 'a file with a task says who sent it and its team: ' + JSON.stringify(a.sub));
            check(b.sub === `from Frontend<U+202E> Dev<U+200B>${tail(t1)}`, at + 'a file with no task says who sent it too, what hides or reorders the name written out, not drawn: ' + JSON.stringify(b.sub));
            check(c.sub === `sender unknown${tail(t2)}`, at + 'a file with no uploader on record says so: ' + JSON.stringify(c.sub));
            check(a.visible && b.visible && c.visible, at + 'the line is on screen on every row, once');
            check(!mobile || (a.text.includes(t1) && c.text.includes(t2)), at + 'a phone row still names the team after it');
            check(!(await ev(`document.documentElement.scrollWidth > innerWidth + 1`)), at + 'no sideways scroll');
            await shot(`inbox-review-from-${w}`);
            // the opened item says the same in its header
            await ev(`[...document.querySelectorAll('${T} tbody tr button')].find(b => b.getAttribute('aria-label') === 'Open checkout-mockup.html').click(); true`);
            await waitFor(`!!document.querySelector('.artifact-viewer-from') && !document.querySelector('.artifact-viewer-from').hidden`, at + 'the opened item\'s "from" line', 10000).catch(() => {});
            const opened = await ev(`(document.querySelector('.artifact-viewer-from') || {}).textContent || ''`);
            check(opened === `from Lead Developer · ${t1}`, at + 'the opened item says who sent it: ' + JSON.stringify(opened));
            await shot(`inbox-review-from-open-${w}`);
        }
    } finally { await removeBoards(ev, [t1, t2]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('inbox_review_from_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
