// A "Permission needed" card and its Needs you row that stay after the agent went on can be dismissed (#11352, the operator's report): a Dismiss on the chat card and on the Inbox row clears Coral's record of the
// wait with POST .../dismiss-wait and sends nothing to the agent (no send, keys or answer-prompt). It is not offered for a sign-in or a launch prompt. 1280 and 390 px, isolated dev server; the agent is a row in the
// page's live list, the server's answers are stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`window.__posts = [];
                const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                    if (m === 'POST') { window.__posts.push({ url, body: o.body ? JSON.parse(o.body) : null }); if (/\\/dismiss-wait$/.test(url)) return Promise.resolve(new Response(JSON.stringify({ ok: true, dismissed: true }), { headers: { 'content-type': 'application/json' } })); }
                    return real(u, o); };
                window.__row = { session_id: 'dw-id', name: 'claude-dw-id', display_name: 'Agent 1', agent_type: 'claude', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run: npm test', waiting_since: new Date().toISOString(), working_dir: '/tmp/dw' };
                window.__qaState.liveSessions = [window.__row]; true`);
            // the chat card
            await ev(`window.__host = document.createElement('div'); window.__host.id = 'dw-host'; document.body.append(window.__host);
                import((window.__coralStatic || '/static/') + 'needs_input_card.js').then(m => { m.syncNeedsInputCard(window.__host, window.__row); return true; })`);
            await waitFor(`!!document.querySelector('#dw-host [data-on-click="dismiss-wait"]')`, `${w}: the card offers Dismiss`, 8000);
            const card = await ev(`(() => { const b = document.querySelector('#dw-host [data-on-click="dismiss-wait"]'), r = b.getBoundingClientRect(); return { text: b.textContent.trim(), title: b.title, h: Math.round(r.height), w: Math.round(r.width), kicker: document.querySelector('#dw-host .cni-kicker').textContent.trim() }; })()`);
            assert.match(card.kicker, /permission needed/i, `${w}: it is the permission card: ${JSON.stringify(card)}`);
            assert.equal(card.text, 'Dismiss');
            assert.match(card.title, /nothing is sent to the agent/i, `${w}: the title says what it never does`);
            if (mobile) assert.ok(card.h >= 44 || card.w >= 44, `${w}: a phone target: ${JSON.stringify(card)}`);
            await ev(`document.querySelector('#dw-host [data-on-click="dismiss-wait"]').click(); true`);
            await waitFor(`window.__posts.some(p => /\\/dismiss-wait$/.test(p.url))`, `${w}: the card's Dismiss posts`, 8000);
            // the Inbox row's cell
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_answer.js').then(m => { window.__cell = m.answerCell(window.__row); document.body.append(window.__cell); return true; })`);
            await waitFor(`!!document.querySelector('.inbox-answers .inbox-dismiss')`, `${w}: the row offers Dismiss`, 8000);
            const rowShown = await ev(`getComputedStyle(document.querySelector('.inbox-answers .inbox-dismiss')).display !== 'none'`);
            assert.equal(rowShown, !mobile, `${w}: the row's Dismiss is drawn on a desktop and not on a phone (its row stays one line; the card has it there)`);
            await ev(`window.__posts = []; document.querySelector('.inbox-answers .inbox-dismiss').click(); true`);
            await waitFor(`window.__posts.some(p => /\\/dismiss-wait$/.test(p.url))`, `${w}: the row's Dismiss posts`, 8000);
            const posts = await ev(`window.__posts`);
            assert.deepEqual(posts.map(p => p.body), [{ session_id: 'dw-id', agent_type: 'claude' }], `${w}: the id of the agent, nothing else: ${JSON.stringify(posts)}`);
            assert.ok(posts.every(p => /\/dismiss-wait$/.test(p.url)), `${w}: nothing went to send, keys or answer-prompt: ${JSON.stringify(posts)}`);
            // a sign-in is not dismissed here
            await ev(`window.__row.waiting_kind = 'login'; document.querySelector('.inbox-answers')?.remove(); import((window.__coralStatic || '/static/') + 'inbox_answer.js').then(m => { window.__cell = m.answerCell(window.__row); return true; })`);
            assert.equal(await ev(`window.__cell === '' || !window.__cell.querySelector?.('.inbox-dismiss')`), true, `${w}: no Dismiss for a sign-in`);
            await ev(`document.getElementById('dw-host').remove(); true`);
        }
        console.log('PASS Dismiss on the card and the Inbox row');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
