// After Approve on a Needs you row, the other rows still open (#11633, the operator: "clicking other rows no longer opens them until a reload", desktop app). Real files uploaded by a stood-in terminal session of a real
// board on the isolated dev server, the real review route, REAL mouse clicks (CDP Input) on a row's name and on its body (a cell with no control). Approve one, then open another by its name, close the viewer, open the
// third by its body, approve that, click the fourth, Approve inside the viewer, and click a waiting agent's row (a stood-in live-list row). 1440 (the words) and 390 (the row's three dots). Removed again.
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
        for (const [w, h, mobile] of [[1280, 800, false], [390, 800, true]]) {
            const at = `${w} px: `, tag = `w${w}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            if (!sid) {
                const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Walk Writer' });
                sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name;
                if (!sid) throw new Error('no session: ' + JSON.stringify(launch));
                check((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Walk Writer', job_title: 'Writer', session_name: sname })).status < 300, 'subscribed');
            }
            const names = { a: `a-${tag}.md`, b: `b-${tag}.md`, c: `c-${tag}.md`, d: `d-${tag}.md` };
            for (const n of Object.values(names)) {
                const up = await api('POST', `/api/agent/artifacts?session_id=${sid}&tag=for+review&question=Approve+this%3F`, `content of ${n} ${Date.now()}`, { 'X-Artifact-Name': n, 'X-Artifact-Media-Type': 'text/markdown' });
                check(up.status < 300, at + `uploaded ${n}: ${JSON.stringify(up.body).slice(0, 120)}`);
            }
            await ev(`localStorage.removeItem('coral-inbox-needs-filters'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            const rowGone = n => `!document.querySelector('${T} button[aria-label="Approve: ${n}"]')`;
            const rowThere = n => `!!document.querySelector('${T} button[aria-label="Approve: ${n}"]')`;
            await waitFor(Object.values(names).map(rowThere).join(' && '), at + 'the four real review rows', 20000);
            const press = async (n, word) => {
                if (mobile && word !== 'Approve') {
                    await ev(`document.querySelector('${T} button[aria-label="More actions for ${n}"]').click(); true`);
                    await waitFor(`document.querySelector('${T} .inbox-row-more-toggle[aria-expanded="true"]')`, at + 'the three dots open', 4000);
                    await ev(`document.querySelector('${T} .menu-item[aria-label="${word}: ${n}"]').click(); true`);
                } else {
                    const q = await ev(`(() => { const b = document.querySelector('${T} button[aria-label="${word}: ${n}"]'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
                    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await client.Input.dispatchMouseEvent({ type, x: q.x, y: q.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 }); // a real press, as a person's
                }
            };
            const click = async (x, y) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await client.Input.dispatchMouseEvent({ type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 }); };
            const where = (n, part) => ev(`(() => { const tr = [...document.querySelectorAll('${T} tbody tr')].find(r => r.querySelector('button[aria-label="Approve: ${n}"]')); if (!tr) return null; tr.scrollIntoView({ block: 'center' });
                const R = tr.getBoundingClientRect(), y = Math.round(R.top + R.height / 2), INT = 'a, input, select, textarea, summary, button:not(.dt-primary)';
                if (${JSON.stringify(part)} === 'name') { const el = tr.querySelector('.inbox-review-name, .dt-primary'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(r.width / 2, 30)), y: Math.round(r.top + r.height / 2) }; }
                for (let x = Math.round(R.right - 6); x > R.left + 40; x -= 6) { const hit = document.elementFromPoint(x, y); if (hit && tr.contains(hit) && !hit.closest(INT) && !hit.closest('.inbox-review-name, .dt-primary')) return { x, y }; } return null; })()`);
            const openBy = async (n, part, label) => {
                const p = await where(n, part); check(!!p, at + `${label}: found ${n}'s ${part}`); if (!p) return;
                await click(p.x, p.y);
                const ok = await waitFor(`!!document.querySelector('#artifact-viewer:not([hidden])')`, at + `${label}: the viewer opens`, 6000).then(() => true, () => false);
                check(ok, at + `${label}: a click on ${n}'s ${part} opens it (hit ${JSON.stringify(p)})`);
                await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
                await waitFor(`document.getElementById('artifact-viewer').hidden`, at + `${label}: the viewer closes`, 4000).catch(() => {});
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: the viewer's close
            };
            await openBy(names.d, 'name', 'before any Approve (marks it read)');
            // an agent waiting beside the files (a stood-in row of the live list; the app's own opening of it is counted)
            await ev(`window.__opened = []; window.selectLiveSession = (...a) => { window.__opened.push(a[2]); return Promise.resolve(); }; T.state.liveSessions = [{ name: 'wa', session_id: '00000001-0000-4000-8000-0000000000aa', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Waiting Agent', working_directory: '/repo/a', waiting_for_input: true, waiting_kind: 'permission', waiting_since: new Date(Date.now() - 300000).toISOString(), sleeping: false }]; import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return true; })`);
            await waitFor(`!![...document.querySelectorAll('${T} tbody tr')].find(r => /Waiting Agent/.test(r.textContent))`, at + 'the waiting agent row', 8000);
            await press(names.a, 'Approve');
            await waitFor(rowGone(names.a), at + 'the approved row leaves', 15000).catch(() => {});
            check(await ev(rowGone(names.a)), at + 'the approved row is gone');
            await openBy(names.b, 'name', 'after Approve, by the name');
            await openBy(names.c, 'body', 'after Approve, by the body');
            await press(names.c, 'Approve');
            await waitFor(rowGone(names.c), at + 'the second approved row leaves', 15000).catch(() => {});
            await openBy(names.d, 'body', 'after two Approves, by the body');
            await openBy(names.b, 'name', 'after two Approves, by the name');
            // Approve inside the viewer (the review bar), then close it: the rows still open
            { const p = await where(names.d, 'name'); await click(p.x, p.y); await waitFor(`!!document.querySelector('#artifact-viewer:not([hidden]) .artifact-review-approve:not([hidden])')`, at + 'the viewer shows Approve', 8000).catch(() => {});
              await ev(`document.querySelector('#artifact-viewer .artifact-review-approve').click(); true`);
              await waitFor(`/Approved/.test(document.querySelector('#artifact-viewer .artifact-review-state').textContent)`, at + 'approved in the viewer', 8000).catch(() => {});
              await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
              await waitFor(`document.getElementById('artifact-viewer').hidden`, at + 'the viewer closes', 4000).catch(() => {}); }
            await waitFor(rowGone(names.d), at + 'the row approved in the viewer leaves', 15000).catch(() => {});
            await openBy(names.b, 'body', 'after Approve in the viewer, by the body');
            await openBy(names.b, 'name', 'after Approve in the viewer, by the name');
            { const q = await ev(`(() => { const tr = [...document.querySelectorAll('${T} tbody tr')].find(r => /Waiting Agent/.test(r.textContent)); tr.scrollIntoView({ block: 'center' }); const el = tr.querySelector('.dt-primary, .inbox-review-name') || tr.querySelector('td'); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(r.width / 2, 30)), y: Math.round(r.top + r.height / 2) }; })()`);
              await click(q.x, q.y); await waitFor(`window.__opened.length > 0`, at + 'after the Approves, a click on the waiting agent opens it', 4000).catch(() => check(false, at + 'after the Approves, a click on the waiting agent row opened nothing')); }
        }
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('inbox_approve_then_open_real_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
