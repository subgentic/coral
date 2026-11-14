// #16659 (the Operator, on the Hub's card): a numbered multi-line board ask keeps one step to a line on Coral's own Needs you row, at 1280 and 390 px, and when the row is opened (Show all). Text only.
// The Operator's questions are the stubbed /api/operator-asks route (as in needs_long_question_browser). SHOT_DIR=<dir> saves a shot of each width.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const ASK = '@Operator Please do these in order:\n1. Open Settings\n2. Click Save\n\n3. Reply done';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`localStorage.removeItem('coral.inbox.tab'); (() => { window.__asks = [{ board: 'reading', board_label: 'Reading List', kind: 'ask', id: 61, asker: 'Orchestrator', text: ${JSON.stringify(ASK)}, at: new Date(Date.now() - 240000).toISOString() }];
                const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify(window.__asks), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); return true; })()`);
            await ev(`import((window.__coralStatic || '/static/') + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
            if (mobile) {
                await ev(`document.getElementById('nav-select').click(); true`);
                await waitFor(`!!document.querySelector('#nav-more-menu [data-arg="hub-inbox"]')`, at + 'Inbox in the view dropdown', 5000);
                await ev(`document.querySelector('#nav-more-menu [data-arg="hub-inbox"]').click(); true`);
                await waitFor(`!!document.querySelector('#mobile-inbox-list .sidebar-pane')`, at + 'the phone list', 8000);
            } else await ev(`document.getElementById('nav-tab-hub-inbox').click(); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`!!document.querySelector('#group-table-view .inbox-ask-name')`, at + 'the ask row', 10000);
            const s = await ev(`(() => { const n = document.querySelector('#group-table-view .inbox-ask-name'), cs = getComputedStyle(n), lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
                const r = document.createRange(); r.selectNodeContents(n); const tops = new Set([...r.getClientRects()].map(x => Math.round(x.top)));
                return { text: n.textContent, ws: cs.whiteSpace, lines: tops.size, h: Math.round(n.getBoundingClientRect().height), lh: Math.round(lh), clamp: cs.webkitLineClamp }; })()`);
            if (s.text !== '@Operator Please do these in order:\n1. Open Settings\n2. Click Save\n3. Reply done') problems.push(at + 'the row keeps the lines (empty ones dropped): ' + JSON.stringify(s.text));
            if (s.ws !== 'pre-line') problems.push(at + 'the row breaks at them: white-space is ' + s.ws);
            if (s.lines < 4) problems.push(at + 'four lines drawn (heading + three steps), got ' + s.lines + ' ' + JSON.stringify(s));
            if (process.env.SHOT_DIR) { fs.mkdirSync(process.env.SHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.SHOT_DIR}/ask-lines-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'a numbered ask on the Needs you row:\n  ' + problems.join('\n  '));
    console.log('PASS a numbered ask keeps one step to a line');
})().catch(e => { console.error(e); process.exit(1); });
