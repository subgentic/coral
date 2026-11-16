// The artifact detail's More menu stays open after a real tap on a phone (#17712, walk 81 High 2: #detail-more went aria-expanded true then false within one click, so Send for review, Copy link and Delete
// could not be reached). A real file on the isolated server, the team's Artifacts tab, the detail open at 390 as touch; More is pressed by a touch tap, a mouse click and a JS click: each leaves it open,
// and Copy link, Send for review and Delete are all reachable (on screen, and the one under the finger).
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const os = require('node:os');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'moretap-' + Date.now().toString(36), failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const api = (method, path, body, headers) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers || { 'Content-Type': 'application/json' })}, body: ${body === undefined ? 'undefined' : typeof body === 'string' ? JSON.stringify(body) : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const PANE = '.detail-pane:not([hidden])', MORE = `${PANE} .detail-foot .task-more-btn`;
    const open = () => ev(`document.querySelector(${JSON.stringify(MORE)}).getAttribute('aria-expanded') === 'true'`);
    const center = () => ev(`(() => { const r = document.querySelector(${JSON.stringify(MORE)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const reset = async () => { await ev(`document.querySelector(${JSON.stringify(MORE)}).getAttribute('aria-expanded') === 'true' && document.querySelector(${JSON.stringify(MORE)}).click(); true`); await waitFor(`document.querySelector(${JSON.stringify(MORE)}).getAttribute('aria-expanded') === 'false'`, 'the menu is closed again', 4000); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'More Tap' });
        const sid = launch.body.session_id, sname = launch.body.session_name || launch.body.name;
        if (!sid) throw new Error('no session: ' + JSON.stringify(launch));
        await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'More Tap', job_title: 'Writer', session_name: sname });
        await api('POST', `/api/agent/artifacts?session_id=${sid}`, Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of a file long enough to scroll the open view.`).join('\n\n'), { 'X-Artifact-Name': 'tap.txt', 'X-Artifact-Media-Type': 'text/plain' });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        for (const where of ['team', 'inbox']) {
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            const ROW = where === 'team' ? '#team-panel-artifacts [data-artifact-id]' : '#group-table-view [data-artifact-id], #group-table-view tbody tr .dt-primary';
            if (where === 'team') await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'artifacts' }); true`);
            else { await ev(`window.switchNavTab('hub-inbox'); true`); await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('artifacts')).then(() => true)`); }
            await waitFor(`!!document.querySelector(${JSON.stringify(ROW)})`, `${where}: the file's row`, 15000);
            await ev(`document.querySelector(${JSON.stringify(ROW)}).click(); true`);
            await waitFor(`!!document.querySelector(${JSON.stringify(MORE)}) && document.querySelector('${PANE} .detail-foot').getBoundingClientRect().height > 0`, `${where}: the open view`, 10000);
            const settle = async () => { await ev(framesJs(30)); };
            for (const how of ['touch', 'mouse', 'js']) {
                await ev(`document.querySelector(${JSON.stringify(MORE)}).scrollIntoView({ block: 'center', behavior: 'instant' }); true`); await settle();
                const p = await center();
                if (how === 'touch') { await client.Input.dispatchTouchEvent({ type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 1 }] }); await client.Input.dispatchTouchEvent({ type: 'touchEnd', touchPoints: [] }); }
                else if (how === 'mouse') for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await client.Input.dispatchMouseEvent({ type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
                else await ev(`document.querySelector(${JSON.stringify(MORE)}).click(); true`);
                await waitFor(`document.querySelector(${JSON.stringify(MORE)}).getAttribute('aria-expanded') === 'true'`, `${where} ${how}: the menu opens`, 4000).catch(() => {});
                await settle();
                const at = `${where} ${how}`;
                check(await open(), `${at}: More is still open a moment after the ${how === 'touch' ? 'tap' : 'click'}; #detail-more x${await ev(`document.querySelectorAll('#detail-more').length`)}`);
                const reach = await ev(`(() => { const m = document.querySelector('${PANE} .detail-foot .team-more-menu'); return [...m.querySelectorAll('[role^=menuitem]')].filter(b => /^(Send for review|Copy link|Delete)/.test(b.textContent.trim())).map(b => { const r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y); return { name: b.textContent.trim().slice(0, 20), on: r.top >= 0 && r.bottom <= innerHeight && r.height >= 40, mine: !!hit && b.contains(hit) }; }); })()`);
                check(reach.length === 3 && reach.every(r => r.on && r.mine), `${at}: Send for review, Copy link and Delete are on screen and under a finger: ` + JSON.stringify(reach));
                if (how === 'touch' && await open()) { // a phone's address bar hides as the page moves: the viewport gets shorter, not narrower, and the menu stays
                    await Emulation.setDeviceMetricsOverride({ width: 390, height: 760, deviceScaleFactor: 1, mobile: true }); await settle();
                    check(await open(), `${at}: a height-only resize (the address bar) does not close More`);
                    await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await settle();
                }
                if (await open()) await reset();
            }
        }
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('artifact_detail_more_tap_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
