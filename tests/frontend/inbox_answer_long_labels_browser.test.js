// #13688 adds390/320: phone choices wrap as whole buttons; oversized tokens ellipsize with full accessible labels.
// The choices of an agent's question in a Needs you row fit the row (#11728, the operator's shot at about 950 px: 'Desktop app, nar...', 'Browser on the M...'): long labels wrap their words inside their column, never clipped;
// the same row as inbox_answer_browser (the card's choices stubbed). 950 and 1440. Was: Answering from the Inbox (#10400, Beta tester #10394): a Needs you row for an agent that asks a question carries the card's own choices as buttons; one press sends the answer through the chat card's route
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
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h, mobile] of [[950, 800, false], [1440, 900, false], [390, 844, true], [320, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.__answers = []; window.__multi = false; window.__answerLabels = ${JSON.stringify(mobile ? ['Celsius','Fahrenheit','Kelvin','Supercalifragilisticexpialidocious'.repeat(3)] : ['Desktop app, narrow screens and a long second line of words','Browser on the Mac, with the sidebar open and the window small','Always pick Red from now on'])};
                const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                    if (m === 'POST' && /\\/answer-prompt$/.test(url)) { window.__answers.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })); }
                    if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(url)) return Promise.resolve(new Response(JSON.stringify({ messages: [], total: 0, prompt_options: { question: 'Pick a color:', ask_id: 'ask-1', multi: window.__multi, options: window.__answerLabels.map((label,i)=>({n:i+1,label,action:'select'})) } }), { headers: { 'content-type': 'application/json' } }));
                    return real(u, o); };
                const entry = window.__m.entry.bind(window.__m); window.__waiting = true; window.__m.entry = a => ({ ...entry(a), board_job_title: 'QA Engineer', waiting_for_input: window.__waiting, waiting_kind: 'permission', waiting_summary: 'Wants to know: Pick a color' });
                window.__m.add('qa', 'A', 4, { sleeping: false, board_project: 'team-a', session_id: 'qa-id' }); true`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 1`, `${w}: the agent`, 8000);
            await ev(`window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.updateInboxTab()); true`);
            await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '1'`, `${w}: waiting badge`, 8000);
            await ev(`document.getElementById('nav-tab-hub-inbox').click(); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:needs' && document.querySelectorAll('#group-table-view .inbox-answer').length === ${mobile ? 4 : 2}`, `${w}: the row's choices`, 10000);
            await ev(`new Promise(r => setTimeout(r, 500))`); // sleep-ok: the row settles after the choices are read
            const g = await ev(`(() => { const bs = [...document.querySelectorAll('#group-table-view .inbox-answer')], cell = bs[0].closest('td'), c = cell.getBoundingClientRect(), box = document.querySelector('#group-table-view .dt-box').getBoundingClientRect();
                return { buttons: bs.map(b => { const r = b.getBoundingClientRect(); return { text: b.textContent.length, label: b.textContent, name: b.getAttribute('aria-label'), lines: (()=>{const range=document.createRange();range.selectNodeContents(b);return new Set(Array.from(range.getClientRects()).map(r=>Math.round(r.top))).size;})(), inside: r.left >= c.left - 1 && r.right <= c.right + 1, whole: b.scrollWidth <= b.clientWidth + 1 && b.scrollHeight <= b.clientHeight + 1, h: Math.round(r.height), w: Math.round(r.width) }; }), cellW: Math.round(c.width), cellInBox: c.right <= box.right + 1, scrollsSideways: document.querySelector('#group-table-view .dt-box').scrollWidth > document.querySelector('#group-table-view .dt-box').clientWidth + 1 }; })()`);
            await shot(`inbox-answer-long-${w}`);
            if (mobile) { check(g.buttons.every(b=>b.lines===1&&b.h>=44), `${w}: labels never split mid-word and targets stay44px: ${JSON.stringify(g)}`); check(g.buttons.every(b=>b.name.includes(b.label)), `${w}: full label stays accessible`); check(g.buttons.find(b=>b.label==='Fahrenheit').whole, `${w}: Fahrenheit is fully visible`); }
            else check(g.buttons.every(b => b.whole), `${w} px: each choice shows its whole words (wrapped, not clipped): ${JSON.stringify(g)}`);
            check(g.buttons.every(b => b.inside) && g.cellInBox && !g.scrollsSideways, `${w} px: the choices are inside their column and the table does not scroll sideways: ${JSON.stringify(g)}`);
            check(await ev(`document.querySelectorAll('#group-table-view .inbox-answer').length === ${mobile ? 4 : 2} && [...document.querySelectorAll('#group-table-view .inbox-answer')].every(b => b.getAttribute('aria-label') && b.getAttribute('aria-label').startsWith('Answer '))`), `${w} px: each choice keeps its name for a screen reader`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('inbox_answer_long_labels_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
