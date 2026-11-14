// #14317: a v2.0.59 dashboard served through a Hub shows a computer still on v2.0.58. That computer's connector refuses the newer query keys (digest, facets, muted, starred_first, waiting) and the Hub hands the refusal
// to the page as 403 {code: 'path_not_allowed'}. Needs you must still list that computer's review file, with no "could not be read" note, at 1280 and at 390; the refused keys are asked once, not on every read.
// The older computer is a page stub of v2.0.58's own query table. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`, T = '#group-table-view';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, width, mobile] of [['1280', 1280, false], ['390', 390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`(async () => {
                const { state } = await import(${S} + 'state.js');
                state.hub = true; state.servers = [{ id: 'local', label: 'Hub', status: 'online' }, { id: 'old', label: 'Old box', name: 'Old box', status: 'online' }];
                const OLD = new Set('board,by,cursor,goal,kept,kind,limit,offset,origin,q,read,since,sort,starred,tag,task,team,until,versions'.split(','));
                const hex = (1).toString(16).padStart(64, '0'), real = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
                const item = { id: hex, name: 'Old computer plan.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - 600000).toISOString(), board_id: 'dev', team: 'Dev team', task_id: 0, source: 'upload', available: true, session_id: 'w', produced_by: 'Writer A', tags: ['for review'], uri: 'coral://artifacts/' + hex };
                window.__oldReads = []; window.__oldRefused = 0;
                window.fetch = (url, opts = {}) => {
                    const u = new URL(String(url), location.origin), m = /^\\/api\\/remote\\/old(\\/.*)$/.exec(u.pathname);
                    if (!m) return real(url, opts);
                    window.__oldReads.push(u.search);
                    if (m[1] === '/api/team-artifacts') {
                        for (const k of u.searchParams.keys()) if (!OLD.has(k)) { window.__oldRefused++; (window.__oldRefusedAt = window.__oldRefusedAt || []).push(u.search); return json({ error: 'path not allowed', code: 'path_not_allowed' }, 403); } // no server member: the code is what is read
                        const tag = u.searchParams.get('tag');
                        return json({ artifacts: !tag || tag === 'for review' ? [item] : [], total: !tag || tag === 'for review' ? 1 : 0, has_more: false, teams: [{ board_id: 'dev', team: 'Dev team' }], tag_counts: { 'for review': 1 } });
                    }
                    if (m[1] === '/api/proposals') return json({ proposals: [] });
                    if (m[1] === '/api/needs-you') return json({ items: [], counts: {} }); // the other kinds of Needs you: nothing waiting there
                    return json([]); // the questions and proposals reads want a list: nothing waiting
                };
                (await import(${S} + 'inbox_tab.js')).updateInboxTab();
                return true;
            })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`[...document.querySelectorAll('${T} tbody tr:not(.dt-group)')].some(r => r.textContent.includes('Old computer plan.md'))`, label + ': the older computer\'s review file is listed in Needs you', 15000);
            const page = await ev(`document.body.innerText`);
            const note = /Review artifacts could not be read|could not be asked|Not everything is shown/.exec(page);
            assert.ok(!note, label + ': no "could not be read" note: ' + (note && JSON.stringify(page.slice(Math.max(0, note.index - 120), note.index + 160))));
            await ev(`new Promise(r => { let last = -1, still = 0; const t = setInterval(() => { const n = window.__oldRefused; still = n === last ? still + 1 : 0; last = n; if (still >= 8) { clearInterval(t); r(true); } }, 150); })`); // the first reads all start before the first refusal is known; wait until none is left in flight
            const first = await ev(`window.__oldRefused`);
            assert.ok(first >= 1, label + ': the stub refused a newer key (the page did send one first)');
            assert.ok(first <= 5, label + ': the refused keys are tried by the first reads only, not on every read: ' + first);
            await ev(`import(${S} + 'inbox_reviews.js').then(m => { m.refreshReviews(true); return true; })`);
            await ev(`new Promise(r => { let last = -1, still = 0; const t = setInterval(() => { const n = window.__oldReads.length; still = n === last ? still + 1 : 0; last = n; if (still >= 8) { clearInterval(t); r(true); } }, 150); })`); // the refresh's reads have all landed when the reads of that computer stop growing
            assert.equal(await ev(`window.__oldRefused`), first, label + ': a later read sends no newer key to that computer again: ' + JSON.stringify(await ev(`window.__oldRefusedAt`)));
            assert.ok(await ev(`[...document.querySelectorAll('${T} tbody tr:not(.dt-group)')].some(r => r.textContent.includes('Old computer plan.md'))`), label + ': the file is still listed after a later read');
            console.log(`PASS ${label}: the older computer's review file is listed; ${first} refused read(s), none after`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
