// The All pill counts every listed row, not "N of M" (#16734, #16778): with one read and one unread review,
// All says "2" (every visible row), the badge is the unread count alone, and the tooltip says "N unread, M in the list".
// Walked at 1280 (desktop pills) and 390 (phone select). Real Chrome against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

const TEAM = 'npill-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, label] of [[1280, 900, false, '1280'], [390, 844, true, '390']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`fetch('/api/board/${TEAM}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'UI/UX', job_title: 'Designer' }) }).then(r => r.status)`);
            await ev(`(async () => { localStorage.removeItem('coral-inbox-needs-filters');
                const mk = (n, name, tags) => ({ id: String(n).padStart(64, '0'), name, media_type: 'text/plain', size: 30, created_at: new Date(Date.now() - n * 60000).toISOString(), tags, available: true, uri: 'coral://artifacts/' + String(n).padStart(64, '0') });
                const arts = [mk(1, 'Read file.md', ['for review', 'read']), mk(2, 'Unread file.md', ['for review'])];
                const original = window.fetch, json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${TEAM}': arts}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                    if (u.pathname === '/api/board/${TEAM}/artifacts') return json({ project: '${TEAM}', artifacts: arts, has_more: false });
                    return original(url, opts); };
                window.__m.agents = {}; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 2`, `${label}: the listed files`, 15000);
            await ev(framesJs(10));

            // the All pill (a desktop's button or a phone's select option)
            const pill = await ev(`(() => {
                const vis = e => !!e && !e.hidden && e.getClientRects().length > 0;
                const pills = [...document.querySelectorAll('.inbox-folder-toolbar [role=tab], .inbox-folder-toolbar .list-bar-pill, .inbox-folder-toolbar button, .inbox-folder-toolbar option')].filter(e => /^All/i.test(e.textContent.trim()));
                const allPill = pills[0]; if (!allPill) return null;
                const text = allPill.textContent.trim().replace(/\\s+/g, ' ');
                return { text, hasOf: / of /i.test(text) };
            })()`);
            assert.ok(pill, `${label}: the All pill is found`);
            assert.ok(!pill.hasOf, `${label}: the All pill has no "of" — it says the total, not "N of M": ${pill.text}`);
            assert.ok(/^All\s+\d/.test(pill.text), `${label}: the All pill is "All N" with just a number: ${pill.text}`);

            // the sidebar badge and tooltip
            const sidebar = await ev(`(() => {
                const item = [...document.querySelectorAll('.view-list-item')].find(b => /Needs you/.test(b.textContent));
                if (!item) return null;
                const cnt = item.querySelector('.view-list-count');
                return { count: cnt ? cnt.textContent.trim() : null, tip: item.title || null, spoken: item.getAttribute('aria-label') || null, alert: !!(cnt && cnt.classList.contains('view-list-alert')) };
            })()`);
            assert.ok(sidebar, `${label}: the sidebar Needs you item is found`);
            assert.equal(sidebar.count, '1', `${label}: the badge is the unread count alone (1 of 2 is unread): ${sidebar.count}`);
            assert.ok(sidebar.alert, `${label}: the badge has the alert colour (something is unread)`);
            assert.ok(/1 unread, 2 in the list/.test(sidebar.tip || ''), `${label}: the tooltip says "1 unread, 2 in the list" (#13979): ${sidebar.tip}`);
            assert.ok(/1 unread, 2 in the list/.test(sidebar.spoken || ''), `${label}: the aria-label says "1 unread, 2 in the list": ${sidebar.spoken}`);

            await shot(`needs-all-pill-${label}`);
        }
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
    console.log('needs_you_all_pill_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
