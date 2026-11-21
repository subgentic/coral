// #19962 (Operator, preview3): the question card is the Permission card's layout; the first line below was #14173's. (the Beta Tester's second run): a permission row shows the command it wants to run, one line cut with an ellipsis, with what Yes allows (the whole command is the tooltip and the card's text); and while a mouse pointer
// rests over the list, a new row that arrives does not move the rows under it (a click opened the wrong item): a line says new items wait, and they appear when the pointer leaves. 1280 and 390 px, real clicks and a real pointer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const _unused = ['cd /Users/qa/work/app && npm run build -- --mode=production --out-dir=dist/releases/2026-11-07/with/a/very/long/path/that/keeps/going/and/going/and/going/and/going/and/going/and/going', 'npm test -- --reporter=dot', 'git status --short'].join('\n');
const MENU = (extra = {}) => ({ question: 'Pick a color:', title: 'Pick a color', ask_id: 'q-ask', options: [{ n: 1, label: 'Red', action: 'select', selected: true }, { n: 2, label: 'Blue', action: 'select' }], ...extra });

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
                    if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(url)) return new Promise(r => setTimeout(() => r(new Response(JSON.stringify({ messages: [], total: 0, prompt_options: window.__po }), { headers: { 'content-type': 'application/json' } })), window.__chatDelay || 0));
                    return real(u, o); };
                const entry = window.__m.entry.bind(window.__m); window.__m.entry = a => ({ ...entry(a), board_job_title: 'QA Engineer', waiting_for_input: window.__waiting, waiting_kind: 'question', agent_type: 'claude', working_directory: '/work/dir', waiting_summary: 'Wants to know: Pick a color', waiting_since: 'w' + window.__ws });
                window.__m.add('qa', 'A', 4, { sleeping: false, board_project: 'seedteam', session_id: 'qa-id' }); true`);
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

            const rowButtons = () => ev(`[...document.querySelectorAll('#group-table-view .inbox-answers button:not(.inbox-dismiss):not(.inbox-cmd-more)')].map(b => b.textContent)`);
            // a real click on a button of the row: scrolled into view, the point on it is the button itself, never something over it
            const click = async text => {
                const p = await ev(`(() => { const b = [...document.querySelectorAll('#group-table-view .inbox-answers button')].find(x => x.textContent === ${JSON.stringify(text)}); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y); return { x, y, ok: !!hit && (hit === b || b.contains(hit)), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; })()`);
                if (!p) return null;
                await Input.dispatchMouseEvent({ type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await Input.dispatchMouseEvent({ type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
                return p;
            };
            // a new ask in the row: the agent stops waiting (the row goes) and waits again on this menu
            const show = async (po, expect) => {
                await Input.dispatchMouseEvent({ type: 'mouseMoved', x: 4, y: 4 }); // the pointer is off the list: a pointer resting on it holds new rows back (walk 23 M9)
                await ev(`window.__waiting = false; window.__answers = []; window.__status = 200; true`); await refresh();
                await waitFor(`document.querySelectorAll('#group-table-view tbody .dt-primary').length === 0`, `${at}the row leaves`, 8000);
                await ev(`window.__po = ${JSON.stringify(po)}; window.__ws += 1; window.__waiting = true; true`); await refresh();
                await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:needs' && document.querySelectorAll('#group-table-view .inbox-answers button:not(.inbox-dismiss):not(.inbox-cmd-more)').length === ${expect}`, `${at}the row's ${expect} choice(s)`, 10000);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: the folded table settles after the first paint
            };

            // what the row draws: the block (every line of the command, wrapped), Claude's own line under it, the Yes sentence, and whether a Yes is on the row; the invariant: Yes is on the row exactly when the block is not clipped
            const rowState = () => ev(`(() => { const c = document.querySelector('#group-table-view .inbox-answers'); const blk = c && c.querySelector('.inbox-cmd-block'); if (!blk) return null; const r = blk.getBoundingClientRect(); const yes = [...c.querySelectorAll('button:not(.inbox-dismiss):not(.inbox-cmd-more)')].filter(b => b.textContent === 'Yes' && !b.hidden && b.getClientRects().length > 0); return { text: blk.textContent, note: (c.querySelector('.inbox-cmd-note') || {}).textContent || '', sentence: (c.querySelector('.inbox-yes-note') || {}).textContent || '', clipped: blk.scrollHeight > blk.clientHeight + 1, yes: yes.length, no: [...c.querySelectorAll('button')].filter(b => b.textContent === 'No').length, h: Math.round(r.height), lines: Math.round(blk.clientHeight / (parseFloat(getComputedStyle(blk).lineHeight) || 1)), left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, mono: /mono|courier|menlo|consolas|ui-monospace/i.test(getComputedStyle(blk).fontFamily) }; })()`);
            const consistent = (s, what) => check(s && (s.yes === 1) === !s.clipped && s.no === 1, `${at}${what}: Yes is on the row exactly when the block is not clipped, No always: ` + JSON.stringify(s));
            // the row's parts never lie over one another (#19870 round 3: 'Claude · dir' was drawn over the command box): the code box, the Yes sentence, the answer buttons and the Claude line each have their own place
            const noOverlap = async what => {
                const o = await ev(`(() => { const row = document.querySelector('#group-table-view .inbox-answers')?.closest('tr'); if (!row) return null; const q = s => [...row.querySelectorAll(s)].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'); const parts = [...q('.inbox-cmd-block').map(e => ['code', e]), ...q('.inbox-yes-note').map(e => ['yes-sentence', e]), ...q('.inbox-answers button').map(e => ['button ' + e.textContent, e]), ...q('.inbox-question-runtime .chip, .inbox-question-runtime').slice(0, 1).map(e => ['claude-line', e])]; const hit = []; for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) { const a = parts[i][1].getBoundingClientRect(), b = parts[j][1].getBoundingClientRect(); if (parts[i][1].contains(parts[j][1]) || parts[j][1].contains(parts[i][1])) continue; if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) hit.push(parts[i][0] + ' over ' + parts[j][0]); } return { n: parts.length, hit }; })()`);
                check(o && o.n >= 3 && o.hit.length === 0, `${at}${what}: no part of the row lies over another: ` + JSON.stringify(o));
            };
            // #19962: the question card is the stacked card of #19941: the question's words once, 'Claude · dir' on ONE line at the left of the choices, the choices and More on ONE line, More last; no dangling dot after the team
            await show(MENU(), 2);
            const g = await ev(`(() => { const tr = document.querySelector('#group-table-view .inbox-answers').closest('tr'); const r = e => e && e.getBoundingClientRect(); const vis = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'; const btn = [...tr.querySelectorAll('.inbox-answers button, .inbox-single-action button, .inbox-row-more-toggle')].filter(vis); const cli = tr.querySelector('.inbox-question-runtime'); const team = tr.querySelector('td[data-key="team"]'); const lbl = [...tr.querySelectorAll('.inbox-answer-step')].filter(vis); const mid = e => Math.round((r(e).top + r(e).bottom) / 2); return { labels: btn.map(b => b.matches('.inbox-row-more-toggle') ? 'More' : b.textContent.trim()), mids: btn.map(mid), cliText: cli ? cli.textContent : '', cliH: cli ? Math.round(r(cli).height) : 0, cliMid: cli ? mid(cli) : 0, cliBottom: cli ? Math.round(r(cli).bottom) : 0, messageTop: r(tr.querySelector('.inbox-message'))?.top || 0, cliRight: cli ? Math.round(r(cli).right) : 0, btnLeft: Math.round(Math.min(...btn.map(b => r(b).left))), step: lbl.map(e => e.textContent.trim()), teamAfter: team ? getComputedStyle(team, '::after').content : 'none', teamText: team ? team.textContent : '', rowH: Math.round(r(tr).height), words: [...tr.querySelectorAll('.inbox-row-words, .dt-subtitle')].map(e => e.textContent.trim()) }; })()`);
            check(g.labels.join() === 'Red,Blue,Dismiss', `${at}the choices then More last: ` + JSON.stringify(g));
            check(Math.max(...g.mids) - Math.min(...g.mids) <= 6, `${at}the choices and More are on one line: ` + JSON.stringify(g));
            check(w < 1000 || /^Claude/.test(g.cliText) && g.cliText.includes("dir") && g.cliH < 30, `${at}'Claude · dir' is one line, not two: ` + JSON.stringify(g));
            check(w < 1000 || (g.cliBottom <= g.messageTop + 1), `${at}Claude's line is above the message and footer (#20203): ` + JSON.stringify(g));
            check(g.step.every(t => !/Pick a color/.test(t)), `${at}the question is not said twice (the label repeats it): ` + JSON.stringify(g));
            check(g.teamAfter === 'none' || g.teamAfter === 'normal', `${at}no dot after the team when the field after it is empty: ` + JSON.stringify(g));
            for (const th of ['light', 'dark']) { await ev(`document.documentElement.setAttribute('data-theme', '${th}'); true`); await shot(`question-row-${w}-${th}`); } await ev(`document.documentElement.removeAttribute('data-theme'); true`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS a question card is the permission card layout: one Claude · dir line, the choices and More on one line, More last, no repeated label, no dangling dot, at 1280 and 390');
})().catch(e => { console.error(e); process.exit(1); });
