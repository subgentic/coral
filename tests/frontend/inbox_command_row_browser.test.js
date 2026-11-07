// #14173 (the Beta Tester's second run): a permission row shows the command it wants to run, one line cut with an ellipsis, with what Yes allows (the whole command is the tooltip and the card's text); and while a mouse pointer
// rests over the list, a new row that arrives does not move the rows under it (a click opened the wrong item): a line says new items wait, and they appear when the pointer leaves. 1280 and 390 px, real clicks and a real pointer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const CMD = ['cd /Users/qa/work/app && npm run build -- --mode=production --out-dir=dist/releases/2026-11-07/with/a/very/long/path/that/keeps/going/and/going/and/going/and/going/and/going/and/going', 'npm test -- --reporter=dot', 'git status --short'].join('\n');
const MENU = (extra = {}) => ({ question: 'Bash command Do you want to proceed?', title: 'Bash command', ask_id: 'cmd-ask', target: CMD, options: [{ n: 1, label: 'Yes', action: 'select', selected: true }, { n: 2, label: 'No', action: 'select' }], ...extra });

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
                const entry = window.__m.entry.bind(window.__m); window.__m.entry = a => ({ ...entry(a), board_job_title: 'QA Engineer', waiting_for_input: window.__waiting, waiting_kind: 'permission', waiting_summary: 'Notification: Claude needs your permission', waiting_since: 'w' + window.__ws });
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
                const p = await ev(`(() => { const b = [...document.querySelectorAll('#group-table-view .inbox-answers button')].find(x => x.textContent === ${JSON.stringify(text)}); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y); return { x, y, ok: !!hit && (hit === b || b.contains(hit)), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; })()`);
                if (!p) return null;
                await Input.dispatchMouseEvent({ type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await Input.dispatchMouseEvent({ type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
                return p;
            };
            // a new ask in the row: the agent stops waiting (the row goes) and waits again on this menu
            const show = async (po, expect) => {
                await ev(`window.__waiting = false; window.__answers = []; window.__status = 200; true`); await refresh();
                await waitFor(`document.querySelectorAll('#group-table-view tbody .dt-primary').length === 0`, `${at}the row leaves`, 8000);
                await ev(`window.__po = ${JSON.stringify(po)}; window.__ws += 1; window.__waiting = true; true`); await refresh();
                await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:needs' && document.querySelectorAll('#group-table-view .inbox-answers button:not(.inbox-dismiss)').length === ${expect}`, `${at}the row's ${expect} choice(s)`, 10000);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: the folded table settles after the first paint
            };

            // 1) a one-line command is on the row whole: the command, what Yes allows, Yes and No
            const ONE = 'git status --short';
            await show(MENU({ target: ONE }), 2);
            const one = await ev(`(() => { const c = document.querySelector('#group-table-view .inbox-answers .inbox-cmd'); if (!c) return null; const r = c.getBoundingClientRect(); return { text: c.textContent, title: c.title, h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, lh: parseFloat(getComputedStyle(c).lineHeight) || parseFloat(getComputedStyle(c).fontSize) * 1.4 }; })()`);
            check(one && one.text === 'Wants to run git status --short' && one.title === ONE && one.h <= one.lh * 1.6 && one.left >= 0 && one.right <= one.vw, `${at}a one-line command is on the row: ` + JSON.stringify(one));
            check(/Yes lets it run this once\. No refuses it/.test(await ev(`(document.querySelector('#group-table-view .inbox-answers .inbox-yes-note') || {}).textContent`) || ''), `${at}the row says what Yes allows`);
            assert.deepEqual(await rowButtons(), ['Yes', 'No'], `${at}Yes and No stay for a command shown whole`);
            await shot(`command-row-${w}`);
            // 2) a command of several lines, or one cut at the row's width, is NOT shown whole: the first line, one line with an ellipsis, the whole text as its tooltip, and only No on the row (Security's SHOULD)
            await show(MENU(), 1);
            const cmd = await ev(`(() => { const c = document.querySelector('#group-table-view .inbox-answers .inbox-cmd'); if (!c) return null; const r = c.getBoundingClientRect(); return { text: c.textContent, h: Math.round(r.height), cut: c.scrollWidth > c.clientWidth + 1 || c.textContent.endsWith('…'), title: c.title, left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, lh: parseFloat(getComputedStyle(c).lineHeight) || parseFloat(getComputedStyle(c).fontSize) * 1.4 }; })()`);
            check(cmd && /^Wants to run cd \/Users\/qa\/work\/app && npm run build/.test(cmd.text) && cmd.title.startsWith('cd /Users/qa/work/app'), `${at}the first line of the command is on the row: ` + JSON.stringify(cmd));
            check(cmd && cmd.h <= cmd.lh * 1.6 && cmd.cut && cmd.left >= 0 && cmd.right <= cmd.vw, `${at}one line, cut with an ellipsis, on the screen: ` + JSON.stringify(cmd));
            check(cmd && cmd.title.includes('npm test -- --reporter=dot') && cmd.title.includes('git status --short'), `${at}the whole command (all three lines) is the tooltip: ` + JSON.stringify(cmd && cmd.title));
            assert.deepEqual(await rowButtons(), ['No'], `${at}only No on a command the row does not show whole`);
            check(/longer than one line, so it can only be refused here/.test(await ev(`(document.querySelector('#group-table-view .inbox-answers .inbox-yes-note') || {}).textContent`) || ''), `${at}the row says why there is no Yes`);
            await show(MENU({ target: 'echo ' + 'x'.repeat(200) }), 1);
            assert.deepEqual(await rowButtons(), ['No'], `${at}one line of more than 160 characters is cut on the row: only No`);
            // a request that can only be rejected shows its command too, and no Yes sentence
            await show(MENU({ only_reject: true, target: ONE }), 1);
            check(!!(await ev(`!!document.querySelector('#group-table-view .inbox-answers .inbox-cmd')`)) && !(await ev(`!!document.querySelector('#group-table-view .inbox-yes-note')`)), `${at}a reject-only request still shows its command and offers no Yes sentence`);

            if (!mobile) { // 3) a pointer resting over the list holds the rows
                await show(MENU({ target: ONE }), 2);
                const top0 = await ev(`(() => { const r = document.querySelector('#group-table-view tbody tr'); r.scrollIntoView({ block: 'center' }); const b = r.getBoundingClientRect(); return { top: Math.round(b.top), x: Math.round(b.left + 120), y: Math.round(b.top + b.height / 2), rows: document.querySelectorAll('#group-table-view tbody tr').length }; })()`);
                await Input.dispatchMouseEvent({ type: 'mouseMoved', x: top0.x, y: top0.y });
                await new Promise(r => setTimeout(r, 300)); // sleep-ok: the pointer events reach the page
                await ev(`window.__m.add('qa2', 'B', 5, { sleeping: false, board_project: 'team-a', session_id: 'qa2-id' }); window.__ws += 1; true`);
                await ev(`window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); true`);
                await refresh();
                await new Promise(r => setTimeout(r, 1200)); // sleep-ok: the table would have redrawn by now
                const held = await ev(`(() => { const r = document.querySelector('#group-table-view tbody tr').getBoundingClientRect(); return { top: Math.round(r.top), rows: document.querySelectorAll('#group-table-view tbody tr').length, note: (document.querySelector('#group-table-view .group-table-held') || {}).textContent || '' }; })()`);
                check(held.top === top0.top && held.rows === top0.rows && /New items are waiting/.test(held.note), `${at}with the pointer on the list the rows did not move and the table says new items wait: before ` + JSON.stringify(top0) + ' after ' + JSON.stringify(held));
                await shot(`hover-held-${w}`);
                await Input.dispatchMouseEvent({ type: 'mouseMoved', x: 4, y: 4 });
                await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === ${top0.rows + 1} && !document.querySelector('#group-table-view .group-table-held')`, `${at}the new row appears once the pointer leaves the list, and the note goes`, 8000);
            }
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS a permission row shows its command on one line with what Yes allows, and a pointer on the list holds the rows while a new one arrives, at 1280 and 390');
})().catch(e => { console.error(e); process.exit(1); });
