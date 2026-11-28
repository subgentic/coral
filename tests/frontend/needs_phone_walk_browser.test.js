// The v2.0.23 phone walk's three findings on a Needs you row (#11775, #11776), at 390 px with a real file of three versions: "2 earlier versions" is on the row (it was pushed out of sight by the file's name), the sender is not cut
// ("Orchestrat…") while there is room beside it, and a short question to the Operator is said once, not as the row's name and again under it. Review rows and an operator question stubbed in the page. Drives Chrome over CDP through agent_view_harness.js.
// On the ledger (#22094): the row of three versions says "version 3" beside the file's name, and the check is that those words are seen inside the row at every width (the old "2 earlier versions" line and the phone's "v3" pill are gone with the table). A file row names its agent by the avatar at the side, so "the sender is not cut" became "the avatar is drawn inside the row and its label is the whole name, Orchestrator". The question is still said once on its row.
// Retired on the ledger (#22094): the screen-reader words "2 earlier versions" (#13911): the ledger keeps one row per file and says its version; earlier versions are listed in the file viewer (covered by inbox_review_versions_browser).
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'walk-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-group-mode', 'none'); localStorage.setItem('coral-inbox-group-review-goal', 'false');` }); // Group by None: no folded goal group over the file
        for (const [w, h, mobile] of [[390, 800, true], [360, 800, true], [1440, 800, false]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Orchestrator', job_title: 'Orchestrator' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const v = i => ({ id: hex(i), name: 'plan.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review'], produced_by: 'Orchestrator', review_question: 'Is the launch plan ready to go to the whole team, with the three milestones as written, and who should announce it first?' });
                const items = [v(1), v(2), v(3)];
                window.__asks = [{ board: '${team}', kind: 'ask', id: 41, asker: 'Lead', text: 'Which port should the test server use?', at: '2026-10-31T01:00:00Z' }];
                window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': items}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                    if (u.pathname === '/api/operator-asks') return json(window.__asks);
                    if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    return original(url, opts); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await ev(`import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} .nl-row').length === 2`, at + 'one row for the three versions and one for the question', 15000);
            await ev(framesJs(4));
            await shot(`needs-phone-walk-${w}`);
            const m = await ev(`(() => { const rows = [...document.querySelectorAll('${T} .nl-row')], plan = rows.find(r => r.textContent.includes('plan.md')), ask = rows.find(r => r.textContent.includes('Which port')), box = plan.getBoundingClientRect(), inside = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.left >= box.left - 1 && b.right <= box.right + 1 && b.top >= box.top - 1 && b.bottom <= box.bottom + 1; };
                const version = plan.querySelector('.nl-version'), from = plan.querySelector('.nl-side .goal-decision-agent-icon');
                return { version: version ? version.textContent.trim() : null, versionSeen: !!version && inside(version) && version.scrollWidth <= version.clientWidth + 1,
                    from: from ? (from.getAttribute('aria-label') || from.title || '') : null, fromSeen: !!from && inside(from),
                    askText: ask.textContent.replace(/\\s+/g, ' '), askCount: (ask.textContent.match(/Which port should the test server use\\?/g) || []).length }; })()`);
            check(m.version === 'version 3', at + 'the row of three versions says "version 3": ' + JSON.stringify(m));
            check(m.versionSeen, at + 'and the words are inside the row, not pushed out of it: ' + JSON.stringify(m));
            check(m.from === 'Orchestrator' && m.fromSeen, at + 'the sender is shown whole: the avatar is inside the row and named Orchestrator: ' + JSON.stringify([m.from, m.fromSeen]));
            check(m.askCount === 1, at + `a short question is said once on its row (${m.askCount} times): ${m.askText.slice(0, 160)}`);
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_phone_walk_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
