// Claude's "Claude wants to use your browser" prompt is answered from the REAL Needs you row (#14151, the Beta Tester's inbox-only run): the server reads the unnumbered menu by structure (browser_menu), the row draws ONE
// button, "Not now" (a one-time No: Claude goes on without browser tools), with a plain sentence of what it does and why Install extension and Don't ask again are not buttons; a menu that is not exactly this one gets no button.
// 1280 and 390 px, real clicks. The agent, its chat reply and the answer route are stubbed as inbox_trust_row_browser does; the Inbox, its table and the phone's fold are real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const MENU = (extra = {}) => ({ question: 'Claude wants to use your browser This task could use your Chrome browser.', title: 'Claude wants to use your browser', ask_id: 'browser-ask', unnumbered: true, browser_menu: true, options: [{ n: 1, label: 'Install extension', action: 'select' }, { n: 2, label: 'Not now', action: 'select', selected: true }, { n: 3, label: "Don't ask again", action: 'select' }], ...extra });

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.__answers = []; window.__status = 200; window.__po = ${JSON.stringify(MENU())}; window.__ws = 1; window.__waiting = true;
                const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                    if (m === 'POST' && /\\/answer-prompt$/.test(url)) { window.__answers.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify(window.__status === 200 ? { ok: true } : { code: 'trust_changed', error: 'The folder to trust changed.' }), { status: window.__status, headers: { 'content-type': 'application/json' } })); }
                    if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(url)) return Promise.resolve(new Response(JSON.stringify({ messages: [], total: 0, prompt_options: window.__po }), { headers: { 'content-type': 'application/json' } }));
                    return real(u, o); };
                const entry = window.__m.entry.bind(window.__m); window.__m.entry = a => ({ ...entry(a), board_job_title: 'QA Engineer', waiting_for_input: window.__waiting, waiting_kind: 'permission', waiting_summary: 'Notification: Claude wants to use your browser', waiting_since: 'w' + window.__ws });
                window.__m.add('qa', 'A', 4, { sleeping: false, board_project: 'team-a', session_id: 'qa-id' }); true`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 1`, `${at}the agent`, 8000);
            const refresh = () => ev(`window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.updateInboxTab()); true`);
            await refresh();
            await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '1'`, `${at}the waiting badge`, 8000);
            if (mobile) { // the phone's real path: the view menu, then the Inbox's list
                await ev(`document.getElementById('nav-select').click(); true`);
                await waitFor(`!!document.querySelector('#nav-more-menu [data-arg="hub-inbox"]')`, `${at}Inbox in the view menu`, 5000);
                await ev(`document.querySelector('#nav-more-menu [data-arg="hub-inbox"]').click(); true`);
                await waitFor(`!!document.querySelector('#mobile-inbox-list .sidebar-pane')`, `${at}the phone list of the Inbox`, 8000);
            } else await ev(`document.getElementById('nav-tab-hub-inbox').click(); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);

            const rowButtons = () => ev(`[...document.querySelectorAll('#group-table-view .inbox-answers button:not(.inbox-dismiss)')].map(b => b.textContent)`);
            // a real click on a button of the row: scrolled into view, the point on it is the button itself, never something over it
            const click = async text => {
                await waitFor(`!document.querySelector('#group-table-view .inbox-answers button.inbox-arming')`, `${at}a freshly drawn Yes is armed after 400 ms (#14302)`, 3000).catch(() => {});
                const p = await ev(`(() => { const b = [...document.querySelectorAll('#group-table-view .inbox-answers button')].find(x => x.textContent === ${JSON.stringify(text)}); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y); return { x, y, ok: !!hit && (hit === b || b.contains(hit)), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; })()`);
                if (!p) return null;
                await Input.dispatchMouseEvent({ type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await Input.dispatchMouseEvent({ type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
                return p;
            };
            // a new ask in the row: the agent stops waiting (the row goes) and waits again on this menu
            const show = async (po, expect) => {
                await Input.dispatchMouseEvent({ type: 'mouseMoved', x: 4, y: 4 }); // the pointer is off the list (a pointer resting on it holds the rows still, #14173)
                await ev(`window.__waiting = false; window.__answers = []; window.__status = 200; true`); await refresh();
                await waitFor(`document.querySelectorAll('#group-table-view tbody .dt-primary').length === 0`, `${at}the row leaves`, 8000);
                await ev(`window.__po = ${JSON.stringify(po)}; window.__ws += 1; window.__waiting = true; true`); await refresh();
                await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:needs' && document.querySelectorAll('#group-table-view .inbox-answers button:not(.inbox-dismiss)').length === ${expect}`, `${at}the row's ${expect} choice(s)`, 10000);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: the folded table settles after the first paint
            };

            // 1) the menu on the real row: one button, the sentence, reachable
            await show(MENU(), 1);
            assert.deepEqual(await rowButtons(), ['Not now'], `${at}only Not now is a button`);
            const note = await ev(`(() => { const n = document.querySelector('#group-table-view .inbox-answers .inbox-browser-note'); return n && n.textContent; })()`);
            check(note && /Not now: Claude goes on without browser tools; nothing is installed/.test(note) && /open the agent/.test(note), `${at}the sentence says what Not now does and where the rest is: ` + JSON.stringify(note));
            const geo = await ev(`(() => { const bs = [...document.querySelectorAll('#group-table-view .inbox-answers button:not(.inbox-dismiss)')].map(b => { b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right) }; }); const n = document.querySelector('#group-table-view .inbox-browser-note'); n.scrollIntoView({ block: 'center' }); const nr = n.getBoundingClientRect(); return { bs, vw: innerWidth, noteLeft: Math.round(nr.left), noteRight: Math.round(nr.right), wide: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
            check(geo.bs.every(b => b.left >= 0 && b.right <= geo.vw && b.w > 0) && geo.noteLeft >= 0 && geo.noteRight <= geo.vw && !geo.wide, `${at}the button and the sentence are on the screen, nothing sideways: ` + JSON.stringify(geo));
            if (mobile) check(geo.bs.every(b => b.h >= 44 && b.w >= 44), `${at}Not now is a 44 px target: ` + JSON.stringify(geo));
            await shot(`browser-row-${w}`);

            // 2) one real click sends Not now (n 2) through the chat's route with the ask, and nothing else
            const p = await click('Not now');
            check(p && p.ok, `${at}a real click lands on Not now, nothing covers it: ` + JSON.stringify(p));
            await waitFor(`window.__answers.length === 1`, `${at}Not now is sent`, 5000);
            const sent = await ev(`window.__answers`);
            check(sent.length === 1 && sent[0].session_id === 'qa-id' && sent[0].n === 2 && sent[0].label === 'Not now' && sent[0].ask_id === 'browser-ask' && !('trust_folder' in sent[0]), `${at}one answer: Not now, the ask, no folder: ` + JSON.stringify(sent));
            await waitFor(`/^Answered: Not now$/.test(document.querySelector('#group-table-view .inbox-answers').textContent)`, `${at}the row says Answered`, 5000);

            // 3) not exactly this menu: no button on the row (the old behaviour, Open agent)
            const cases = {
                'the server did not mark it': MENU({ browser_menu: false }),
                'a label changed': MENU({ options: [{ n: 1, label: 'Install extension', action: 'select' }, { n: 2, label: 'Not ever', action: 'select' }, { n: 3, label: "Don't ask again", action: 'select' }] }),
                'a fourth option': MENU({ options: [{ n: 1, label: 'Install extension', action: 'select' }, { n: 2, label: 'Not now', action: 'select' }, { n: 3, label: "Don't ask again", action: 'select' }, { n: 4, label: 'Allow everything', action: 'select' }] }),
                'another order': MENU({ options: [{ n: 1, label: "Don't ask again", action: 'select' }, { n: 2, label: 'Not now', action: 'select' }, { n: 3, label: 'Install extension', action: 'select' }] }),
            };
            for (const [name, po] of Object.entries(cases)) {
                await Input.dispatchMouseEvent({ type: 'mouseMoved', x: 4, y: 4 }); // off the list
                await ev(`window.__waiting = false; true`); await refresh();
                await waitFor(`document.querySelectorAll('#group-table-view tbody .dt-primary').length === 0`, `${at}${name}: the row leaves`, 8000);
                await ev(`window.__po = ${JSON.stringify(po)}; window.__ws += 1; window.__waiting = true; window.__answers = []; true`); await refresh();
                await waitFor(`document.querySelectorAll('#group-table-view tbody .dt-primary').length === 1`, `${at}${name}: the row`, 8000);
                await new Promise(r => setTimeout(r, 600)); // sleep-ok: the choices are read once the row is drawn
                const got = await rowButtons();
                check((await ev(`document.querySelectorAll('#group-table-view .inbox-answers .inbox-answer').length`)) === 0 && JSON.stringify(got) === JSON.stringify(['Open agent']) && !(await ev(`!!document.querySelector('#group-table-view .inbox-browser-note')`)), `${at}${name}: ZERO answer buttons (only Open agent) and no browser sentence (the menu is not exactly this one): ` + JSON.stringify(got));
            }
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log("PASS Claude's browser prompt is answered from the real Needs you row: only Not now is a button, with its sentence, one real click sends it, any other menu gets no button, at 1280 and 390");
})().catch(e => { console.error(e); process.exit(1); });
