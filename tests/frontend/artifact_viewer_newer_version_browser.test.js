// An open viewer does not keep a live Approve on an older version (#17460, walk 69 M4): after Request changes on v1, v2 arrives while v1's viewer is open; the viewer then says v2 is newer, offers "Open v2" and
// no longer offers Approve on v1. Real files uploaded by a stood-in terminal session of a real board on the isolated dev server (the second upload names the first with X-Artifact-New-Version-Of), the real review
// route, the Inbox's own re-read. 1440 and 390.
const os = require('node:os');
const { connect } = require('./agent_view_harness');
const { removeBoards, killSessions } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'newer-' + Date.now().toString(36), failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const api = (method, path, body, headers) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers || { 'Content-Type': 'application/json' })}, body: ${body === undefined ? 'undefined' : typeof body === 'string' ? JSON.stringify(body) : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const S = `(window.__coralStatic || '/static/')`;
    let sid = null, sname = null;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
            const at = `${w} px: `, name = `plan-${w}.md`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            if (!sid) {
                const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Newer Writer' });
                sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name;
                if (!sid) throw new Error('no session: ' + JSON.stringify(launch));
                check((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Newer Writer', job_title: 'Writer', session_name: sname })).status < 300, 'subscribed');
            }
            const up = await api('POST', `/api/agent/artifacts?session_id=${sid}&tag=for+review&question=Approve+this%3F`, `plan v1 ${Date.now()}`, { 'X-Artifact-Name': name, 'X-Artifact-Media-Type': 'text/markdown' });
            check(up.status < 300, at + 'uploaded v1: ' + JSON.stringify(up.body).slice(0, 160));
            const hex1 = String((up.body && (up.body.digest || up.body.id || up.body.hex)) || '').replace(/^sha256:/, '').replace(/^coral:\/\/artifacts\//, '');
            check((await api('POST', `/api/board/${B}/artifacts/${hex1}/review`, { decision: 'changes', comment: 'Please add a section.' })).status < 300, at + 'changes were asked for on v1');
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await ev(`import(${S} + 'artifact_viewer.js').then(m => m.openArtifactViewer(${JSON.stringify(hex1)}, { board: ${JSON.stringify(B)}, filename: ${JSON.stringify(name)} })).then(() => true)`);
            await waitFor(`!!document.querySelector('#artifact-viewer:not([hidden]) .artifact-review-approve:not([hidden])')`, at + 'the viewer has Approve on v1', 15000);
            const up2 = await api('POST', `/api/agent/artifacts?session_id=${sid}&tag=for+review&question=Approve+this%3F`, `plan v2 ${Date.now()}`, { 'X-Artifact-Name': name, 'X-Artifact-Media-Type': 'text/markdown', 'X-Artifact-New-Version-Of': hex1 });
            check(up2.status < 300, at + 'uploaded v2: ' + JSON.stringify(up2.body).slice(0, 160));
            await ev(`document.dispatchEvent(new CustomEvent('coral:reviews-changed', { detail: {} })); true`);
            const ok = await waitFor(`(() => { const v = document.querySelector('#artifact-viewer'), a = v.querySelector('.artifact-review-approve'), n = v.querySelector('.artifact-review-newest'); return !!n && !n.hidden && /Open v2/.test(n.textContent) && (!a || a.hidden || /older/i.test(a.textContent)); })()`, at + 'v1 says v2 is newer', 10000).then(() => true, () => false);
            const seen = await ev(`(() => { const v = document.querySelector('#artifact-viewer'); return [...v.querySelectorAll('.artifact-review-approve, .artifact-review-newest, .artifact-review-state')].map(e => (e.hidden ? '(hidden) ' : '') + e.textContent.trim()); })()`);
            check(ok, at + 'after v2 arrived the open viewer offers Open v2 and no plain Approve on v1: ' + JSON.stringify(seen));
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close')?.click(); true`);
        }
    } finally { await killSessions(ev, [{ id: sid, name: sname, type: 'terminal' }]); await removeBoards(ev, [B]).catch(() => {}); await client.close(); } // the agent first: a live one keeps its subscriber on the board (#18904)
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('artifact_viewer_newer_version_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
