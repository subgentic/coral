// The comment sheet on a phone leaves the file readable (#17460, walk 69 L3: it covered all but about 3 lines). A real 60-line file on the isolated server, the viewer at 390x844 as touch, the Comments sheet
// open: the part of the file above the sheet is at least a fifth of the screen (it was 41 px), and the sheet is no more than half of it. Removed again.
const os = require('node:os');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'sheet-' + Date.now().toString(36), failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const api = (method, path, body, headers) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers || { 'Content-Type': 'application/json' })}, body: ${body === undefined ? 'undefined' : typeof body === 'string' ? JSON.stringify(body) : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Sheet Writer' });
        const sid = launch.body.session_id, sname = launch.body.session_name || launch.body.name;
        if (!sid) throw new Error('no session: ' + JSON.stringify(launch));
        await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Sheet Writer', job_title: 'Writer', session_name: sname });
        const text = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}: the plan for the weekend, written out so the sheet has something to cover.`).join('\n\n');
        const up = await api('POST', `/api/agent/artifacts?session_id=${sid}&tag=for+review&question=Approve+this%3F`, text, { 'X-Artifact-Name': 'plan.md', 'X-Artifact-Media-Type': 'text/markdown' });
        const hex = String((up.body && (up.body.digest || up.body.id || up.body.hex)) || '').replace(/^sha256:/, '').replace(/^coral:\/\/artifacts\//, '');
        check(up.status < 300 && hex.length === 64, 'uploaded: ' + JSON.stringify(up.body).slice(0, 160));
        for (let i = 1; i <= 6; i++) check((await api('POST', `/api/artifacts/${hex}/comments`, { body: `Comment ${i}: please look at this paragraph again and tell me what you think of it.`, anchor: { whole: true }, board: B })).status < 300, 'comment ' + i); // a thread long enough to fill the sheet
        await ev(`import(${S} + 'artifact_viewer.js').then(m => m.openArtifactViewer(${JSON.stringify(hex)}, { board: ${JSON.stringify(B)}, filename: 'plan.md' })).then(() => true)`);
        await waitFor(`!!document.querySelector('#artifact-viewer:not([hidden]) .ac-toggle:not([hidden])')`, 'the Comments button', 15000);
        await ev(`document.querySelector('#artifact-viewer .ac-toggle').click(); true`);
        await waitFor(`(() => { const p = document.querySelector('#artifact-viewer .ac-panel'); return !!p && p.getBoundingClientRect().height > 100; })()`, 'the sheet is open', 8000);
        await ev(framesJs(30));
        const m = await ev(`(() => { const p = document.querySelector('#artifact-viewer .ac-panel').getBoundingClientRect(), b = document.querySelector('#artifact-viewer .artifact-viewer-body').getBoundingClientRect(), vh = innerHeight; return { sheet: Math.round(p.height), sheetShare: +(p.height / vh).toFixed(2), fileAbove: Math.round(Math.max(0, p.top - b.top)), vh }; })()`);
        check(m.fileAbove >= m.vh / 5, 'the file keeps a fifth of the screen above the sheet: ' + JSON.stringify(m));
        check(m.sheetShare <= 0.5, 'the sheet is at most half of the screen: ' + JSON.stringify(m));
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('artifact_comment_sheet_phone_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
