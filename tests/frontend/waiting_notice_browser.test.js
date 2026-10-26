// What waits for an agent (#7727): Coral types an agent's board nudges at once and holds nothing. The agent view says how many unread board messages the agent has and why the last automated send was not typed (the row's
// board_unread and skipped_send), lists them on request (GET /waiting), and has Send now (POST /waiting/send) for the Operator. The row says only why the last send was not typed. A sleeping agent and a row with neither say nothing.
// At 1280 and 390 px. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`window.__m.add('wait-agent', 'A', 3, { sleeping: false }); window.__m.add('quiet-agent', 'B', 3, { sleeping: false }); true`);
            await sleep(600); // sleep-ok: the first live list renders from several answers; no single completion event
            await ev(`window.selectLiveSession('wait-agent', 'claude', 'wait-agent-id', 'local'); true`);
            await sleep(500); // sleep-ok: a selection settles over frames
            const feed = extra => ev(`(() => { const rows = window._coralGetLiveSessions().map(r => r.session_id === 'wait-agent-id' ? { ...r, board_unread: 0, skipped_send: null, ...${JSON.stringify(extra)} } : r); window._coralSetLiveSessions(rows);
                return import(${S} + 'waiting.js').then(m => { m.syncWaitingNotice(rows.find(r => r.session_id === 'wait-agent-id')); return true; }); })()`);
            const view = () => ev(`(() => { const n = document.getElementById('composer-waiting-notice'), t = document.getElementById('composer-waiting-text'), btn = id => { const b = document.getElementById(id); return !!b && !b.hidden && b.getBoundingClientRect().height > 0; };
                const row = document.querySelector('.session-held-line');
                return { shown: !!n && t.textContent !== '' && n.getBoundingClientRect().height > 1, text: t.textContent, role: t.getAttribute('role'), list: btn('composer-waiting-list'), send: btn('composer-waiting-send'), row: row ? row.textContent : null, fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 }; })()`);

            await feed({});
            let v = await view();
            check(`${tag}: nothing waits and nothing was skipped: no line, no buttons, no row line`, !v.shown && !v.list && !v.send && v.row === null && v.role === 'status', JSON.stringify(v));
            await feed({ board_unread: 2 });
            v = await view();
            check(`${tag}: two unread: the line says so, with What waits and Send now`, v.shown && v.text === '2 unread board messages for this agent' && v.list && v.send && v.row === null, JSON.stringify(v));
            await feed({ board_unread: 1, skipped_send: { why: 'a prompt or menu is open in the agent\'s terminal', what: 'board message', at: '2026-10-25T11:41:00Z', since: '2026-10-25T11:40:00Z' } });
            await waitFor(`!!document.querySelector('.session-held-line')`, 'the row line', 6000);
            v = await view();
            check(`${tag}: one unread and a skipped send: both are said, and the row says why it was not typed`, /^1 unread board message for this agent\. The last send was not typed: a prompt or menu is open/.test(v.text) && /^Not typed: a prompt or menu is open/.test(v.row) && v.fits, JSON.stringify(v));
            const colours = await ev(`({ row: getComputedStyle(document.querySelector('.session-held-line')).color, view: getComputedStyle(document.querySelector('#composer-waiting-notice')).color })`);
            check(`${tag}: the line and the row share the warning colour (the words stay: it is not colour alone)`, colours.row === colours.view, JSON.stringify(colours));
            const boxW = await ev(`document.getElementById('command-input').getBoundingClientRect().width / document.querySelector('.command-pane-body').getBoundingClientRect().width`);
            check(`${tag}: the message box keeps its width beside the line`, boxW >= 0.5, String(boxW));
            await feed({ skipped_send: { why: 'the agent\'s screen could not be read', what: 'board message' } });
            v = await view();
            check(`${tag}: only a skipped send: it says so, and there is no Send now (nothing unread to send)`, /^The last automated message was not typed: the agent's screen could not be read$/.test(v.text) && !v.send && v.list, JSON.stringify(v));

            // the list and Send now, for this exact session
            await feed({ board_unread: 2 });
            await ev(`window.__calls = []; window.__realFetch = window.fetch; window.fetch = (u, o) => { const s = String(u); if (s.includes('/waiting')) { window.__calls.push({ u: s, method: (o && o.method) || 'GET', body: o && o.body }); const body = s.includes('/waiting/send') ? { ok: true, sent: false, draft_in_box: true } : { board: 'b', unread: 2, messages: [{ id: 1, sender: 'Orch', at: '2026-10-25T11:40:00Z', text: 'build it <b>now</b>' }], skipped: { why: 'a draft', what: 'board message', at: 'x', since: 'y' } }; return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })); } return window.__realFetch(u, o); }; true`);
            await ev(`document.getElementById('composer-waiting-list').click(); true`);
            await waitFor(`!document.getElementById('composer-waiting-detail').hidden`, 'the list', 4000);
            const list = await ev(`({ expanded: document.getElementById('composer-waiting-list').getAttribute('aria-expanded'), text: document.getElementById('composer-waiting-detail').textContent, bold: document.querySelectorAll('#composer-waiting-detail b').length, calls: window.__calls })`);
            check(`${tag}: What waits lists the unread message (sender, time, text as text) and the skipped send; the request names the session`, list.expanded === 'true' && /Orch/.test(list.text) && list.text.includes('build it <b>now</b>') && list.bold === 0 && /was not typed since y: a draft/.test(list.text) && /\/api\/sessions\/live\/wait-agent\/waiting\?agent_type=claude&session_id=wait-agent-id/.test(list.calls[0].u), JSON.stringify(list));
            await ev(`document.getElementById('composer-waiting-send').click(); true`);
            await waitFor(`window.__calls.length >= 2`, 'the send', 4000);
            const calls = await ev('window.__calls');
            check(`${tag}: Send now posts to this agent's waiting/send route with its type and session id`, calls[1].method === 'POST' && /\/api\/sessions\/live\/wait-agent\/waiting\/send$/.test(calls[1].u) && JSON.parse(calls[1].body).session_id === 'wait-agent-id', JSON.stringify(calls[1]));
            await ev(`window.fetch = window.__realFetch; true`);
            const said = await ev(`import(${S} + 'waiting.js').then(m => ({ sent: m.sendNowToast({ sent: true }), prompt: m.sendNowToast({ prompt_open: true }), draft: m.sendNowToast({ draft_in_box: true }), none: m.sendNowToast({ nothing_waiting: true }), why: m.sendNowToast({ sent: false, why: 'x' }), junk: m.waitingCount({ board_unread: 'abc' }), neg: m.waitingCount({ board_unread: -3 }), big: m.waitingCount({ board_unread: 5000 }) }))`);
            check(`${tag}: after a press it says what happened; a junk or negative count is 0`, said.sent === 'Sent now.' && /nothing was sent into it/.test(said.prompt) && /draft in the agent's input box/.test(said.draft) && /No unread/.test(said.none) && said.why === 'Not sent: x' && said.junk === 0 && said.neg === 0 && said.big === 999, JSON.stringify(said));
            await feed({});
            v = await view();
            check(`${tag}: nothing waits any more: the line, buttons and list go`, !v.shown && !v.list && !v.send && v.row === null, JSON.stringify(v));
            await feed({ board_unread: 3, sleeping: true });
            v = await view();
            check(`${tag}: a sleeping agent says nothing`, !v.shown && v.row === null, JSON.stringify(v));
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} waiting checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
