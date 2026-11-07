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
                await ev(`window.__waiting = false; window.__answers = []; window.__status = 200; true`); await refresh();
                await waitFor(`document.querySelectorAll('#group-table-view tbody .dt-primary').length === 0`, `${at}the row leaves`, 8000);
                await ev(`window.__po = ${JSON.stringify(po)}; window.__ws += 1; window.__waiting = true; true`); await refresh();
                await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:needs' && document.querySelectorAll('#group-table-view .inbox-answers button:not(.inbox-dismiss):not(.inbox-cmd-more)').length === ${expect}`, `${at}the row's ${expect} choice(s)`, 10000);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: the folded table settles after the first paint
            };

            // what the row draws: the block (every line of the command, wrapped), Claude's own line under it, the Yes sentence, and whether a Yes is on the row; the invariant: Yes is on the row exactly when the block is not clipped
            const rowState = () => ev(`(() => { const c = document.querySelector('#group-table-view .inbox-answers'); const blk = c && c.querySelector('.inbox-cmd-block'); if (!blk) return null; const r = blk.getBoundingClientRect(); const yes = [...c.querySelectorAll('button:not(.inbox-dismiss):not(.inbox-cmd-more)')].filter(b => b.textContent === 'Yes' && !b.hidden && b.getClientRects().length > 0); return { text: blk.textContent, note: (c.querySelector('.inbox-cmd-note') || {}).textContent || '', sentence: (c.querySelector('.inbox-yes-note') || {}).textContent || '', clipped: blk.scrollHeight > blk.clientHeight + 1, yes: yes.length, no: [...c.querySelectorAll('button')].filter(b => b.textContent === 'No').length, h: Math.round(r.height), lines: Math.round(blk.clientHeight / (parseFloat(getComputedStyle(blk).lineHeight) || 1)), left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, mono: /mono|courier|menlo|consolas|ui-monospace/i.test(getComputedStyle(blk).fontFamily) }; })()`);
            const consistent = (s, what) => check(s && (s.yes === 1) === !s.clipped && s.no === 1, `${at}${what}: Yes is on the row exactly when the block is not clipped, No always: ` + JSON.stringify(s));
            // 1) a one-line command, with Claude's own line under it: whole, in code type, Yes and No
            const ONE = 'git status --short';
            await show(MENU({ target: ONE, target_note: 'This command requires approval' }), 2);
            let st = await rowState();
            check(st && st.text === ONE && st.note === 'This command requires approval' && st.mono && !st.clipped && st.yes === 1 && st.no === 1 && st.left >= 0 && st.right <= st.vw, `${at}a one-line command with Claude's line under it: ` + JSON.stringify(st));
            check(/Yes lets it run this once\. No refuses it/.test(st.sentence), `${at}the row says what Yes allows: ` + JSON.stringify(st.sentence));
            await shot(`command-row-${w}`);
            // 2) the three-line command: all of it is on the row and not clipped (3 lines on a desktop, 4 on a phone), so Yes stays
            await show(MENU({ target: ['npm run build', 'npm test -- --reporter=dot', 'git status --short'].join('\n') }), 2);
            st = await rowState(); consistent(st, 'three short lines');
            check(st && st.text.includes('npm test -- --reporter=dot') && !st.clipped, `${at}three short lines fit and are all on the row: ` + JSON.stringify(st));
            // 3) a long command: the row shows the start and "Show all"; Yes is NOT on the row and says so; Show all opens the whole command in a capped box that scrolls inside; Yes turns on only once the person has reached its end
            const longStates = async (target, note, what) => {
                await show(MENU({ target, target_note: note }), 2);
                let s0 = await rowState();
                check(s0 && s0.clipped && s0.yes === 0 && s0.no === 1 && /Read the whole command to allow it: press Show all/.test(s0.sentence), `${at}${what}: clipped, no Yes, 'Read the whole command to allow it': ` + JSON.stringify(s0));
                check(await ev(`(() => { const m = document.querySelector('#group-table-view .inbox-cmd-more'); return !!m && !m.hidden && m.getClientRects().length > 0; })()`), `${at}${what}: a Show all button is on the row`);
                // a Yes forced from outside while it is locked sends nothing
                await ev(`document.querySelectorAll('#group-table-view .inbox-answers button').forEach(b => { if (b.textContent === 'Yes') b.click(); }); true`);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: a refused click settles
                check((await ev(`window.__answers.length`)) === 0, `${at}${what}: a locked Yes sends nothing`);
                await ev(`document.querySelector('#group-table-view .inbox-cmd-more').click(); true`);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: the box grows and the observer reports
                const open = await ev(`(() => { const b = document.querySelector('#group-table-view .inbox-cmd-block'), r = b.getBoundingClientRect(); return { open: b.classList.contains('is-open'), scrolls: b.scrollHeight > b.clientHeight + 4, h: Math.round(r.height), vh: innerHeight, yes: [...document.querySelectorAll('#group-table-view .inbox-answers button')].filter(x => x.textContent === 'Yes' && !x.hidden).length, sentence: (document.querySelector('#group-table-view .inbox-yes-note') || {}).textContent, focused: document.activeElement === b }; })()`);
                check(open.open && open.scrolls && open.h < open.vh && open.yes === 0 && /scroll to the end/.test(open.sentence), `${at}${what}: Show all opens a box that scrolls inside, Yes still locked: ` + JSON.stringify(open));
                await shot(`command-open-${what.replace(/\W+/g, '-')}-${w}`);
                await ev(`(() => { const b = document.querySelector('#group-table-view .inbox-cmd-block'); b.scrollTop = b.scrollHeight; return true; })()`);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: the scroll event reaches the row
                const end = await ev(`(() => { const c = document.querySelector('#group-table-view .inbox-answers'); return { yes: [...c.querySelectorAll('button')].filter(x => x.textContent === 'Yes' && !x.hidden && x.getClientRects().length > 0).length, sentence: c.querySelector('.inbox-yes-note').textContent }; })()`);
                check(end.yes === 1 && /Yes lets it run this once/.test(end.sentence), `${at}${what}: at the end of the command Yes is on the row: ` + JSON.stringify(end));
                // and Yes now sends the answer for the whole command's ask
                await click('Yes');
                await waitFor(`window.__answers.length === 1`, `${at}${what}: Yes sends once it is unlocked`, 5000);
                check((await ev(`window.__answers[0]`)).ask_id === 'cmd-ask', `${at}${what}: the answer carries the ask`);
            };
            await longStates(Array.from({ length: 12 }, (_, i) => 'step' + (i + 1) + ' --flag=' + i + ' --another-long-option=' + 'v'.repeat(20)).join('\n'), 'This command requires approval', 'twelve lines');
            // a REAL long capture (the Beta Tester's run 2, 17 screen lines): the same
            const real = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../coral-go/internal/server/routes/testdata/claude_bash_long_real.txt'), 'utf8').split('\n');
            const rules = real.map((l, i) => /^\s*╌{8,}\s*$/.test(l) ? i : -1).filter(i => i >= 0);
            const REAL = real.slice(rules[0] + 1, rules[1]).map(l => l.replace(/^ /, '')).join('\n').trim(), REALNOTE = real.slice(rules[1] + 1).map(l => l.trim()).find(l => l && !/^Do you want/.test(l));
            await longStates(REAL, REALNOTE, 'a real long capture');
            await show(MENU({ target: 'cleanup' }), 2); // a fresh row for the cases below
            // 4) UI Reviewer's case: ONE line under 160 characters that does not fit the row (a long word cannot break at a space, it wraps by letter); then no Yes if the block is clipped at this width
            const MID = 'echo ' + 'x'.repeat(150);
            await show(MENU({ target: MID }), 2);
            st = await rowState(); consistent(st, 'one line under 160 characters');
            // and a single line that is too long for any row: clipped, No only
            await show(MENU({ target: 'echo ' + 'x'.repeat(420) }), 2);
            st = await rowState();
            check(st && st.clipped && st.yes === 0 && /Read the whole command to allow it/.test(st.sentence), `${at}one very long line is clipped: no Yes, said so: ` + JSON.stringify(st));
            // 5) the width changes (a window resized, a phone turned): the gate is measured again
            await show(MENU({ target: 'echo ' + 'y'.repeat(260) }), 2);
            const widths = mobile ? [[390, 844], [900, 844], [390, 844]] : [[1280, 900], [700, 900], [1280, 900]];
            for (const [rw, rh] of widths) {
                await Emulation.setDeviceMetricsOverride({ width: rw, height: rh, deviceScaleFactor: 1, mobile }); await new Promise(r => setTimeout(r, 500)); // sleep-ok: the resize observer reports after layout
                const rs = await rowState();
                check(rs && ((rs.yes === 1) === !rs.clipped), `${at}after resizing to ${rw}: Yes is on the row exactly when the block is not clipped: ` + JSON.stringify(rs));
            }
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            // a request that can only be rejected shows its command too, and no Yes
            await show(MENU({ only_reject: true, target: ONE }), 1);
            st = await rowState();
            check(st && st.yes === 0 && st.no === 1 && st.text === ONE, `${at}a reject-only request shows its command and offers no Yes: ` + JSON.stringify(st));

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
