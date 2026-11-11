// The Close goal dialog on a phone is a card (#15163, Beta walk 6 H1: no card, no padding, the text and the radios on the screen's left edge, a big empty page under it): at 390 px it is a box with the page's
// surface, a border radius and 16 px of padding, inset from the screen's edges, not taller than the screen, and everything in it (the title, the radios, the buttons) is inside that padding. 1280 px is the same card.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const boards = [], problems = [];
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, mobile] of [[1280, false], [390, true]]) {
            const at = `${width} px: `, board = `goal-card-${width}-` + Date.now().toString(36); boards.push(board);
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: board })).status, 200);
            const g = await api('POST', `/api/board/${board}/goals`, { subscriber_id: 'Operator', title: 'Close me with care', outcome: 'One goal', done_when: 'A person chooses' }); assert.equal(g.status, 201); const id = g.body.id;
            assert.equal((await api('PATCH', `/api/board/${board}/goals/${id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
            assert.ok((await api('POST', `/api/board/${board}/tasks`, { created_by: 'orch', title: 'Still open', body: 'x', priority: 'medium', goal_id: id })).status < 300);
            await Page.navigate({ url: BASE + `/inbox/goals/${board}/${id}` }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await waitFor(`!!document.querySelector('#inbox-page .goals-close')`, at + 'the goal page', 15000);
            await ev(`document.querySelector('#inbox-page .goals-close').click(); true`);
            await waitFor(`!!document.querySelector('.goals-close-dialog[open]')`, at + 'the Close dialog', 5000);
            await ev(`new Promise(r => setTimeout(r, 300))`); // sleep-ok: the dialog's layout settles
            const m = await ev(`(() => { const d = document.querySelector('.goals-close-dialog[open]'), r = d.getBoundingClientRect(), cs = getComputedStyle(d), pad = parseFloat(cs.paddingLeft);
                const inside = [...d.querySelectorAll('h3, .goals-close-goal, legend, .goals-radio, .goals-field, .goals-actions .btn')].map(e => { const b = e.getBoundingClientRect(); return { n: (e.className || e.tagName).toString().slice(0, 24), l: Math.round(b.left - r.left), r: Math.round(r.right - b.right) }; });
                return { left: Math.round(r.left), right: Math.round(innerWidth - r.right), top: Math.round(r.top), bottom: Math.round(innerHeight - r.bottom), h: Math.round(r.height), vh: innerHeight, radius: parseFloat(cs.borderTopLeftRadius), pad, bg: cs.backgroundColor, inside }; })()`);
            const bad = [];
            if (m.left < 8 || m.right < 8) bad.push('the card touches the screen edge');
            if (m.h > m.vh - 16) bad.push('the card fills the screen height');
            if (!(m.radius >= 8)) bad.push('no rounded corners');
            if (!(m.pad >= 12)) bad.push('padding ' + m.pad);
            if (/rgba\(0, 0, 0, 0\)|transparent/.test(m.bg)) bad.push('no surface');
            if (m.inside.some(x => x.l < m.pad - 1 || x.r < m.pad - 1)) bad.push('content inside the padding: ' + JSON.stringify(m.inside.filter(x => x.l < m.pad - 1 || x.r < m.pad - 1)));
            if (bad.length) problems.push(at + bad.join('; ') + ' ' + JSON.stringify({ ...m, inside: undefined }));
        }
    } finally { await removeBoards(ev, boards).catch(() => {}); await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('goal_close_phone_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
