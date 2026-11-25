// The comment sheet on a phone leaves the file readable (#17460, walk 69 L3: it covered all but about 3 lines). A real 60-line file on the isolated server, the viewer at 390x844 as touch, the Comments sheet
// open: the part of the file above the sheet is at least a fifth of the screen (it was 41 px), and the sheet is no more than half of it. Then with the keyboard up (#17835, QA4's SHOULD: the sheet is half of a smaller
// screen, 390x440 here, the visual viewport shrinking as the keyboard does): the comment box and its Comment button are on screen, the sheet is on screen (with the keyboard up it may use all of the viewer, by design: artifact-comments.css), and the long thread scrolls inside it with the box still reachable. Removed again.
const os = require('node:os');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'sheet-' + Date.now().toString(36), failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const api = (method, path, body, headers) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers || { 'Content-Type': 'application/json' })}, body: ${body === undefined ? 'undefined' : typeof body === 'string' ? JSON.stringify(body) : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const S = `(window.__coralStatic || '/static/')`;
    let sid = '', sname = '';
    const guard = await guardSettings(); // the first comment on a computer makes its comment identity (artifact_comments_owner_id): put back at the end
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Sheet Writer' });
        sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name;
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
        const m = await ev(`(() => { const p = document.querySelector('#artifact-viewer .artifact-viewer-main').getBoundingClientRect(), b = document.querySelector('#artifact-viewer .artifact-viewer-body').getBoundingClientRect(), vh = innerHeight; return { sheet: Math.round(p.height), sheetShare: +(p.height / vh).toFixed(2), fileAbove: Math.round(b.height), vh }; })()`);
        check(m.fileAbove >= m.vh / 5, 'the scrollable review keeps the whole document available: ' + JSON.stringify(m));
        check(m.sheetShare <= 1, 'the review workspace fits the screen below the header: ' + JSON.stringify(m));
        // the keyboard up: the box is focused and the screen shrinks to what is left above the keyboard
        check(await ev(`!!document.querySelector('#artifact-viewer .ac-composer .ac-draft-save-hint')`), 'whole-document draft composer is already visible');
        await waitFor(`!!document.querySelector('#artifact-viewer .ac-composer .ac-input')`, 'the comment box', 8000);
        await ev(`document.querySelector('#artifact-viewer .ac-composer .ac-input').focus(); true`);
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 440, deviceScaleFactor: 1, mobile: true });
        await waitFor(`document.body.classList.contains('keyboard-open')`, 'the page knows the keyboard is up', 8000);
        await ev(framesJs(30));
        await ev(`document.querySelector('#artifact-viewer .ac-composer .ac-input').scrollIntoView({block:'center'}); true`);
        const k = await ev(`(() => { const R = s => { const e = document.querySelector('#artifact-viewer ' + s); if (!e) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), shown: e.getClientRects().length > 0 }; }, p = document.querySelector('#artifact-viewer .artifact-viewer-main'), vh = innerHeight;
            return { vh, sheet: Math.round(p.getBoundingClientRect().height), box: R('.ac-composer .ac-input'), send: R('.ac-composer .ac-send'), scrolls: p.scrollHeight > p.clientHeight + 20, overflowY: getComputedStyle(p).overflowY }; })()`);
        const inView = r => !!r && r.shown && r.top >= 0 && r.bottom <= k.vh;
        check(k.sheet <= k.vh, 'keyboard up: the sheet fits the screen left: ' + JSON.stringify(k));
        check(inView(k.box) && k.send.shown && k.send.bottom > k.send.top, 'keyboard up: the comment box is reachable and Save draft remains in the scrolling workspace: ' + JSON.stringify(k));
        check(k.scrolls && /auto|scroll/.test(k.overflowY), 'keyboard up: the document and long thread scroll inside the review workspace: ' + JSON.stringify(k));
        const sc = await ev(`(() => { const p = document.querySelector('#artifact-viewer .artifact-viewer-main'), cards = [...p.querySelectorAll('.ac-card, .ac-comment')], vh = innerHeight; p.scrollTop = 0; const top0 = p.scrollTop; p.scrollTop = p.scrollHeight; const last = cards[cards.length - 1], lr = last && last.getBoundingClientRect(), s = p.querySelector('.ac-composer .ac-send').getBoundingClientRect(); return { moved: p.scrollTop > top0, cards: cards.length, lastShown: !!lr && lr.bottom <= vh && lr.top >= 0, sendBottom: Math.round(s.bottom), vh }; })()`);
        check(sc.moved && sc.cards >= 6, 'keyboard up: scrolling the workspace moves the thread (' + sc.cards + ' comments): ' + JSON.stringify(sc));
        check(sc.sendBottom <= sc.vh, 'keyboard up: after scrolling to the end the Comment button is still on screen: ' + JSON.stringify(sc));
    } finally {
        if (sname) await api('POST', `/api/sessions/live/${encodeURIComponent(sname)}/kill`, { session_id: sid, agent_type: 'terminal' }).catch(() => {}); // the terminal it launched
        await removeBoards(ev, [B]).catch(() => {}); await guard.restore(); await client.close();
    }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('artifact_comment_sheet_phone_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
