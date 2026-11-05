// An item put away with Dismiss can be found again (#11579, QA's INFO on #11576): the Inbox's Artifacts folder has an "Dismissed N" pill beside "For review N" when a file is tagged ignored, filtering to those files, and a file's actions
// have Unignore, which puts it back in Needs you as it was (for review again, not ignored). A real board on the isolated dev server, real files uploaded by a stood-in terminal session, the real review route. 1440. Removed again.
const os = require('node:os');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'ign-' + Date.now().toString(36);
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const api = (method, path, body, headers) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers || { 'Content-Type': 'application/json' })}, body: ${body === undefined ? 'undefined' : typeof body === 'string' ? JSON.stringify(body) : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const S = `(window.__coralStatic || '/static/')`, T = '#group-table-view';
    const tagsOf = async name => ((await api('GET', `/api/board/${B}/artifacts`)).body.artifacts || []).find(a => a.name === name)?.tags;
    const pills = () => ev(`[...document.querySelectorAll('${T} button')].map(b => (b.textContent || '').trim()).filter(t => /^(All|For review|Dismissed) \\d+$/.test(t))`);
    // The pills count every board's files on this server, and other suites' rows come and go while this one runs (a shared shard: the first attempt in CI read "All 9" where it expected its own two). So the
    // test never asserts a total: it reads the pills with the run's own two files in, puts one away through the real route and checks what MOVED (For review down one, Dismissed up one, All the same).
    const counts = async () => { const o = { All: 0, 'For review': 0, Dismissed: 0 }; for (const t of await pills()) { const m = /^(All|For review|Dismissed) (\d+)$/.exec(t); if (m) o[m[1]] = Number(m[2]); } return o; };
    // wait (helpers/wait.js, no fixed sleep) until the pills, read in the page as c = {All, 'For review', Dismissed}, satisfy the expression; then return them
    const settled = async (expr, what) => {
        await waitFor(`(() => { const c = { All: 0, 'For review': 0, Dismissed: 0 }; for (const b of document.querySelectorAll('${T} button')) { const m = /^(All|For review|Dismissed) (\\d+)$/.exec((b.textContent || '').trim()); if (m) c[m[1]] = Number(m[2]); } return !!(${expr}); })()`, what, 20000).catch(e => failures.push(what + ': ' + e.message));
        return counts();
    };
    let sid = null, sname = null, sid2 = null, sname2 = null;
    const B2 = 'ignfx-' + Date.now().toString(36);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Ign Writer' });
        sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name;
        if (!sid) throw new Error('no session: ' + JSON.stringify(launch));
        await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Ign Writer', job_title: 'Writer', session_name: sname });
        const ids = {};
        for (const n of ['keep-me.md', 'put-away.md']) { const up = await api('POST', `/api/agent/artifacts?session_id=${sid}&tag=for+review&question=Approve+this%3F`, `content of ${n} ${Date.now()}`, { 'X-Artifact-Name': n, 'X-Artifact-Media-Type': 'text/markdown' }); ids[n] = String(up.body.id || up.body.digest).replace(/^sha256:/, ''); }

        // Foreign rows from another board, put in before the page is read and after anything this test could have counted: two for review and one dismissed, none of them this run's.
        const l2 = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Ign Other' });
        sid2 = l2.body.session_id; sname2 = l2.body.session_name || l2.body.name;
        if (!sid2) throw new Error('no second session: ' + JSON.stringify(l2));
        await api('POST', `/api/board/${B2}/subscribe`, { subscriber_id: 'Ign Other', job_title: 'Other', session_name: sname2 });
        const fx = {};
        for (const n of ['other-a.md', 'other-b.md', 'other-c.md']) { const up = await api('POST', `/api/agent/artifacts?session_id=${sid2}&tag=for+review&question=Approve+this%3F`, `content of ${n} ${Date.now()}`, { 'X-Artifact-Name': n, 'X-Artifact-Media-Type': 'text/markdown' }); fx[n] = String(up.body.id || up.body.digest).replace(/^sha256:/, ''); }
        check((await api('POST', `/api/board/${B2}/artifacts/${fx['other-c.md']}/review`, { decision: 'ignore' })).status === 200, 'the foreign file was ignored through the real route');

        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('artifacts')).then(() => true)`);
        const before = await settled("c['For review'] >= 4 && c.All >= c['For review']", 'the pills with both of this run\'s files for review');
        check((await api('POST', `/api/board/${B}/artifacts/${ids['put-away.md']}/review`, { decision: 'ignore' })).status === 200, 'the file was ignored through the real route');
        const after = await settled(`c.Dismissed === ${before.Dismissed + 1} && c['For review'] === ${before['For review'] - 1}`, 'the pills after the ignore: For review down one, Dismissed up one');
        check(after.All === before.All, 'the All count did not move: ' + JSON.stringify([before, after]));
        const names = await pills();
        check(names.map(t => t.replace(/ \d+$/, '')).join() === 'All,For review,Dismissed', 'the pills are All, For review, Dismissed in order: ' + JSON.stringify(names));
        await ev(`[...document.querySelectorAll('${T} button')].find(b => /^Dismissed \\d+$/.test((b.textContent || '').trim())).click(); true`);
        await waitFor(`document.querySelectorAll('${T} tbody tr').length === ${after.Dismissed} && [...document.querySelectorAll('${T} tbody tr')].some(r => /put-away\\.md/.test(r.textContent)) && ![...document.querySelectorAll('${T} tbody tr')].some(r => /keep-me\\.md/.test(r.textContent))`, 'the list is the dismissed files (this run\'s put-away.md among them, keep-me.md not)', 15000);

        // the file's actions have Unignore
        await ev(`const row = [...document.querySelectorAll('${T} tbody tr')].find(r => /put-away\\.md/.test(r.textContent)); row.querySelector('.dt-primary, .inbox-review-name, td button').click(); true`);
        await waitFor(`!![...document.querySelectorAll('button, [role="menuitem"]')].find(b => (b.textContent || '').trim() === 'Unignore')`, 'Unignore among the file\'s actions', 10000);
        await ev(`[...document.querySelectorAll('button, [role="menuitem"]')].find(b => (b.textContent || '').trim() === 'Unignore').click(); true`);
        await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Back in Needs you: put-away\\.md/.test(t.textContent))`, 'the toast says it is back', 10000);
        const t = await tagsOf('put-away.md');
        check(t && t.includes('for review') && !t.includes('ignored'), 'Unignore: for review again, not ignored: ' + JSON.stringify(t));

        // and it is a row of Needs you again
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`!!document.querySelector('${T} button[aria-label="Approve: put-away.md"]')`, 'put-away.md is a row of Needs you again', 15000).catch(() => {});
        check(await ev(`!!document.querySelector('${T} button[aria-label="Approve: put-away.md"]')`), 'the unignored file is a row of Needs you again');
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        if (sid2) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname2 || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid2)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B, B2]).catch(() => {}); await client.close();
    }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('inbox_ignored_real_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
