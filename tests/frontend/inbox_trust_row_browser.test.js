// The folder-trust prompt is answered from the REAL Needs you row (#14110, the beta run's inbox-only user; Security's conditions; the UI Reviewer's integration MUST): a waiting agent's row in the open Inbox, at 1280 and
// at 390 px (the phone's list), by real clicks: "No, exit" and "Yes, I trust this folder" are drawn on the row as 44 px targets that are on the screen, the folder is plain text with what Yes does, Yes asks once more
// (nothing is written, the keyboard is on Cancel), Cancel writes nothing, the second press sends the exact folder the row showed through the chat's answer route, and a refusal for a changed folder is told and the
// choices are drawn again. Without the server's offer, for a look-alike menu, or for a folder with a hidden character only No is drawn. The agent, its chat reply and the answer route are stubbed as inbox_answer_browser
// does; the Inbox, its table and the phone's fold are real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const WHY = 'The folder on the screen is not the one this agent was started in.';
const FOLDER = '/Users/qa/work/a-very-long-folder-name-for-a-project-that-keeps-going/and-deeper/still-deeper/project';
const MENU = (extra = {}) => ({ question: 'Quick safety check: Is this a project you created or one you trust?', ask_id: 'trust-ask', unnumbered: true, options: [{ n: 1, label: 'No, exit', action: 'select' }, { n: 2, label: 'Yes, I trust this folder', action: 'select' }], trust_folder: FOLDER, trust_offer: true, ...extra });

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
                const entry = window.__m.entry.bind(window.__m); window.__m.entry = a => ({ ...entry(a), board_job_title: 'QA Engineer', waiting_for_input: window.__waiting, waiting_kind: 'permission', waiting_summary: 'Wants to know: trust this folder?', waiting_since: 'w' + window.__ws });
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
            const clickOnce = async text => {
                await waitFor(`!document.querySelector('#group-table-view .inbox-answers button.inbox-arming')`, `${at}a freshly drawn Yes is armed after 400 ms (#14302)`, 3000).catch(() => {});
                const p = await ev(`(() => { const b = [...document.querySelectorAll('#group-table-view .inbox-answers button')].find(x => x.textContent === ${JSON.stringify(text)}); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y); return { x, y, ok: !!hit && (hit === b || b.contains(hit)), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; })()`);
                if (!p) return null;
                await Input.dispatchMouseEvent({ type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await Input.dispatchMouseEvent({ type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
                return p;
            };
            // a toast from the step before (a phone's 'Answered' note sits over the row's bottom edge) covers a button for a few seconds: press only when the point on the button is the button itself (#14586)
            const click = async text => {
                let p = null;
                for (const end = Date.now() + 9000; Date.now() < end;) {
                    const hit = await ev(`(() => { const b = [...document.querySelectorAll('#group-table-view .inbox-answers button')].find(x => x.textContent === ${JSON.stringify(text)}); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(), e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!e && (e === b || b.contains(e)); })()`);
                    if (hit !== false) break; // null: no such button (clickOnce says so); true: nothing covers it
                    await new Promise(r => setTimeout(r, 250)); // sleep-ok: waiting for the toast over the button to go
                }
                p = await clickOnce(text);
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

            // 1) the offered menu on the real row: both choices, the folder as plain text, what Yes does, reachable
            await show(MENU(), 2);
            assert.deepEqual(await rowButtons(), ['No, exit', 'Yes, I trust this folder'], `${at}No and Yes are on the row`);
            const note = await ev(`(() => { const n = document.querySelector('#group-table-view .inbox-answers .inbox-trust-note'), c = n && n.querySelector('code.inbox-trust-path'); return n && { text: n.textContent, path: c && c.textContent }; })()`);
            check(note && note.path === FOLDER && /adds this folder to Claude.s own trust list/.test(note.text), `${at}the folder and what Yes does are on the row: ` + JSON.stringify(note));
            const geo = await ev(`(() => { const bs = [...document.querySelectorAll('#group-table-view .inbox-answers button:not(.inbox-dismiss)')].map(b => { b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right) }; }); return { bs, vw: innerWidth, wide: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
            check(geo.bs.every(b => b.left >= 0 && b.right <= geo.vw && b.w > 0) && !geo.wide, `${at}the choices are on the screen and the page is not wider than it: ` + JSON.stringify(geo));
            if (mobile) check(geo.bs.every(b => b.h >= 44 && b.w >= 44), `${at}each is a 44 px target: ` + JSON.stringify(geo));
            // the whole folder and the sentence are READ on the row, not cut at an edge: the last line of the note is on the screen, inside the note, and the folder wraps instead of running off
            const seen = await ev(`(() => { const n = document.querySelector('#group-table-view .inbox-answers .inbox-trust-note'); if (!n) return null; n.scrollIntoView({ block: 'center' }); const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT); let last = null; while (w.nextNode()) last = w.currentNode; const rg = document.createRange(); rg.selectNodeContents(last); const rs = [...rg.getClientRects()], r = rs[rs.length - 1], c = document.querySelector('#group-table-view .inbox-trust-path').getBoundingClientRect(), hit = document.elementFromPoint(r.left + 2, r.top + r.height / 2); return { lastRight: Math.round(r.right), lastLeft: Math.round(r.left), vw: innerWidth, pathRight: Math.round(c.right), pathLines: Math.round(c.height / parseFloat(getComputedStyle(n).lineHeight || 16)), inside: !!hit && !!hit.closest('.inbox-trust-note') }; })()`);
            check(seen && seen.inside && seen.lastRight <= seen.vw && seen.lastLeft >= 0 && seen.pathRight <= seen.vw && seen.pathLines >= 2, `${at}the whole folder wraps and the sentence under it is on the screen: ` + JSON.stringify(seen));
            await shot(`trust-row-${w}`);

            // 2) Yes asks once more and writes nothing; Cancel writes nothing; the second press sends the folder shown
            const yes = await click('Yes, I trust this folder');
            check(yes && yes.ok, `${at}a real click lands on Yes, nothing covers it: ` + JSON.stringify(yes));
            await waitFor(`!!document.querySelector('#group-table-view .inbox-trust-confirm')`, `${at}Yes asks once more`, 5000);
            const ask = await ev(`(() => { const q = document.querySelector('#group-table-view .inbox-trust-confirm'); return { text: q.textContent, buttons: [...document.querySelectorAll('#group-table-view .inbox-answers button')].map(b => b.textContent), focus: document.activeElement && document.activeElement.textContent, posts: window.__answers.length }; })()`);
            check(ask.text === `Trust ${FOLDER} for Claude, for every agent that starts there?` && ask.posts === 0 && ask.focus === 'Cancel' && ask.buttons.includes('Trust this folder') && ask.buttons.includes('Cancel'), `${at}the question names the folder, nothing is written, the keyboard is on Cancel: ` + JSON.stringify(ask));
            if (mobile) check(await ev(`[...document.querySelectorAll('#group-table-view .inbox-trust-go, #group-table-view .inbox-trust-cancel')].every(b => { b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return r.height >= 44 && r.right <= innerWidth && r.left >= 0; })`), `${at}the confirm buttons are 44 px and on the screen`);
            await click('Cancel');
            await waitFor(`document.querySelectorAll('#group-table-view .inbox-answers button:not(.inbox-dismiss)').length === 2 && !document.querySelector('#group-table-view .inbox-trust-confirm')`, `${at}Cancel draws the choices again`, 5000);
            check((await ev(`window.__answers.length`)) === 0, `${at}Cancel wrote nothing`);
            await click('Yes, I trust this folder'); await waitFor(`!!document.querySelector('#group-table-view .inbox-trust-confirm')`, `${at}asks again`, 5000);
            await click('Trust this folder');
            await waitFor(`window.__answers.length === 1`, `${at}the second press sends the answer`, 5000);
            const sent = await ev(`window.__answers`);
            check(sent.length === 1 && sent[0].session_id === 'qa-id' && sent[0].n === 2 && sent[0].label === 'Yes, I trust this folder' && sent[0].trust_folder === FOLDER && sent[0].ask_id === 'trust-ask', `${at}one answer, the exact folder the row showed, the chat's route and ask: ` + JSON.stringify(sent));
            await waitFor(`/^Answered: Yes, I trust this folder$/.test(document.querySelector('#group-table-view .inbox-answers').textContent)`, `${at}the row says Answered`, 5000);

            // 3) No is one press and sends no folder
            await show(MENU(), 2);
            await click('No, exit');
            await waitFor(`window.__answers.length === 1`, `${at}No is sent at once`, 5000);
            const no = await ev(`window.__answers[0]`);
            check(no.n === 1 && !('trust_folder' in no) && !(await ev(`!!document.querySelector('#group-table-view .inbox-trust-confirm')`)), `${at}No is one press with no confirm and no folder: ` + JSON.stringify(no));

            // 4) not offered, a look-alike menu, a hidden character in the folder: only No (or the one-time rule), never Yes
            const cases = {
                'no offer': [MENU({ trust_offer: false }), 1],
                'no folder': [MENU({ trust_folder: '' }), 1],
                'no offer, with the reason (#14572)': [MENU({ trust_offer: false, trust_why: WHY }), 1],
                'a hidden character in the folder': [MENU({ trust_folder: '/Users/qa/work/pro\u202Eject' }), 1],
                'a lasting Yes with other words': [MENU({ options: [{ n: 1, label: 'No, exit', action: 'select' }, { n: 2, label: 'Yes, always trust this folder', action: 'select' }] }), 0],
                'a third option': [MENU({ options: [{ n: 1, label: 'No, exit', action: 'select' }, { n: 2, label: 'Yes, I trust this folder', action: 'select' }, { n: 3, label: 'Yes, and every folder under it', action: 'select' }] }), 0],
            };
            for (const [name, [po, expect]] of Object.entries(cases)) {
                await Input.dispatchMouseEvent({ type: 'mouseMoved', x: 4, y: 4 }); // off the list
                await ev(`window.__waiting = false; true`); await refresh();
                await waitFor(`document.querySelectorAll('#group-table-view tbody .dt-primary').length === 0`, `${at}${name}: the row leaves`, 8000);
                await ev(`window.__po = ${JSON.stringify(po)}; window.__ws += 1; window.__waiting = true; window.__answers = []; true`); await refresh();
                await waitFor(`document.querySelectorAll('#group-table-view tbody .dt-primary').length === 1`, `${at}${name}: the row`, 8000);
                await new Promise(r => setTimeout(r, 600)); // sleep-ok: the choices are read once the row is drawn
                const all = await rowButtons(), got = all.filter(l => l !== 'Review and trust'); // #15090: a held trust menu has a Review and trust button that opens the card with Yes (the row itself still has no Yes, #14110)
                const heldMenu = ['no offer', 'no folder', 'no offer, with the reason (#14572)', 'a hidden character in the folder'].includes(name);
                check(all.includes('Review and trust') === heldMenu, `${at}${name}: Review and trust is on a held trust row and nowhere else: ` + JSON.stringify(all));
                if (name === 'no offer, with the reason (#14572)') {
                    await ev(`[...document.querySelectorAll('#group-table-view .inbox-answers button')].find(b => b.textContent === 'Review and trust').click(); true`);
                    await waitFor(`!!document.querySelector('dialog.inbox-card-dialog[open]')`, `${at}Review and trust opens the card`, 6000);
                    await waitFor(`[...document.querySelectorAll('dialog.inbox-card-dialog button')].some(b => b.textContent === 'Yes, I trust this folder')`, `${at}the card offers Yes, I trust this folder`, 6000);
                    check(await ev(`[...document.querySelectorAll('dialog.inbox-card-dialog button')].some(b => b.textContent === 'No, exit')`), `${at}the card offers No, exit too`);
                    await ev(`[...document.querySelectorAll('dialog.inbox-card-dialog button')].find(b => b.textContent === 'Close').click(); true`);
                    await waitFor(`!document.querySelector('dialog.inbox-card-dialog')`, `${at}the card closes`, 4000);
                }
                check(!got.some(l => /trust/i.test(l)) && (expect === 0 ? JSON.stringify(got) === JSON.stringify(['Open agent']) : got.length === expect), `${at}${name}: no Yes on the row (${expect ? expect + ' choice' : 'only Open agent'}): ` + JSON.stringify(got));
                if (name === 'no offer' || name === 'no folder' || name === 'a hidden character in the folder') check(JSON.stringify(got) === JSON.stringify(['No, exit']) && /open the agent/i.test(await ev(`document.querySelector('#group-table-view .inbox-answers').textContent`)), `${at}${name}: No only, the rest is left to Open: ` + JSON.stringify(got));
                if (name === 'no offer, with the reason (#14572)') check((await ev(`document.querySelector('#group-table-view .inbox-only-reject')?.textContent || ''`)).includes(`No Yes here: ${WHY} Open the agent to answer.`), `${at}${name}: the row says why there is no Yes`);
            }

            // 5) the server refuses the Yes (the folder changed): told, nothing claimed, the choices drawn again
            await show(MENU(), 2);
            await ev(`window.__status = 409; true`);
            await click('Yes, I trust this folder'); await waitFor(`!!document.querySelector('#group-table-view .inbox-trust-confirm')`, `${at}asks`, 5000);
            await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); true`);
            await click('Trust this folder');
            await waitFor(`[...document.querySelectorAll('.toast .toast-message')].some(e => /folder to trust changed/.test(e.textContent))`, `${at}the refusal is told`, 8000);
            await waitFor(`document.querySelectorAll('#group-table-view .inbox-answers button:not(.inbox-dismiss)').length === 2`, `${at}the choices are drawn again`, 8000);
            check(!/Answered/.test(await ev(`document.querySelector('#group-table-view .inbox-answers').textContent`)), `${at}a refused Yes is not Answered`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS the folder-trust prompt is answered from the real Needs you row: both choices reachable, the folder as text, a second press before Yes, Cancel writes nothing, no Yes unless offered, a refusal told, at 1280 and 390');
})().catch(e => { console.error(e); process.exit(1); });
