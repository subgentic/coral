// Deny, Dismiss and Undo on a review row of Needs you against the REAL server (#11552, the walk the stubbed inbox_review_decisions_browser cannot be): real files uploaded by a stood-in terminal session of a real board on the
// isolated dev server, the real review route. Deny sends one notice to the uploader with the reason and takes the row out (tags: denied); Dismiss takes it out with NO new message on the board (tags: ignored, no for review);
// Undo (unignore) brings it back as it was (for review, no ignored), again with no message. 1440 (the words) and 390 (the row's three dots). Removed again.
const os = require('node:os');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'walk-' + Date.now().toString(36);
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const api = (method, path, body, headers) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers || { 'Content-Type': 'application/json' })}, body: ${body === undefined ? 'undefined' : typeof body === 'string' ? JSON.stringify(body) : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const T = '#group-table-view';
    const S = `(window.__coralStatic || '/static/')`;
    const messages = async () => { const r = await api('GET', `/api/board/${B}/messages?limit=200`); const b = r.body; return Array.isArray(b) ? b : (b.messages || []); };
    const tagsOf = async name => { const r = await api('GET', `/api/board/${B}/artifacts`); return ((r.body.artifacts || []).find(a => a.name === name) || {}).tags; };
    let sid = null, sname = null;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 800, false], [390, 800, true]]) {
            const at = `${w} px: `, tag = `w${w}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            if (!sid) {
                const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Walk Writer' });
                sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name;
                if (!sid) throw new Error('no session: ' + JSON.stringify(launch));
                check((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Walk Writer', job_title: 'Writer', session_name: sname })).status < 300, 'subscribed');
            }
            const names = { deny: `deny-${tag}.md`, ignore: `ignore-${tag}.md`, keep: `keep-${tag}.md` };
            for (const n of Object.values(names)) {
                const up = await api('POST', `/api/agent/artifacts?session_id=${sid}&tag=for+review&question=Approve+this%3F`, `content of ${n} ${Date.now()}`, { 'X-Artifact-Name': n, 'X-Artifact-Media-Type': 'text/markdown' });
                check(up.status < 300, at + `uploaded ${n}: ${JSON.stringify(up.body).slice(0, 120)}`);
            }
            await ev(`localStorage.removeItem('coral-inbox-needs-filters'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            const rowGone = n => `!document.querySelector('${T} button[aria-label="Approve: ${n}"]')`;
            const rowThere = n => `!!document.querySelector('${T} button[aria-label="Approve: ${n}"]')`;
            await waitFor(rowThere(names.deny) + ' && ' + rowThere(names.ignore) + ' && ' + rowThere(names.keep), at + 'the three real review rows', 20000);
            const press = async (n, word) => {
                if (mobile) {
                    await ev(`document.querySelector('${T} button[aria-label="More actions for ${n}"]').click(); true`);
                    await waitFor(`document.querySelector('${T} .inbox-row-more-toggle[aria-expanded="true"]')`, at + 'the three dots open', 4000);
                    await ev(`document.querySelector('${T} .menu-item[aria-label="${word}: ${n}"]').click(); true`);
                } else await ev(`document.querySelector('${T} button[aria-label="${word}: ${n}"]').click(); true`);
            };
            const before = (await messages()).length;

            // Deny with a reason: one notice to the uploader, tags denied, the row gone
            await press(names.deny, 'Deny');
            await waitFor(`document.querySelector('dialog.inbox-deny-dialog[open]')`, at + 'the Deny dialog', 4000);
            await ev(`const t = document.querySelector('dialog.inbox-deny-dialog textarea'); t.value = 'not what we asked for'; t.dispatchEvent(new Event('input', { bubbles: true })); [...document.querySelectorAll('dialog.inbox-deny-dialog button')].find(b => b.textContent === 'Deny').click(); true`);
            await waitFor(rowGone(names.deny), at + 'the denied row leaves', 15000).catch(() => {});
            const toastText = await ev(`[...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')`);
            check(new RegExp('Denied ' + names.deny.replace(/[.]/g, '[.]') + '[.] .+ was told').test(toastText), at + 'the real route said the uploader was told (delivered): ' + toastText);
            check((await messages()).length === before, at + 'the notice goes to the uploader\'s session, not onto the board: ' + (await messages()).length);
            check(JSON.stringify(await tagsOf(names.deny)) === JSON.stringify(['denied']), at + 'its tags are denied only: ' + JSON.stringify(await tagsOf(names.deny)));

            // Dismiss: nothing posted, tags ignored (no for review), the row gone; Undo brings it back as it was
            const mid = (await messages()).length;
            await press(names.ignore, 'Dismiss');
            await waitFor(rowGone(names.ignore), at + 'the ignored row leaves', 15000).catch(() => {});
            const ti = await tagsOf(names.ignore);
            check(ti && ti.includes('ignored') && !ti.includes('for review'), at + 'Dismiss: tags ignored, not for review: ' + JSON.stringify(ti));
            check((await messages()).length === mid, at + 'Dismiss posted nothing to the board');
            await ev(`[...document.querySelectorAll('.toast')].find(x => x.textContent.includes('Dismissed: ${names.ignore}')).querySelectorAll('button').forEach(b => { if (b.textContent.trim() === 'Undo') b.click(); }); true`);
            await waitFor(rowThere(names.ignore), at + 'Undo brings the ignored row back', 15000).catch(() => {});
            const tu = await tagsOf(names.ignore);
            check(tu && tu.includes('for review') && !tu.includes('ignored'), at + 'Undo: for review again, not ignored: ' + JSON.stringify(tu));
            check((await messages()).length === mid, at + 'Undo posted nothing to the board');
            check(await ev(rowThere(names.keep)), at + 'the untouched row is still there');
        }
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('inbox_review_decisions_real_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
