// An item put away with Ignore can be found again (#11579, QA's INFO on #11576): the Inbox's Artifacts folder has an "Ignored N" pill beside "For review N" when a file is tagged ignored, filtering to those files, and a file's actions
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
    const pills = () => ev(`[...document.querySelectorAll('${T} button')].map(b => (b.textContent || '').trim()).filter(t => /^(All|For review|Ignored) \\d+$/.test(t))`);
    let sid = null, sname = null;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Ign Writer' });
        sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name;
        if (!sid) throw new Error('no session: ' + JSON.stringify(launch));
        await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Ign Writer', job_title: 'Writer', session_name: sname });
        const ids = {};
        for (const n of ['keep-me.md', 'put-away.md']) { const up = await api('POST', `/api/agent/artifacts?session_id=${sid}&tag=for+review`, `content of ${n} ${Date.now()}`, { 'X-Artifact-Name': n, 'X-Artifact-Media-Type': 'text/markdown' }); ids[n] = String(up.body.id || up.body.digest).replace(/^sha256:/, ''); }
        check((await api('POST', `/api/board/${B}/artifacts/${ids['put-away.md']}/review`, { decision: 'ignore' })).status === 200, 'the file was ignored through the real route');

        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('artifacts')).then(() => true)`);
        await waitFor(`[...document.querySelectorAll('${T} button')].some(b => /^Ignored \\d+$/.test((b.textContent || '').trim()))`, 'the Ignored pill', 20000);
        check(JSON.stringify(await pills()) === JSON.stringify(['All 2', 'For review 1', 'Ignored 1']), 'the pills: All, For review, Ignored with their counts: ' + JSON.stringify(await pills()));
        await ev(`[...document.querySelectorAll('${T} button')].find(b => /^Ignored \\d+$/.test((b.textContent || '').trim())).click(); true`);
        await waitFor(`document.querySelectorAll('${T} tbody tr').length === 1 && /put-away\\.md/.test(document.querySelector('${T} tbody tr').textContent)`, 'the list is the ignored file alone', 15000);

        // the file's actions have Unignore
        await ev(`document.querySelector('${T} tbody tr .dt-primary, ${T} tbody tr .inbox-review-name, ${T} tbody tr td button').click(); true`);
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
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('inbox_ignored_real_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
