// The Needs you list by keyboard alone (#17226, walk 56 and walk 79): Up and Down, Home and End move between the rows (to the same kind of control when the next row has one), a Dismiss by keyboard leaves the keyboard on
// the next row (the previous at the end), never the page, and the focus ring of a button in a row is drawn in full, not clipped by the row. 1280 and 390 px; the agents are mocked (inbox_answer_keyboard's setup, two agents).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const problems = [];
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a key's answer and the redraw after it
    const key = async (k, code, text) => { const base = { key: k, code: k === 'Tab' ? 'Tab' : k, windowsVirtualKeyCode: code }; await Input.dispatchKeyEvent({ type: 'keyDown', ...base, ...(text ? { text } : {}) }); await Input.dispatchKeyEvent({ type: 'keyUp', ...base }); await sleep(60); }; // sleep-ok: the answer, the announcement and the redraw come a moment after the key
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.__answers = []; window.__multi = false;
                const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                    if (m === 'POST' && /\\/answer-prompt$/.test(url)) { window.__answers.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })); }
                    if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(url)) return Promise.resolve(new Response(JSON.stringify({ messages: [], total: 0, prompt_options: { question: 'Pick a color:', ask_id: window.__ask || 'ask-1', multi: window.__multi, options: [{ n: 1, label: 'Red', action: 'select' }, { n: 2, label: 'Blue', action: 'select' }, { n: 3, label: 'Always pick Red from now on', action: 'select' }] } }), { headers: { 'content-type': 'application/json' } }));
                    return real(u, o); };
                const entry = window.__m.entry.bind(window.__m); window.__done = []; window.__m.entry = a => ({ ...entry(a), board_job_title: 'QA Engineer', waiting_for_input: !window.__done.includes(a.session_id), waiting_kind: 'permission', waiting_summary: 'Wants to know: Pick a color' });
                window.__m.add('qa', 'A', 4, { sleeping: false, board_project: 'team-a', session_id: 'qa-id' }); window.__m.add('dev', 'B', 4, { sleeping: false, board_project: 'team-a', session_id: 'dev-id' }); true`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 2`, `${w}: the agent`, 8000);
            await ev(`window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.updateInboxTab()); true`);
            await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '2'`, `${w}: waiting badge`, 8000);
            if (mobile) {
                await ev(`document.getElementById('nav-select').click(); true`);
                await waitFor(`!!document.querySelector('#nav-more-menu [data-arg="hub-inbox"]')`, '390: Inbox in the view dropdown', 5000);
                await ev(`document.querySelector('#nav-more-menu [data-arg="hub-inbox"]').click(); true`);
                await waitFor(`!!document.querySelector('#mobile-inbox-list .sidebar-pane')`, '390: the phone list of the Inbox', 8000);
            } else await ev(`document.getElementById('nav-tab-hub-inbox').click(); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            try { await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:needs' && document.querySelectorAll('#group-table-view .inbox-answer').length === 4`, `${w}: the row's two choices`, 10000); } catch (e) { await shot(`inbox-answer-fail-${w}`); throw new Error(e.message + ' ' + await ev(`JSON.stringify([document.getElementById('group-table-view').dataset.group, document.getElementById('group-table-view').innerText.slice(0, 200), document.querySelectorAll('.inbox-answer').length])`)); }
            await waitFor(`(() => { const b = document.querySelector('#group-table-view .inbox-answer'); if (!b) return false; if (window.__seen !== b) { window.__seen = b; window.__seenAt = performance.now(); return false; } return performance.now() - window.__seenAt > 500; })()`, `${w}: the table has settled (the same choice for half a second)`, 8000);
            const where = () => ev(`(() => { const a = document.activeElement; return !a || a === document.body ? 'the page (nothing)' : (a.getAttribute('aria-label') || a.textContent.trim()).slice(0, 40); })()`);
            await ev(`document.querySelector('#group-table-view tbody tr .dt-primary').focus(); true`);
            // (1) the arrows move between rows, Home and End to the ends
            const walk = [];
            for (const [k, code] of [['ArrowDown', 40], ['ArrowUp', 38], ['End', 35], ['Home', 36]]) { await key(k, code); walk.push((await where()).replace(/^(dev|qa),.*$/, (m, n) => 'Open ' + n)); }
            if (JSON.stringify(walk) !== JSON.stringify(['Open dev', 'Open qa', 'Open dev', 'Open qa'])) problems.push(`${w}: Down, Up, End, Home move between the rows (the keyboard went ${JSON.stringify(walk)})`);
            if (!mobile) {
                // (2) the focus ring of Dismiss is drawn whole: an outline of 2 px or more, inside every box that clips
                await ev(`document.querySelector('#group-table-view tbody tr .inbox-single-action .inbox-dismiss').focus(); true`); await sleep(400); // sleep-ok: a button's outline transition ends before its ring is measured
                const ring = await ev(`(() => { const b = document.querySelector('#group-table-view tbody tr .inbox-single-action .inbox-dismiss'); b.focus(); const cs = getComputedStyle(b), w = Math.max(0, parseFloat(cs.outlineWidth) + (parseFloat(cs.outlineOffset) || 0)), r = b.getBoundingClientRect(), cut = []; for (let e = b.parentElement; e && e !== document.body; e = e.parentElement) { const o = getComputedStyle(e); if (/(hidden|clip|auto|scroll)/.test(o.overflowX + o.overflowY)) { const q = e.getBoundingClientRect(); if (r.left - w < q.left - 0.5 || r.right + w > q.right + 0.5 || r.top - w < q.top - 0.5 || r.bottom + w > q.bottom + 0.5) cut.push(e.className.toString().slice(0, 40) + ' off ' + cs.outlineOffset + ' btn ' + [r.left, r.right, r.top, r.bottom].map(Math.round) + ' box ' + [q.left, q.right, q.top, q.bottom].map(Math.round)); } } return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), cut }; })()`);
                await shot('dismiss-ring-' + w);
                if (ring.style === 'none' || ring.width < 2 || ring.cut.length) problems.push(`${w}: the row kebab's focus ring is whole (style ${ring.style}, ${ring.width} px, clipped by ${JSON.stringify(ring.cut)})`);
                // (3) a Dismiss by keyboard leaves the keyboard on the next row's first control
                await ev(`window.fetch = (real => (u, o = {}) => { const url = String(u); if (/\\/dismiss-wait$/.test(url) && (o.method || 'GET').toUpperCase() === 'POST') { window.__done.push(JSON.parse(o.body).session_id); return Promise.resolve(new Response(JSON.stringify({ dismissed: true }), { headers: { 'content-type': 'application/json' } })); } return real(u, o); })(window.fetch); [...document.querySelectorAll('#group-table-view tbody tr')].find(r => r.querySelector('button[aria-label*="qa"], .dt-primary[data-session-id*="qa"]') || /qa/.test(r.textContent)).querySelector('.inbox-single-action .inbox-dismiss').focus(); true`);
                await key('Enter', 13, '\r'); await waitFor(`document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)').length === 1`, `${w}: the dismissed row leaves`, 8000); await sleep(800); // sleep-ok: the dismiss, the reading of the list and the redraw come a moment after the key
                const after = await where();
                if (!/^Open dev$/.test(after)) problems.push(`${w}: after Dismiss the keyboard is on the next row's first control (it is on ${after})`);
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Needs you list by keyboard:\n  ' + problems.join('\n  '));
    console.log('PASS the Needs you list by keyboard: arrows, Dismiss keeps the place, the ring is whole');
})().catch(e => { console.error(e); process.exitCode = 1; });

