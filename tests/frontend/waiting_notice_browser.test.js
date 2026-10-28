// What waits for an agent (#7727): Coral types an agent's board nudges at once and holds nothing. The agent view says how many unread board messages the agent has and why the last automated send was not typed (the row's
// board_unread and skipped_send), lists them on request (GET /waiting), and has Send now (POST /waiting/send) for the Operator. The row says only that the last send was not typed: its one chip is "Message held" and the reason is its tooltip (#9686: an agent row is the dot, the name and at most one chip). A sleeping agent and a row with neither say nothing.
// At 1280 and 390 px. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await sleep(350); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }; // sleep-ok: a picture waits for the paint
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
                const row = document.querySelector('.session-held-chip');
                return { shown: !!n && t.textContent !== '' && n.getBoundingClientRect().height > 1, text: t.textContent, role: t.getAttribute('role'), list: btn('composer-waiting-list'), send: btn('composer-waiting-send'), terminal: (() => { const b = document.querySelector('#composer-waiting-detail [data-on-click=terminal-view-open]'); return !!b && !b.hidden && b.getBoundingClientRect().height > 0; })(), row: row ? row.textContent.trim() : null, why: row ? row.title : null, fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 }; })()`);

            await feed({});
            let v = await view();
            check(`${tag}: nothing waits and nothing was skipped: no line, no buttons, no row chip`, !v.shown && !v.list && !v.send && v.row === null && v.role === 'status', JSON.stringify(v));
            await feed({ board_unread: 2 });
            v = await view();
            check(`${tag}: two unread: one plain line and one control (Options); Send now and Show terminal are behind it, not in the first look`, v.shown && v.text === '2 board messages wait for this agent' && v.list && !v.send && !v.terminal && v.row === null, JSON.stringify(v));
            await shot(`composer-waiting-line-${w}`);
            await feed({ board_unread: 1, skipped_send: { why: 'a prompt is open', what: 'board message', at: '2026-10-25T11:41:00Z', since: '2026-10-25T11:40:00Z' } });
            await waitFor(`!!document.querySelector('.session-held-chip')`, 'the row chip', 6000);
            v = await view();
            check(`${tag}: one unread and a skipped send: the line stays short (why is behind Options), and the row's chip says it was held, with why as its tooltip`, v.text === '1 board message waits for this agent' && v.row === 'Message held' && v.why === 'a prompt is open' && v.fits, JSON.stringify(v));
            const looks = await ev(`(() => { const n = document.getElementById('composer-waiting-notice'), t = document.getElementById('composer-waiting-text'), cs = getComputedStyle(t), h = id => document.getElementById(id).getBoundingClientRect().height, top = id => Math.round(document.getElementById(id).getBoundingClientRect().top);
                return { size: cs.fontSize, weight: cs.fontWeight, colour: cs.color, secondary: getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim(), hs: [h('composer-waiting-list')], tops: [top('composer-waiting-list')] }; })()`);
            check(`${tag}: the sentence is 12/400 secondary, and on a phone its one control is 44 px high`, parseFloat(looks.size) <= 13 && looks.weight === '400' && (!mobile || looks.hs.every(x => x >= 43.5)), JSON.stringify(looks));
            const boxW = await ev(`document.getElementById('command-input').getBoundingClientRect().width / document.querySelector('.command-pane-body').getBoundingClientRect().width`);
            check(`${tag}: the message box keeps its width beside the line`, boxW >= 0.5, String(boxW));
            await feed({ skipped_send: { why: 'the screen could not be read', what: 'board message' } });
            v = await view();
            check(`${tag}: a skipped send with no unread message says nothing (a notice beside "no unread messages" contradicts itself), on the line and on the row`, v.text === '' && !v.shown && !v.send && !v.list && v.row === null, JSON.stringify(v));

            // the list and Send now, for this exact session
            await feed({ board_unread: 2 });
            await ev(`window.__calls = []; window.__realFetch = window.fetch; window.fetch = (u, o) => { const s = String(u); if (s.includes('/waiting')) { window.__calls.push({ u: s, method: (o && o.method) || 'GET', body: o && o.body }); const body = s.includes('/waiting/send') ? { ok: true, sent: false, draft_in_box: true } : { board: 'b', unread: 2, messages: [{ id: 1, sender: 'Orch', at: '2026-10-25T11:40:00Z', text: 'build it <b>now</b>' }], skipped: { why: 'you have a draft in the box', what: 'board message', at: '2026-10-25T11:41:00Z', since: '2026-10-25T11:40:00Z' } }; return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })); } return window.__realFetch(u, o); }; true`);
            await ev(`document.getElementById('composer-waiting-list').click(); true`);
            await waitFor(`!document.getElementById('composer-waiting-detail').hidden`, 'the list', 4000);
            const list = await ev(`({ expanded: document.getElementById('composer-waiting-list').getAttribute('aria-expanded'), text: document.getElementById('composer-waiting-items').textContent, bold: document.querySelectorAll('#composer-waiting-detail b').length, title: (document.querySelector('#composer-waiting-items time') || {}).title || '', calls: window.__calls })`);
            check(`${tag}: Options lists the unread message (sender, time, text as text) and the skipped send; the request names the session`, list.expanded === 'true' && /Orch/.test(list.text) && list.text.includes('build it <b>now</b>') && list.bold === 0 && /^Not typed: you have a draft in the box\./.test(list.text) && !/2026-10-25T/.test(list.text) && list.title !== '' && /\/api\/sessions\/live\/wait-agent\/waiting\?agent_type=claude&session_id=wait-agent-id/.test(list.calls[0].u), JSON.stringify(list));
            const behind = await ev(`(() => { const d = document.getElementById('composer-waiting-detail'), vis = el => !!el && !el.hidden && el.getBoundingClientRect().height > 0, send = document.getElementById('composer-waiting-send'), term = d.querySelector('[data-on-click=terminal-view-open]');
                return { send: vis(send), sendLabel: send.textContent.trim(), term: vis(term), small: /btn-small/.test(send.className), hs: [send.getBoundingClientRect().height, term.getBoundingClientRect().height], note: d.textContent, inside: d.contains(send) }; })()`);
            check(`${tag}: behind Options: Send these now (a small button, inside the panel) says it sends the waiting messages, not what is typed in the box, and Show terminal is there`, behind.send && behind.inside && behind.term && behind.small && /^Send these now$/.test(behind.sendLabel) && /not what you typed|not your text|not the text you typed/i.test(behind.note) && (!mobile || behind.hs.every(x => x >= 43.5)), JSON.stringify(behind));
            await shot(`composer-waiting-details-${w}`);
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
