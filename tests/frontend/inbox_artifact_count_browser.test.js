// The Inbox's Artifacts count is read once, not on every screen switch (#9251, from the #9086 report: every Inbox screen re-asked GET /api/team-artifacts?limit=1&offset=0, the slowest request on it, 36 to 74 ms):
// opening the Inbox asks for the count once; opening it again, and switching its folders, within 30 seconds do not; and the Artifacts list's own read keeps the count current. Real dev server, requests counted on the page.
// A count older than 30 s is asked again in one of two ways: a read, or (when the answer names a team and that team's artifacts_all_rev has not moved since the last read, #13574) a cheap /status check that keeps the count
// and makes it fresh again with no read. Which one a run sees depends on whether the shard's server holds a team from an earlier suite: trial-250's gate saw the read expected, got the check, and timed out on the first
// attempt (the retry ran on a fresh server). So steps 1 to 3 run on the real server and again with a stubbed team whose revision never moves, and each pins the way it goes.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    // Counts the page's limit=1 reads (window.__counts) and its board /status checks (window.__statuses). With window.__teamStub the count's answer names a team ('stub-team') at revision 7 and that team's /status answers 7 for ever:
    // a server whose only artifacts never change.
    const wrap = () => ev(`(() => { window.__counts = []; window.__statuses = []; const real = window.fetch; window.fetch = async function (u, o) { const url = typeof u === 'string' ? u : u.url;
        if (/\\/api\\/board\\/[^/]+\\/status(\\?|$)/.test(url)) { window.__statuses.push(url); if (window.__teamStub && /\\/stub-team\\/status/.test(url)) return new Response(JSON.stringify({ artifacts_rev: 7, artifacts_all_rev: 7, board: 'stub-team' }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
        if (/\\/api\\/team-artifacts\\?[^#]*limit=1(&|$)/.test(url)) { window.__counts.push(url); if (window.__teamStub) { const d = await (await real.apply(this, arguments)).json(); return new Response(JSON.stringify({ ...d, artifacts_board: 'stub-team', artifacts_rev: 7 }), { status: 200, headers: { 'Content-Type': 'application/json' } }); } }
        return real.apply(this, arguments); }; return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        const asks = () => ev(`window.__counts.length`);
        const checks = () => ev(`window.__statuses.filter(u => /stub-team/.test(u)).length`);
        const open = async folder => { await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab(${JSON.stringify(folder)})).then(() => true)`); await new Promise(r => setTimeout(r, 600)); }; // sleep-ok: the folder draws and its reads settle
        const fresh = async stub => { await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); await wrap(); if (stub) await ev(`window.__teamStub = true`); };

        for (const stub of [false, true]) {
            const which = stub ? ' (a stubbed team whose revision never moves)' : '';
            await fresh(stub);
            console.log(`1. Opening the Inbox asks for the count once${which}`);
            await open('needs');
            await waitFor(`window.__counts.length >= 1`, 'the first count read', 8000);
            const first = await asks();
            assert.equal(first, 1, 'one count read on opening: ' + first);
            const url = await ev(`window.__counts[0]`);
            assert.match(url, /[?&]versions=newest(&|$)/, 'the badge counts files, as the list shows them (#11777): one row per file, not one per version: ' + url);
            console.log('2. Switching folders and opening the Inbox again do not ask again');
            for (const folder of ['saved', 'tasks', 'goals', 'needs']) await open(folder);
            await ev(`window.switchNavTab('agents'); true`); await open('needs'); await open('saved');
            assert.equal(await asks(), 1, 'still one count read after 6 folder switches and a second opening: ' + await asks());
            console.log('   ✓');

            console.log(`3. A read of the Artifacts list is a fresh count: the clock is moved on 20 s, the list reads, and 25 s later (45 s in all) the folders still do not ask${which}`);
            await ev(`(() => { window.__clock = 0; const real = Date.now.bind(Date); Date.now = () => real() + window.__clock; return true; })()`);
            const before = await asks();
            await ev(`window.__clock = 20000; true`);
            await open('artifacts'); // the list reads (its own request: not the limit=1 count), and tells the folder its count
            await ev(`window.__clock = 45000; true`);
            const mid = await asks(), midChecks = await checks();
            for (const folder of ['needs', 'saved']) await open(folder);
            assert.equal(await asks(), mid, 'the list\'s read made the count 25 s old, not 45 s: no new count read (' + before + ' before, ' + mid + ' after the list, ' + await asks() + ' after switching)');
            assert.equal(await checks(), midChecks, 'a fresh count is not even checked');
            await ev(`window.__clock = 91000; true`);
            await open('needs');
            if (stub) {
                // The count is older than 30 s, the team's revision is the one it was read at: asked with a /status check, which keeps the count and makes it fresh again, with no read.
                await waitFor(`window.__statuses.filter(u => /stub-team/.test(u)).length > ${midChecks}`, 'the status check of a count older than 30 s', 8000);
                assert.equal(await asks(), mid, 'nothing changed: the check keeps the count, no read');
                const checked = await checks();
                for (const folder of ['saved', 'needs']) await open(folder);
                assert.equal(await checks(), checked, 'the check made the count fresh again: no second check');
            } else {
                // Either a read, or (the shard's server holds a team that has not changed) the status check: a count older than 30 s is asked again.
                await waitFor(`window.__counts.length > ${mid} || window.__statuses.length > ${midChecks}`, 'a count read or a status check once it is older than 30 s', 8000);
            }
            console.log('   ✓');
        }

        console.log('4. Two asks at once are one read (the read in flight is shared)');
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`(() => { window.__counts = []; const real = window.fetch; window.fetch = function (u, o) { const url = typeof u === 'string' ? u : u.url; if (/\\/api\\/team-artifacts\\?[^#]*limit=1(&|$)/.test(url)) { window.__counts.push(url); return new Promise(r => setTimeout(r, 500)).then(() => real.apply(this, arguments)); } return real.apply(this, arguments); }; return true; })()`); // sleep-ok: a slow read keeps the first ask in flight while the second comes
        await ev(`import(${S} + 'inbox_artifacts.js').then(m => Promise.all([m.refreshArtifactCount(), m.refreshArtifactCount(), m.refreshArtifactCount()])).then(() => true)`);
        assert.equal(await asks(), 1, 'three asks while the first is in flight: one read');
        console.log('   ✓');
        console.log('PASS inbox artifact count: read once on opening, kept fresh by the list, shared while in flight');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
