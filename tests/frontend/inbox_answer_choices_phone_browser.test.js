// #14574 (Beta run 3: an inbox-only person has to READ option 1): on a phone a choice wraps at its words, the button grows with it, and its WHOLE words show (up to the 500-character preview; an ellipsis only after that) (they were one line with an ellipsis: '1) Scope: build the whole Reading List app, with si...'). Two waiting agents with five choices at 390 and 320: every choice is whole (not clipped), at most three lines, 44 px at least, inside its row, none overlaps another, the second row starts below the first; the full label is the title and the accessible name. Reverses #13688's one-line rule; a single word longer than the card may break.
// (POST .../answer-prompt, with the number and the label), the row says Answered and goes when the agent stops waiting, and the agent is not opened. A question with a multi-select has no buttons. Keyboard (Tab, Enter)
// and a 44 px target at 390. 1280 and 390 px, isolated dev server; the agents are mocked, the chat reply and the answer are stubbed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h, mobile] of [[390, 844, true], [320, 700, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.__answers = []; window.__multi = false;
                const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                    if (m === 'POST' && /\\/answer-prompt$/.test(url)) { window.__answers.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })); }
                    if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(url)) return Promise.resolve(new Response(JSON.stringify({ messages: [], total: 0, prompt_options: { question: 'Pick a color:', ask_id: 'ask-1', multi: window.__multi, options: [{ n: 1, label: '1) Scope: build the whole Reading List app with sign-in and a database', action: 'select' }, { n: 2, label: '2) Scope: only the list and the add button, nothing stored yet', action: 'select' }, { n: 3, label: '3) Long: ' + 'lots of words in this one '.repeat(17), action: 'select' }, { n: 4, label: '4) Something else: I will write it in the terminal', action: 'select' }, { n: 5, label: 'Always pick 1 from now on', action: 'select' }] } }), { headers: { 'content-type': 'application/json' } }));
                    return real(u, o); };
                const entry = window.__m.entry.bind(window.__m); window.__waiting = true; window.__m.entry = a => ({ ...entry(a), board_job_title: 'QA Engineer', waiting_for_input: a && a.session_id === 'qb-id' ? true : window.__waiting, waiting_kind: a && a.session_id !== 'qb-id' && !window.__waiting ? '' : 'permission', waiting_summary: a && a.session_id !== 'qb-id' && !window.__waiting ? '' : 'Wants to know: Pick a color' });
                window.__m.add('qa', 'A', 4, { sleeping: false, board_project: 'team-a', session_id: 'qa-id' }); window.__m.add('qb', 'B', 5, { sleeping: false, board_project: 'team-a', session_id: 'qb-id' }); true`);

            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 2`, `${w}: the two agents`, 8000);
            await ev(`window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.updateInboxTab()); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:needs' && document.querySelectorAll('#group-table-view .inbox-answer').length >= 8`, `${w}: both rows' choices`, 15000).catch(async e => { throw new Error(e.message + ' | ' + await ev(`document.querySelectorAll('#group-table-view .inbox-answer').length`)); });
            await new Promise(r => setTimeout(r, 800)); // sleep-ok: the rows settle
            const geo = await ev(`(() => { const rows = [...document.querySelectorAll('#group-table-view tbody tr.dt-row')].map(tr => { const r = tr.getBoundingClientRect(), els = [...tr.querySelectorAll('.inbox-answer')], bs = els.map(b => b.getBoundingClientRect()), whole = els.map(b => { const range = document.createRange(); range.selectNodeContents(b); return { label: b.textContent, title: b.title, whole: b.scrollHeight <= b.clientHeight + 1 && b.scrollWidth <= b.clientWidth + 1, lines: new Set(Array.from(range.getClientRects()).map(q => Math.round(q.top))).size }; }); return { whole, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), buttons: bs.map(b => ({ top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height) })) }; }); return { rows, vw: innerWidth }; })()`);
            if (process.env.CORAL_SCREENSHOT_DIR) { require('node:fs').mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); require('node:fs').writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/answer-rows-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            console.log(w, JSON.stringify(geo));
            assert.equal(geo.rows.length, 2, `${w}: two rows`);
            geo.rows.forEach((r, i) => {
                assert.ok(r.buttons.length >= 4, `${w}: row ${i} has its choices: ${r.buttons.length}`);
                for (const k of r.whole) assert.ok(k.whole && (k.title === k.label || (k.label.endsWith('\u2026') && k.label.length <= 500 && k.title.startsWith(k.label.slice(0, -1)))), `${w}: row ${i}: a choice is whole (wrapped at its words) with its full label as title: ${JSON.stringify(k)}`);
                for (const b of r.buttons) { assert.ok(b.top >= r.top - 1 && b.bottom <= r.bottom + 1, `${w}: row ${i}: a button is inside its row: ${JSON.stringify([r.top, r.bottom, b.top, b.bottom])}`); assert.ok(b.left >= r.left - 1 && b.right <= r.right + 1 && b.right <= geo.vw, `${w}: row ${i}: a button is inside the row sideways: ${JSON.stringify([r.left, r.right, b.left, b.right, geo.vw])}`); assert.ok(b.h >= 44, `${w}: a 44 px target: ${b.h}`); }
                for (let k = 1; k < r.buttons.length; k++) assert.ok(r.buttons[k].top >= r.buttons[k - 1].bottom - 1, `${w}: row ${i}: buttons do not overlap each other: ${JSON.stringify([r.buttons[k - 1], r.buttons[k]])}`);
            });
            assert.ok(geo.rows[1].top >= geo.rows[0].bottom - 1, `${w}: the second row starts below the first: ${JSON.stringify([geo.rows[0].bottom, geo.rows[1].top])}`);
        }
        console.log('inbox_answer_choices_phone: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
