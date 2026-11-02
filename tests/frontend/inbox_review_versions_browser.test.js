// Needs you shows ONE row per artifact (#11533, the operator's report): the versions of one artifact (the same uploader, team and name) are one row, the newest, with "N earlier versions" in its line; the count, the badge and
// the rows follow; a file with the same name from another uploader, and another file of the same uploader, are their own rows. Approve acts on the newest (one review, the agent told once) and settles the earlier versions quietly
// (their 'for review' tag comes off through the tags route, no review and no message), so none of them comes back as the newest; when one of those writes fails the person is told and that version stays. The team's artifacts and
// the writes are stubbed in the page. 1280 (the table) and 390 (the phone's rows).
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'ver-' + Date.now().toString(36), team2 = team + 'b';
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const T = '#group-table-view';
    const S = `(window.__coralStatic || '/static/')`;
    const hex = n => n.toString(16).padStart(64, '0');
    const rowsOf = () => ev(`[...document.querySelectorAll('${T} tbody tr')].map(tr => ({ text: tr.textContent.replace(/\\s+/g, ' ').trim(), id: (tr.querySelector('[data-review-artifact]') || {}).dataset ? tr.querySelector('[data-review-artifact]').dataset.reviewArtifact : '' }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Security Reviewer', job_title: 'Security' }) }).then(r => r.status)`);
            await ev(`fetch('/api/board/${team2}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Security Reviewer', job_title: 'Security' }) }).then(r => r.status)`);
            // four versions of design.md (ids 1 to 4, the newest 4), another file of the same uploader (5) and a design.md from someone else (6)
            await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0'), made = n => new Date(Date.now() - n * 3600000).toISOString();
                const item = (n, name, by, session, age, t = '${team}') => ({ team: t, id: hex(n), name, media_type: 'text/markdown', size: 30, created_at: made(age), source: 'upload', available: true, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex(n), produced_by: by, session_id: session });
                window.__rv = { calls: [], failTags: '', items: [item(1, 'design.md', 'Security Reviewer', 's1', 8), item(2, 'design.md', 'Security Reviewer', 's1', 6), item(3, 'design.md', 'Security Reviewer', 's1', 4), item(4, 'design.md', 'Security Reviewer', 's1', 2), item(5, 'notes.md', 'Security Reviewer', 's1', 3), item(6, 'design.md', 'Other Dev', 's2', 1), item(7, 'z', 'A|n', '', 5), item(8, 'n|z', 'A', '', 7), item(9, 'design.md', 'Security Reviewer', 's1', 9, '${team2}')] };
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), m = u.pathname.match(/^\\/api\\/board\\/(${team}|${team2})\\/artifacts(?:\\/([0-9a-f]{64})\\/(review|tags))?$/), st = window.__rv;
                    if (!m) return original(url, opts);
                    if (!m[2]) return json({ project: m[1], artifacts: st.items.filter(a => a.team === m[1] && (!u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag')))), has_more: false });
                    const it = st.items.find(a => a.team === m[1] && a.id === m[2]), body = opts.body ? JSON.parse(opts.body) : {};
                    st.calls.push({ team: m[1], route: m[3], id: m[2], body });
                    if (m[3] === 'review') { it.tags = it.tags.filter(t => t !== 'for review').concat('approved'); return json({ id: it.id, state: 'approved', changed: true, tags: it.tags, delivered: true, to: 'Security Reviewer', review: { state: 'approved', at: new Date().toISOString() } }); }
                    if (st.failTags === m[2]) return json({ error: 'no' }, 500);
                    it.tags = body.tags; return json({ id: it.id, tags: it.tags });
                };
                return true; })()`);
            await ev(`localStorage.removeItem('coral-inbox-needs-filters'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 6`, at + 'the review rows', 15000);
            let rows = await rowsOf();
            check(rows.length === 6, at + 'nine uploads are six rows: the four versions of design.md are one, notes.md is one, design.md of another uploader is one, two whose fields would run together with a | are two, and the same uploader and name on ANOTHER team is its own: ' + JSON.stringify(rows.map(r => r.text.slice(0, 60))));
            const design = rows.find(r => r.id === hex(4));
            check(!!design && /3 earlier versions/.test(design.text), at + 'the row of design.md is the NEWEST version and says "3 earlier versions": ' + JSON.stringify(design));
            check(!!design && /· version 4/.test(design.text), at + 'the newest row says "· version 4" even when the artifacts list carries no series (#12081: it said only "3 earlier versions"): ' + JSON.stringify(design));
            check(!rows.some(r => [hex(1), hex(2), hex(3)].includes(r.id)), at + 'no older version is a row of its own');
            check(rows.filter(r => /earlier version/.test(r.text)).length === 1, at + 'only the artifact with earlier versions says so (the two whose fields run together are not versions of one another)');
            check(await ev(`(() => { const c = [...document.querySelectorAll('.view-list-item')].filter(r => /Needs you$/.test((r.querySelector('.view-list-label') || {}).textContent || '')).map(r => (r.querySelector('.view-list-count') || {}).textContent); return c.length > 0 && c.every(x => x === '6'); })()`) || mobile, at + 'the Needs you folder counts six, not nine');
            await shot(`inbox-review-versions-${w}`);
            // Approve the newest version of design.md: one review, for the newest; the three before it are settled by the tags route, with the other tags kept
            await ev(`[...document.querySelectorAll('${T} tbody tr')].find(tr => tr.querySelector('[data-review-artifact="${hex(4)}"]')).querySelector('button[aria-label^="Approve"]').click(); true`);
            await waitFor(`window.__rv.calls.filter(c => c.route === 'tags').length >= 3`, at + 'the earlier versions are settled', 10000).catch(() => {});
            const calls = await ev(`window.__rv.calls`);
            const reviews = calls.filter(c => c.route === 'review'), tagsCalls = calls.filter(c => c.route === 'tags');
            check(reviews.length === 1 && reviews[0].id === hex(4) && reviews[0].body.decision === 'approve', at + 'one review, of the newest version: ' + JSON.stringify(reviews));
            check(tagsCalls.length === 3 && [hex(1), hex(2), hex(3)].every(id => tagsCalls.some(c => c.id === id && !c.body.tags.includes('for review') && c.body.tags.includes('internal'))), at + 'each earlier version loses only its "for review" tag: ' + JSON.stringify(tagsCalls));
            check(calls.every(c => c.team === team && c.id !== hex(9)), at + "approving one team's design.md writes nothing to the other team's copy: " + JSON.stringify(calls.filter(c => c.id === hex(9))));
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 5`, at + 'the design row is gone', 10000).catch(() => {});
            await ev(`import(${S} + 'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true)`); await ev(`new Promise(r => setTimeout(r, 600))`); // sleep-ok: the list is read again; none of the earlier versions comes back
            rows = await rowsOf();
            check(rows.length === 5 && rows.some(r => r.id === hex(9)) && !rows.some(r => [hex(1), hex(2), hex(3), hex(4)].includes(r.id)), at + 'after a fresh read no version of design.md is back: ' + JSON.stringify(rows.map(r => r.text.slice(0, 50))));

            // one of the writes fails: the newest is approved, the person is told, and that version stays (it is the newest left)
            await ev(`(() => { const st = window.__rv; for (const a of st.items) if (a.name === 'design.md' && a.session_id === 's1') a.tags = ['for review', 'internal']; st.calls = []; st.failTags = '${hex(2)}'; return import(${S} + 'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true); })()`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 6`, at + 'the versions are back for the second case', 10000);
            await ev(`[...document.querySelectorAll('${T} tbody tr')].find(tr => tr.querySelector('[data-review-artifact="${hex(4)}"]')).querySelector('button[aria-label^="Approve"]').click(); true`);
            await waitFor(`/could not be cleared/.test(document.body.innerText)`, at + 'the person is told an earlier version could not be cleared', 10000).catch(() => {});
            await ev(`import(${S} + 'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true)`); await ev(`new Promise(r => setTimeout(r, 600))`); // sleep-ok: the list is read again
            rows = await rowsOf();
            check(rows.some(r => r.id === hex(2)) && !rows.some(r => r.id === hex(4)), at + 'the version that could not be cleared stays as a row and the approved one is gone: ' + JSON.stringify(rows.map(r => r.id.slice(-2))));
            check(!(await ev(`document.documentElement.scrollWidth > innerWidth + 1`)), at + 'no sideways scroll');
        }
    } catch (e) { failures.push('stopped: ' + e.message); } finally { await removeBoards(ev, [team, team2]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('inbox_review_versions_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
