// #21716: a live update must not replace an answer button under the finger. (Based on: Answering from the Inbox (#10400, Beta tester #10394): a Needs you row for an agent that asks a question carries the card's own choices as buttons; one press sends the answer through the chat card's route
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
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
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
                    if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(url)) return Promise.resolve(new Response(JSON.stringify({ messages: [], total: 0, prompt_options: { question: 'Pick a color:', ask_id: 'ask-1', multi: window.__multi, options: [{ n: 1, label: 'Red', action: 'select' }, { n: 2, label: 'Blue', action: 'select' }, { n: 3, label: 'Always pick Red from now on', action: 'select' }] } }), { headers: { 'content-type': 'application/json' } }));
                    return real(u, o); };
                const entry = window.__m.entry.bind(window.__m); window.__waiting = true; window.__m.entry = a => ({ ...entry(a), board_job_title: 'QA Engineer', waiting_for_input: window.__waiting, waiting_kind: 'permission', waiting_summary: 'Wants to know: Pick a color' });
                window.__m.add('qa', 'A', 4, { sleeping: false, board_project: 'team-a', session_id: 'qa-id' }); true`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 1`, `${w}: the agent`, 8000);
            await ev(`window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.updateInboxTab()); true`);
            await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '1'`, `${w}: waiting badge`, 8000);
            assert.equal((await api('POST', `/api/board/team-a/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'team-a' })).status, 200);
            await ev(`import((window.__coralStatic || '/static/') + 'nav.js').then(async n => { const r = await import((window.__coralStatic || '/static/') + 'routes.js'); await n.go(r.parse('/team/team-a/needs')); return true; })`);
            await waitFor(`document.querySelectorAll('.team-needs-body .inbox-answer').length === 2`, `${w}: the team page's Needs you shows the row's two choices`, 12000);
            await waitFor(`(() => { const b = document.querySelector('.team-needs-body .inbox-answer'); if (!b) return false; if (window.__seen !== b) { window.__seen = b; window.__seenAt = performance.now(); return false; } return performance.now() - window.__seenAt > 700; })()`, `${w}: the page has settled`, 8000);
            // #21716: press Red, let live updates redraw the row (the summary changes, so the card is redrawn) before the lift: the tap must still send Red, once.
            const pt = await ev(`(() => { const b = [...document.querySelectorAll('.team-needs-body .inbox-answer')].find(x => x.getClientRects().length); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b, rect: [r.x, r.y, r.width, r.height], at: (e => e && e.tagName + '.' + e.className)(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)), vh: innerHeight }; })()`);
            assert.ok(pt.hit, `${w}: the first choice is the element at the press point ${JSON.stringify(pt)}`);
            const churn = n => ev(`(async () => { for (let i = 0; i < ${n}; i++) { window.__tick = (window.__tick || 0) + 1; if (window.__tick === 1) window.__m.add('qb', 'B', 4, { sleeping: false, board_project: 'team-a', session_id: 'qb-id' }); const entry = window.__m.entry.bind(window.__m); window.__m.entry = a => ({ ...entry(a), waiting_summary: 'Wants to know: Pick a color ' + window.__tick }); window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); document.dispatchEvent(new CustomEvent('coral:needs-updated')); await import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.updateInboxTab()); await new Promise(r => setTimeout(r, 60)); } return true; })()`);
            const lift = async () => { if (mobile) { await Input.dispatchTouchEvent({ type: 'touchEnd', touchPoints: [] }); } else await Input.dispatchMouseEvent({ type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 }); };
            const press = async () => { if (mobile) await Input.dispatchTouchEvent({ type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y }] }); else await Input.dispatchMouseEvent({ type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 }); };
            await ev(`window.__heldBtn = [...document.querySelectorAll('.team-needs-body .inbox-answer')].find(x => x.getClientRects().length); true`);
            await press();
            await churn(3);
            const replaced = await ev(`!window.__heldBtn.isConnected`);
            await lift();
            await waitFor(`window.__answers.length >= 1`, `${w}: the tap sent its answer although the row was redrawn under the finger (button replaced: ${replaced})`, 5000);
            const got = await ev(`window.__answers`);
            assert.equal(got.length, 1, `${w}: sent once: ${JSON.stringify(got)}`);
            assert.equal(got[0].label, 'Red', `${w}: the answer is the pressed choice: ${JSON.stringify(got)}`);
            console.log(`${w}: button replaced during press: ${replaced}`);
        }
        console.log('inbox_answer_live_update_browser: ok');
    } finally { await api('DELETE', '/api/board/team-a', {}).catch(() => {}); try { client.close(); } catch {} }
})().catch(e => { console.error(e); process.exit(1); });
