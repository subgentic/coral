// #11937 (the Operator's screenshots): a file with several versions is ONE row in Needs you (the newest, "N earlier versions"), so a row action applies to the whole file: Save for later, Ignore and Deny take every
// version out of Needs you together (before, only the newest was saved and the version before it came up as the row), and Move to Needs you brings the file back as one row. Saved lists one row per file too, the
// newest with "N earlier versions" (two versions saved on their own, as the Operator's list had them, are one row). Board routes stubbed in the page, a three-version file; 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const team = 'versions-' + Date.now().toString(36);
const id = n => n.toString(16).padStart(64, '0');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const needs = () => ev(`[...document.querySelectorAll('#group-table-view [data-review-artifact]')].map(a => a.closest('tr').textContent.replace(/\\s+/g, ' ').trim())`);
    const decisions = () => ev(`window.__decisions.map(d => d.decision + ':' + (parseInt(d.id, 16)))`);
    const openNeeds = async () => { await ev(`window.switchNavTab('hub-inbox'); true`); await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`); };
    const openSaved = async () => { await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('saved')).then(() => true)`); };
    const refresh = () => ev(`import((window.__coralStatic||'/static/')+'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        assert.equal(await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Writer',job_title:'Writer',session_name:'writer-${team}'})}).then(r=>r.status)`), 200);
        await ev(`(() => {
            localStorage.removeItem('coral-inbox-needs-filters');
            window.__decisions = [];
            const mk = (n, mins, tags) => ({ id: '${''}' + n.toString(16).padStart(64, '0'), name: 'Design note.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - mins * 60000).toISOString(), task_id: 0, source: 'upload', available: true, session_id: 'writer-s', produced_by: 'Writer', tags, uri: 'coral://artifacts/' + n.toString(16).padStart(64, '0') });
            window.__items = [mk(1, 30, ['for review', 'internal']), mk(2, 20, ['for review', 'internal']), mk(3, 10, ['for review', 'internal'])];
            const R = window.fetch, json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), m = (opts.method || 'GET').toUpperCase();
                if (u.pathname === '/api/board/${team}/artifacts' && m === 'GET') { const t = u.searchParams.get('tag'); const list = window.__items.filter(a => !t || a.tags.includes(t)); return json({ project: '${team}', artifacts: list, has_more: false }); }
                if (u.pathname.startsWith('/api/board/${team}/artifacts/') && u.pathname.endsWith('/review') && m === 'POST') { const hex = u.pathname.split('/').at(-2), body = JSON.parse(opts.body), it = window.__items.find(a => a.id === hex); window.__decisions.push({ id: hex, decision: body.decision });
                    /* ignore swaps for review and ignored as the real route does (IgnoreArtifactReview) */ const add = t => { if (!it.tags.includes(t)) it.tags.push(t); }, del = t => { it.tags = it.tags.filter(x => x !== t); };
                    if (body.decision === 'save') { add('saved'); del('read'); } else if (body.decision === 'unsave') del('saved'); else if (body.decision === 'ignore') { del('for review'); del('saved'); add('ignored'); } else if (body.decision === 'unignore') { del('ignored'); add('for review'); } else if (body.decision === 'deny') { del('for review'); del('read'); add('denied'); }
                    return json({ id: hex, state: body.decision, changed: true, tags: it.tags, review: null, delivered: false }); }
                if (u.pathname.startsWith('/api/board/${team}/artifacts/') && u.pathname.endsWith('/tags') && m === 'PUT') { const hex = u.pathname.split('/').at(-2); window.__items.find(a => a.id === hex).tags = JSON.parse(opts.body).tags; window.__decisions.push({ id: hex, decision: 'tags' }); return json({ tags: JSON.parse(opts.body).tags }); }
                if (u.pathname.startsWith('/api/artifacts/') && /^[0-9a-f]{64}$/.test(u.pathname.split('/')[3])) return Promise.resolve(new Response('preview', { headers: { 'Content-Type': 'text/plain' } }));
                return R(url, opts); };
            return true; })()`);
        await openNeeds(); await refresh();
        await waitFor(`document.querySelectorAll('#group-table-view [data-review-artifact]').length === 1`, 'one row for the three versions', 10000);
        let rows = await needs();
        assert.ok(rows.length === 1 && /2 earlier versions/.test(rows[0]), 'the file is one row with its earlier versions: ' + JSON.stringify(rows));

        // Save for later: every version leaves Needs you, together
        await ev(`document.querySelector('#group-table-view tbody tr .inbox-bookmark').click(); true`);
        await waitFor(`document.querySelectorAll('#group-table-view [data-review-artifact]').length === 0 && window.__decisions.length >= 3`, 'the file left Needs you', 8000);
        assert.deepEqual((await decisions()).sort(), ['save:1', 'save:2', 'save:3'], 'the save went to all three versions');
        await refresh();
        assert.deepEqual(await needs(), [], 'no earlier version comes up as the row');
        await openSaved(); await refresh();
        await waitFor(`document.querySelectorAll('.saved-files tbody tr').length === 1`, 'Saved lists the file once', 8000);
        const saved = await ev(`[...document.querySelectorAll('.saved-files tbody tr')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
        assert.ok(saved.length === 1 && /2 earlier versions/.test(saved[0]), 'one Saved row, the newest with its earlier versions: ' + JSON.stringify(saved));

        // Move to Needs you: back as one row
        await ev(`window.__decisions.length = 0; const r = document.querySelector('.saved-files tbody tr'); r.querySelector('[data-slot=dots] button, button[aria-haspopup=menu]').click(); true`);
        await waitFor(`!![...document.querySelectorAll('.saved-files .menu-item')].find(b => /Move to Needs you/.test(b.textContent))`, 'the menu', 4000);
        await ev(`[...document.querySelectorAll('.saved-files .menu-item')].find(b => /Move to Needs you/.test(b.textContent)).click(); true`);
        await waitFor(`window.__decisions.length >= 3`, 'unsave went to every version', 8000);
        assert.deepEqual((await decisions()).sort(), ['unsave:1', 'unsave:2', 'unsave:3']);
        await openNeeds(); await refresh();
        await waitFor(`document.querySelectorAll('#group-table-view [data-review-artifact]').length === 1`, 'back as one row', 8000);
        assert.ok(/2 earlier versions/.test((await needs())[0]), 'with its earlier versions');

        // Ignore: all of them
        await ev(`window.__decisions.length = 0; [...document.querySelectorAll('#group-table-view tbody tr button')].find(b => /^Ignore: /.test(b.getAttribute('aria-label') || '')).click(); true`);
        await waitFor(`window.__decisions.length >= 3`, 'the ignore went to every version', 8000);
        assert.deepEqual((await decisions()).sort(), ['ignore:1', 'ignore:2', 'ignore:3']);
        await refresh();
        assert.deepEqual(await needs(), [], 'nothing of the file is left in Needs you');
        // Deny: the newest is denied (the agent is told once), the older versions leave Needs you quietly with it
        await ev(`window.__decisions.length = 0; window.__items.forEach(a => { a.tags = ['for review', 'internal']; }); true`); await refresh();
        await waitFor(`document.querySelectorAll('#group-table-view [data-review-artifact]').length === 1`, 'the file is back for the deny', 8000);
        await ev(`[...document.querySelectorAll('#group-table-view tbody tr button')].find(b => /^Deny: /.test(b.getAttribute('aria-label') || '')).click(); true`);
        await waitFor(`!!document.querySelector('dialog.inbox-deny-dialog[open]')`, 'the deny dialog', 4000);
        await ev(`document.querySelector('.inbox-deny-confirm').click(); true`);
        await waitFor(`window.__decisions.length >= 3`, 'the deny and the older versions', 8000);
        assert.deepEqual((await decisions()).sort(), ['deny:3', 'tags:1', 'tags:2'], 'the newest denied; the older two had their for-review tag taken off');
        await refresh();
        assert.deepEqual(await needs(), [], 'nothing of the denied file is left in Needs you');

        // a Saved list that already holds two versions saved on their own (as the Operator's did) is one row
        await ev(`window.__decisions.length = 0; window.__items.forEach(a => { a.tags = ['for review', 'internal']; }); window.__items[0].tags.push('saved'); window.__items[1].tags.push('saved'); window.__items.pop(); true`); await refresh();
        await openSaved(); await refresh();
        await waitFor(`document.querySelectorAll('.saved-files tbody tr').length >= 1`, 'the saved files', 8000);
        const legacy = await ev(`[...document.querySelectorAll('.saved-files tbody tr')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
        assert.ok(legacy.length === 1 && /1 earlier version(?!s)/.test(legacy[0]), 'two saved versions are one Saved row with "1 earlier version": ' + JSON.stringify(legacy));
        console.log('PASS a file with several versions: Save, Ignore and Move to Needs you apply to the whole file; Saved is one row per file');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
