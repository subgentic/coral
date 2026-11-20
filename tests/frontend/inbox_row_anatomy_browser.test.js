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
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 600)); /* sleep-ok: the theme colour transition has ended, so the shot is the settled page (#19941) */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.__answers = []; window.__status = 200; window.__po = ${JSON.stringify(MENU())}; window.__poQ = { question: 'Pick a color', ask_id: 'q1', options: [{ n: 1, label: 'Red', action: 'select', selected: true }, { n: 2, label: 'Blue', action: 'select' }] }; window.__ws = 1; window.__waiting = true;
                const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                    if (m === 'POST' && /\\/answer-prompt$/.test(url)) { window.__answers.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify(window.__status === 200 ? { ok: true } : { code: 'trust_changed', error: 'The folder to trust changed.' }), { status: window.__status, headers: { 'content-type': 'application/json' } })); }
                    if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(url)) return new Promise(r => setTimeout(() => r(new Response(JSON.stringify({ messages: [], total: 0, prompt_options: /dev-id/.test(url) ? window.__poQ : window.__po }), { headers: { 'content-type': 'application/json' } })), window.__chatDelay || 0));
                    return real(u, o); };
                const entry = window.__m.entry.bind(window.__m); window.__m.entry = a => ({ ...entry(a), board_job_title: 'QA Engineer', waiting_for_input: window.__waiting, waiting_kind: a.name === 'dev' || (a.session_id === 'dev-id') ? 'question' : 'permission', agent_type: 'claude', working_directory: '/work/app', waiting_summary: (a.session_id === 'dev-id' ? 'Wants to know: Pick a color' : 'Notification: Claude needs your permission'), waiting_since: 'w' + window.__ws });
                window.__m.add('qa', 'A', 4, { sleeping: false, board_project: 'team-a', session_id: 'qa-id' }); window.__m.add('dev', 'B', 5, { sleeping: false, board_project: 'team-a', session_id: 'dev-id' }); true`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 2`, `${at}the agent`, 8000);
            const refresh = () => ev(`window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.updateInboxTab()); true`);
            await refresh();
            await waitFor(`+document.getElementById('nav-tab-hub-inbox-badge').textContent.replace('+','') >= 2`, `${at}the waiting badge`, 8000);
            if (mobile) { // the phone's real path: the view menu, then the Inbox's list
                await ev(`document.getElementById('nav-select').click(); true`);
                await waitFor(`!!document.querySelector('#nav-more-menu [data-arg="hub-inbox"]')`, `${at}Inbox in the view menu`, 5000);
                await ev(`document.querySelector('#nav-more-menu [data-arg="hub-inbox"]').click(); true`);
                await waitFor(`!!document.querySelector('#mobile-inbox-list .sidebar-pane')`, `${at}the phone list of the Inbox`, 8000);
            } else await ev(`document.getElementById('nav-tab-hub-inbox').click(); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);


            // the board's own asks: a plain one, a yes/no, one with buttons (#20016, walk #20009)
            await ev(`(() => { const at = n => new Date(Date.now() - n * 60000).toISOString(); window.__asks = [
                { board: 'logo', board_label: 'Logo', kind: 'ask', id: 71, asker: 'Designer', text: '@Operator Which colour for the logo?', at: at(3), buttons: [{ id: 1, label: 'Blue', action: 'reply', state: 'pending' }, { id: 2, label: 'Green', action: 'reply', state: 'pending' }, { id: 3, label: 'Red', action: 'reply', state: 'pending' }] },
                { board: 'logo', board_label: 'Logo', kind: 'ask', id: 72, asker: 'Dev', text: '@Operator May I delete the old build folder?', at: at(4), buttons: [{ id: 1, label: 'Yes', action: 'reply', state: 'pending' }, { id: 2, label: 'No', action: 'reply', state: 'pending' }] },
                { board: 'logo', board_label: 'Logo', kind: 'ask', id: 73, asker: 'QA', text: '@Operator Is the plan fine?', at: at(5) }];
                const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify(window.__asks), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); return true; })()`);
            await ev(`import((window.__coralStatic || '/static/') + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
            try { await waitFor(`document.querySelectorAll('#group-table-view tbody tr.inbox-kind-row').length >= 5`, `${at}the rows`, 10000); } catch (e) { throw new Error(e.message + ' ' + JSON.stringify(await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(tr => tr.className + ':' + tr.textContent.slice(0, 50))`))); }
            await new Promise(r => setTimeout(r, 600)); // sleep-ok: the folded table settles after the first paint
            const rows = await ev(`(() => { const out = {}; for (const tr of document.querySelectorAll('#group-table-view tbody tr.inbox-card-tr')) { const t = tr.textContent; const key = /Which colour/.test(t) ? 'button' : /delete the old build/.test(t) ? 'yesno' : /plan fine/.test(t) ? 'plain' : /Pick a color/.test(t) ? 'question' : /Wants to run/.test(t) ? 'permission' : /Getting started|Create your|welcome/i.test(t) || tr.querySelector('.inbox-welcome-name') ? 'welcome' : null; if (!key || (out[key] && key !== 'welcome')) continue; const r = e => e && e.getBoundingClientRect(); const vis = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'; const btns = [...tr.querySelectorAll('button, .inbox-row-more-toggle')].filter(vis).filter(b => !b.matches('.dt-star, input, [role=checkbox]') && !b.closest('.inbox-kind-icon')); const act = btns.filter(b => b.closest('.inbox-review-actions, .inbox-answers, .inbox-answers-with-more')); const words = act.map(b => b.textContent.trim()); const pill = tr.querySelector('[data-badge]'); const clip = tr.querySelector('.inbox-kind-icon'); if (!out[key]) out[key] = { words, lastIsMore: words[words.length - 1] === 'More', pill: pill ? pill.getAttribute('data-badge') : '', avatar: !!tr.querySelector('.dt-avatar'), footer: /Claude|·/.test((tr.querySelector('td[data-key="cli"]') || {}).textContent || '') || !!tr.querySelector('.inbox-meta'), h: Math.round(r(tr).height), bg: getComputedStyle(tr).backgroundColor, rail: getComputedStyle(tr).boxShadow + getComputedStyle(tr).borderLeftWidth }; } return out; })()`);
            { const head = await ev(`(() => { const tr = [...document.querySelectorAll('#group-table-view tbody tr')].find(t => t.querySelector('.inbox-cmd-block')); const e = tr && tr.querySelector('td[data-key="agent"] > .inbox-row-words:not(.inbox-row-command), .dt-mail-snippet'); return e ? e.textContent.trim() : null; })()`); check(head === 'Wants to run a bash command', `${at}the permission row says the same words at every width (#20066): ` + JSON.stringify(head)); }
            if (!mobile) {
            check(rows.button && rows.button.words.slice(0, 3).join() === 'Blue,Green,Red', `${at}a button ask shows its buttons in the row: ` + JSON.stringify(rows.button));
            for (const k of ['button', 'yesno', 'plain', 'permission', 'question']) check(rows[k] && rows[k].lastIsMore, `${at}${k}: More is the last button of the row: ` + JSON.stringify(rows.permission));
            check(rows.permission && rows.permission.pill !== '', `${at}permission: the kind is a chip in the name line, as mock v3 draws it: ` + JSON.stringify(rows.permission));
            for (const k of ['button', 'plain', 'question', 'yesno']) check(rows[k] && rows[k].pill === '', `${at}${k}: a question's kind (and a Yes / No ask's) is plain text under its words, not a chip (mock v3, #20066, #20101): ` + JSON.stringify(rows.permission));
            check(rows.plain && rows.plain.h <= (w >= 1000 ? 120 : 130), `${at}a one-line ask is three short lines (name, words, kind) with its buttons beside the text, no gap of 60 px: row ${rows.plain && rows.plain.h} px`);
            if (rows.welcome && !mobile) check(rows.welcome.lastIsMore, `${at}the first welcome row has More last, as the others do (#20066): ` + JSON.stringify(rows.welcome));
            if (rows.welcome) { const bgs = await ev(`[...document.querySelectorAll('#group-table-view tbody tr.inbox-card-tr')].filter(tr => tr.querySelector('.inbox-welcome-name')).map(tr => getComputedStyle(tr).backgroundColor + '|' + getComputedStyle(tr).boxShadow)`); check(new Set(bgs).size === 1, `${at}the first welcome row is styled like the rest: ` + JSON.stringify(bgs)); }
            }
            await ev(`(document.querySelector('#group-table-view tr .inbox-cmd-block') || document.body).closest('tr')?.scrollIntoView({ block: 'center' }); true`); // the permission row is in the shot
            for (const th of ['light', 'dark']) { await ev(`document.documentElement.setAttribute('data-theme', '${th}'); true`); await new Promise(r => setTimeout(r, 600)); await shot(`anatomy-${w}-${th}`); } await ev(`document.documentElement.removeAttribute('data-theme'); true`); // sleep-ok: the theme transition ends
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS every kind of Needs you row has one anatomy: kind pill, More last, a button ask shows its buttons, no gap on a one-line ask, welcome rows alike, at 1280 and 390');
})().catch(e => { console.error(e); process.exit(1); });
