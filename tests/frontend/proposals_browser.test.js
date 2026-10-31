// What agents asked to add to a team waits for the Operator in Needs you (#11389, slice B): a row for each proposal with its title, who proposed it and its words, all as text; Approve, Edit and approve (a dialog with
// the words, only what changed is sent) and Reject (a reason the agent is told); an expired one says so and can be dismissed; one being approved has no buttons; a refusal from the machine is said in the detail; the Inbox
// badge counts the pending ones. And Team settings holds the three planning limits and saves them to the machine. The proposals routes are stood in for by a page-side stub that records every request; the settings
// are the real server's. 1280 px dark and 390 px light (touch). Drives Chrome over CDP through the harness; run_cdp_suites.mjs finds it by name.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const { removeBoards } = require('./helpers/board_cleanup');
const { setTheme, installAudit, auditRegion } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const HEX = '71c21f0b' + 'a'.repeat(56);
const LONGBODY = ('A long body. ' + 'It goes on and on with detail that nobody reads until they must decide. '.repeat(50)).slice(0, 2986) + 'THE END OF IT.'; // 3,000 characters, on one line
const PROPOSALS = [
    { id: 11, board_id: 'team-a', kind: 'task', title: 'Fix the <b>login</b> page', proposer: 'Backend Dev', state: 'pending', created_at: new Date(Date.now() - 600000).toISOString(), payload: { title: 'Fix the <b>login</b> page', body: 'It fails on Safari. @Orchestrator please look <img src=x onerror="window.__pwned=1">', priority: 'high', assigned_to: 'QA Engineer', blocked_by: [3], draft: true, goal_id: 5, remind_at: new Date(Date.now() + 86400000).toISOString(), workflow: { instructions: 'Read the plan first.\n<b>then</b> run the deploy\u202E script.\nSee coral://artifacts/' + HEX + ').', required_outputs: ['a report', 'the diff\u200B'] } } },
    { id: 12, board_id: 'team-a', kind: 'goal', title: 'Ship the beta', proposer: 'Orchestrator', state: 'pending', created_at: new Date(Date.now() - 3600000).toISOString(), payload: { title: 'Ship the beta', outcome: LONGBODY, done_when: 'The release is out' } },
    { id: 13, board_id: 'team-b', kind: 'task', title: 'An old idea', proposer: 'QA Engineer', state: 'expired', created_at: new Date(Date.now() - 9 * 86400000).toISOString(), payload: { title: 'An old idea', body: 'Nobody decided.' } },
    { id: 14, board_id: 'team-b', kind: 'goal', title: 'Being made right now', proposer: 'Lead Developer', state: 'approving', created_at: new Date(Date.now() - 120000).toISOString(), payload: { title: 'Being made right now', outcome: 'x' } },
];

const STUB = `(() => {
    const R = window.fetch; window.__posts = []; window.__list = ${JSON.stringify(PROPOSALS)}; window.__refuse = null; window.__pwned = 0;
    const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), m = (o.method || 'GET').toUpperCase();
        if (url.pathname === '/api/proposals' && m === 'GET') return json({ proposals: window.__list.filter(p => ['pending', 'approving', 'expired'].includes(p.state)) });
        const d = url.pathname.match(/^\\/api\\/board\\/([^/]+)\\/proposals\\/(\\d+)\\/(approve|reject)$/);
        if (d && m === 'POST') { const id = Number(d[2]); window.__posts.push({ board: d[1], id, action: d[3], body: JSON.parse(o.body || '{}') });
            if (window.__refuse) return json({ error: window.__refuse, code: 'waits_for_goal' }, 409);
            const p = window.__list.find(x => x.id === id); if (p) p.state = d[3] === 'approve' ? 'approved' : 'rejected';
            return json(d[3] === 'approve' ? { proposal_id: id, state: 'approved', created_id: 77 } : { proposal_id: id, state: 'rejected' }); }
        return R(u, o); };
    return true;
})()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await require('./helpers/wait').settle(ev, 400, 300); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const TEAM = 'plan-' + Date.now().toString(36);
    const T = '#group-table-view';
    const rowsOf = () => ev(`[...document.querySelectorAll('${T} tbody tr')].map(tr => ({ text: tr.textContent.replace(/\\s+/g, ' ').trim(), buttons: [...tr.querySelectorAll('button')].map(b => b.textContent.trim()), item: (tr.querySelector('.inbox-review-name') || {}).textContent || '', what: (tr.querySelector('.inbox-proposal-what') || {}).textContent || '' }))`);
    const openNeeds = async view => {
        await Emulation.setDeviceMetricsOverride({ width: view.w, height: view.h, deviceScaleFactor: 1, mobile: view.phone });
        await Emulation.setTouchEmulationEnabled({ enabled: view.phone });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await installAudit(ev); await setTheme(ev, view.theme);
        await ev(INBOX_WORLD); await ev(STUB);
        await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); const m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js'); state.liveSessions = []; m.updateInboxTab(); return true; })()`);
        await ev(`localStorage.removeItem('coral.inbox.tab'); localStorage.removeItem('coral.proposals.dismissed.v1'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 4`, 'the four proposal rows', 15000);
    };

    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const view of [{ w: 1280, h: 900, phone: false, theme: 'dark' }, { w: 390, h: 844, phone: true, theme: 'light' }]) {
            const at = `${view.w}px ${view.theme}: `;
            await openNeeds(view);
            let rows = await rowsOf();
            const byItem = Object.fromEntries(rows.map(r => [r.item, r]));
            check(at + 'a row for each proposal, its title as text (a tag in it stays text)', rows.length === 4 && byItem['Fix the <b>login</b> page'] && byItem['Ship the beta'] && byItem['An old idea'] && byItem['Being made right now'], JSON.stringify(rows.map(r => r.item)));
            check(at + 'the proposer is named and the body is shown, as text: a tag, a mention and an image with a handler do nothing', /Backend Dev proposes a task/.test(byItem['Fix the <b>login</b> page'].what) && byItem['Fix the <b>login</b> page'].what.includes('<img src=x onerror="window.__pwned=1">') && byItem['Fix the <b>login</b> page'].what.includes('@Orchestrator') && await ev(`window.__pwned === 0 && !document.querySelector('${T} b, ${T} img')`), byItem['Fix the <b>login</b> page'].what);
            const geoRows = await ev(`(() => Object.fromEntries([...document.querySelectorAll('${T} tbody tr')].map(tr => { const w = tr.querySelector('.inbox-proposal-what'), b = tr.querySelector('.inbox-proposal-body'); return [(tr.querySelector('.inbox-review-name') || {}).textContent, { h: Math.round(tr.getBoundingClientRect().height), nowrap: w ? getComputedStyle(w).whiteSpace === 'nowrap' : null, cut: b ? b.scrollWidth > b.clientWidth && getComputedStyle(b).textOverflow === 'ellipsis' : null, lines: b ? Math.round(b.getBoundingClientRect().height / parseFloat(getComputedStyle(b).lineHeight)) : null }]; })))()`);
            const longRow = geoRows['Ship the beta'], shortRow = geoRows['Fix the <b>login</b> page'];
            check(at + 'a 3,000-character body is ONE line cut with an ellipsis: the row is no taller than a short one, and the end is not in the row', LONGBODY.length === 3000 && longRow.h <= shortRow.h && longRow.nowrap && longRow.cut && longRow.lines === 1 && /Orchestrator proposes a goal/.test(byItem['Ship the beta'].what) && !byItem['Ship the beta'].what.includes('THE END OF IT.'), JSON.stringify(geoRows));
            check(at + 'a pending one has Approve, Edit and Reject; an expired one says so and has Dismiss; one being approved has no buttons', JSON.stringify(byItem['Fix the <b>login</b> page'].buttons) === JSON.stringify(['Approve', 'Edit', 'Reject']) && /Expired, nothing was made/.test(byItem['An old idea'].text) && JSON.stringify(byItem['An old idea'].buttons) === JSON.stringify(['Dismiss']) && /Being approved/.test(byItem['Being made right now'].text) && byItem['Being made right now'].buttons.length === 0, JSON.stringify(rows.map(r => r.buttons)));
            const seen = await ev(`(() => { const w = [...document.querySelectorAll('${T} .inbox-proposal-what')].filter(n => n.getClientRects().length); return { n: w.length, widths: w.map(n => Math.round(n.getBoundingClientRect().width)), narrow: w.filter(n => n.getBoundingClientRect().width < ${view.phone ? 120 : 200}).length }; })()`);
            check(at + 'the proposer and the words are SEEN in the row (not in a hidden column)', seen.n >= 3 && seen.narrow === 0, JSON.stringify(seen));
            const fit = await ev(`(() => { const b = document.querySelector('${T} .dt-box'); return { fits: b.scrollWidth <= b.clientWidth + 1, waiting: [...b.querySelectorAll('thead th')].map(t => t.textContent.trim()).filter(Boolean) }; })()`);
            check(at + 'the table fits its box: every column is whole, Waiting included', fit.fits && fit.waiting.some(w => /^Waiting/.test(w)), JSON.stringify(fit));
            const badge = await ev(`(document.getElementById('nav-tab-hub-inbox-badge') || {}).textContent`);
            check(at + 'the Inbox badge counts the two pending proposals', badge === '2', String(badge));
            if (view.phone) {
                const geo = await ev(`({ page: document.documentElement.scrollWidth <= document.documentElement.clientWidth, small: [...document.querySelectorAll('${T} tbody tr button')].filter(b => b.getClientRects().length).map(b => Math.round(b.getBoundingClientRect().height)).filter(h => h < 44) })`);
                check(at + 'no sideways page scroll, and the buttons are 44 px targets', geo.page && geo.small.length === 0, JSON.stringify(geo));
            }
            await shot(`proposals-needs-${view.w}-${view.theme}`);
            // opening the row shows the whole body as text, read first; Edit and approve in it opens the words to change
            const rowOf = name => `[...document.querySelectorAll('${T} tbody tr')].find(tr => tr.querySelector('.inbox-review-name').textContent === ${JSON.stringify(name)})`;
            await ev(`window.__posts = []; ${rowOf('Ship the beta')}.querySelector('.inbox-review-name').click(); true`);
            await waitFor(`!!document.querySelector('#proposal-dialog[open]')`, at + 'the detail from the row', 5000);
            const detail = await ev(`(() => { const d = document.querySelector('#proposal-dialog'); const f = [...d.querySelectorAll('input, textarea')]; const before = f.slice(0, 3).every(x => x.readOnly); return { posts: window.__posts.length, whole: f[1].value.endsWith('THE END OF IT.') && f[1].value.length === 3000, readonly: before, buttons: [...d.querySelectorAll('.proposal-buttons button')].filter(b => !b.hidden).map(b => b.textContent) }; })()`);
            check(at + 'opening the row shows the whole 3,000-character body as text, read first, with Close, Reject, Edit and approve, Approve; nothing is sent', detail.posts === 0 && detail.whole && detail.readonly && JSON.stringify(detail.buttons) === JSON.stringify(['Close', 'Reject…', 'Edit and approve', 'Approve']), JSON.stringify(detail));
            await ev(`[...document.querySelectorAll('#proposal-dialog button')].find(b => b.textContent === 'Edit and approve').click(); true`);
            check(at + 'Edit and approve in the detail opens the words to change', await ev(`(() => { const f = [...document.querySelectorAll('#proposal-dialog input, #proposal-dialog textarea')].slice(0, 3); return f.every(x => !x.readOnly) && document.activeElement === f[0] && [...document.querySelectorAll('#proposal-dialog .proposal-buttons button')].some(b => b.textContent === 'Approve with these words'); })()`));
            await ev(`document.querySelector('#proposal-dialog').close(); true`);
            // a refusal from the machine is a toast; the row stays one line and stays in the list
            await ev(`window.__posts = []; window.__refuse = 'this task waits for the goal it was proposed under: approve that goal first'; ${rowOf('Ship the beta')}.querySelector('button').click(); true`);
            await waitFor(`/waits for the goal/.test(document.body.textContent)`, at + 'the refusal in words', 8000);
            check(at + 'a refusal from the machine is said in a toast: the proposal stays, one request was made', await ev(`!!${rowOf('Ship the beta')} && window.__posts.length === 1 && !document.querySelector('${T} .inbox-review-error:not(:empty)')`));
            await ev(`window.__refuse = null; window.__posts = []; true`);
            // the dialog shows what the task would carry: the instructions and outputs in full, and one line of the rest
            check(at + 'a row whose task carries instructions says so', /Carries instructions/.test(byItem['Fix the <b>login</b> page'].what) && !/Carries instructions/.test(byItem['Ship the beta'].what), byItem['Fix the <b>login</b> page'].what);
            await ev(`window.__posts = []; [...document.querySelectorAll('${T} tbody tr')].find(tr => tr.querySelector('.inbox-review-name').textContent === 'Fix the <b>login</b> page').querySelector('.inbox-review-name').click(); true`);
            await waitFor(`!!document.querySelector('#proposal-dialog[open]')`, at + 'the dialog for the task', 5000);
            const carried = await ev(`(() => { const d = document.querySelector('#proposal-dialog'); return { pre: (d.querySelector('.proposal-pre') || {}).textContent, outputs: [...d.querySelectorAll('.proposal-outputs li')].map(li => li.textContent), fields: [...d.querySelectorAll('input, textarea')].slice(0, 2).map(f => f.value), also: (d.querySelector('.proposal-extra') || {}).textContent, tags: !!d.querySelector('b, img'), links: d.querySelectorAll('.proposal-pre a.mb-artifact-ref').length }; })()`);
            check(at + 'the dialog shows the instructions in full as text, the required outputs, and what else it sets', carried.pre === 'Read the plan first.\n<b>then</b> run the deploy<U+202E> script.\nSee artifact 71c21f0b).' && carried.links === 1 && JSON.stringify(carried.outputs) === JSON.stringify(['a report', 'the diff<U+200B>']) && /^Also sets: assigned to QA Engineer; priority high; blocked by #3; a reminder at .+; a draft \(not published\); under goal #5\.$/.test(carried.also) && !carried.tags, JSON.stringify(carried));
            check(at + 'the detail shows the instructions with the override written out and the line break kept, and the fields hold the same marked words until Edit', !/[\u202E\u200B]/.test(carried.pre + carried.outputs.join('')) && carried.pre.includes('\n') && carried.fields.every(f => !/[\u202E\u200B\u200D]/.test(f)));
            await ev(`document.querySelector('#proposal-dialog').close(); true`);
            // Approve from the row makes it as proposed: one request, no edits (the Operator's ruling), and the row goes
            await ev(`${rowOf('Fix the <b>login</b> page')}.querySelector('button').click(); true`);
            await waitFor(`!/Fix the <b>login<\\/b> page/.test(document.querySelector('${T}').textContent)`, at + 'the approved row gone', 8000);
            const posts = await ev(`window.__posts`);
            check(at + 'Approve on the row is one request for that proposal with no edits, and the row is gone', posts.length === 1 && posts[0].action === 'approve' && posts[0].id === 11 && posts[0].board === 'team-a' && Object.keys(posts[0].body).length === 0, JSON.stringify(posts));
            // Edit and approve: the words in a dialog, only the changed one is sent
            await ev(`window.__posts = []; ${rowOf('Ship the beta')}.querySelectorAll('button')[1].click(); true`);
            await waitFor(`!!document.querySelector('#proposal-dialog[open]')`, at + 'the dialog', 5000);
            const dlg = await ev(`(() => { const d = document.querySelector('#proposal-dialog'); const f = [...d.querySelectorAll('input, textarea')]; return { title: f[0].value, outcome: f[1].value.endsWith('THE END OF IT.'), done: f[2].value, who: d.querySelector('.proposal-who').textContent, focus: document.activeElement === f[0] }; })()`);
            check(at + 'the row Edit opens the dialog: all the words (the whole body) and the proposer, the title focused', dlg.title === 'Ship the beta' && dlg.outcome && dlg.done === 'The release is out' && /Orchestrator proposed it for team-a/.test(dlg.who) && dlg.focus, JSON.stringify(dlg));
            const cleanBefore = await ev(`document.querySelector('#proposal-dialog .proposal-hidden').hidden`);
            await shot(`proposals-dialog-${view.w}-${view.theme}`);
            await ev(`(() => { const t = document.querySelector('#proposal-dialog input'); t.value = 'Ship the beta, edited'; t.dispatchEvent(new Event('input', { bubbles: true })); [...document.querySelectorAll('#proposal-dialog button')].find(b => /Approve/.test(b.textContent)).click(); return true; })()`);
            await waitFor(`!document.querySelector('#proposal-dialog[open]')`, at + 'the dialog closed', 8000);
            const edited = await ev(`window.__posts`);
            check(at + 'Approve with these words sends only what changed', edited.length === 1 && edited[0].id === 12 && JSON.stringify(edited[0].body) === JSON.stringify({ title: 'Ship the beta, edited' }), JSON.stringify(edited));
            // Reject: a dialog with a reason; the agent is told through the machine
            await ev(`window.__posts = []; window.__list.push({ id: 15, board_id: 'team-a', kind: 'task', title: 'Rewrite everything', proposer: 'Dev', state: 'pending', created_at: new Date().toISOString(), payload: { title: 'Rewrite everything', body: 'All of it.' } }); import((window.__coralStatic || '/static/') + 'proposals_state.js').then(m => m.refreshProposals(true)); true`);
            await waitFor(`/Rewrite everything/.test(document.querySelector('${T}').textContent)`, at + 'the new row', 8000);
            await ev(`[...document.querySelectorAll('${T} tbody tr')].find(tr => tr.querySelector('.inbox-review-name').textContent === 'Rewrite everything').querySelectorAll('button')[2].click(); true`);
            await waitFor(`!!document.querySelector('#proposal-dialog[open]')`, at + 'the reject dialog', 5000);
            check(at + 'Reject opens the dialog on the reason', await ev(`(() => { const d = document.querySelector('#proposal-dialog'); const r = [...d.querySelectorAll('label')].find(l => /Reason/.test(l.textContent)); return !!r && !r.hidden && document.activeElement === r.querySelector('textarea'); })()`));
            await ev(`(() => { const r = [...document.querySelectorAll('#proposal-dialog label')].find(l => /Reason/.test(l.textContent)).querySelector('textarea'); r.value = 'Not now: the release comes first.'; [...document.querySelectorAll('#proposal-dialog button')].find(b => b.textContent === 'Reject').click(); return true; })()`);
            await waitFor(`!document.querySelector('#proposal-dialog[open]')`, at + 'the dialog closed after Reject', 8000);
            const rej = await ev(`window.__posts`);
            check(at + 'Reject sends the reason, once', rej.length === 1 && rej[0].action === 'reject' && rej[0].id === 15 && rej[0].body.reason === 'Not now: the release comes first.', JSON.stringify(rej));
            // the title, the proposer and the words are written out where they hide or reorder text (strict: a joiner too), and cut after marking
            await ev(`window.__list.push({ id: 16, board_id: 'team-a', kind: 'task', title: 'Pay\\u202Egnp.exe', proposer: 'Dev\\u202Eevil', state: 'pending', created_at: new Date().toISOString(), payload: { title: 'x', body: 'run git\\u200Dstatus\\u202E now ' + 'y'.repeat(300) } }); import((window.__coralStatic || '/static/') + 'proposals_state.js').then(m => m.refreshProposals(true)); true`);
            await waitFor(`/<U\\+202E>/.test(document.querySelector('${T}').textContent)`, at + 'the marked row', 8000);
            const marked = await ev(`(() => { const tr = [...document.querySelectorAll('${T} tbody tr')].find(r => /gnp\\.exe/.test(r.textContent)); const body = tr.querySelector('.inbox-proposal-body').textContent; return { text: tr.textContent, body, hidden: /[\\u202E\\u200D]/.test(tr.textContent), aria: [...tr.querySelectorAll('button')].map(b => b.getAttribute('aria-label')).join('|'), cutMark: /<U\\+?[0-9A-F]*$/.test(body.replace(/…$/, '')) }; })()`);
            check(at + 'a title, proposer and body with a right-to-left override or a joiner are written out as <U+202E> and <U+200D>, in the row and its button names, never drawn', !marked.hidden && /Pay<U\+202E>gnp\.exe/.test(marked.text) && /Dev<U\+202E>evil proposes a task/.test(marked.text) && /git<U\+200D>status<U\+202E> now/.test(marked.body) && /Pay<U\+202E>gnp\.exe/.test(marked.aria) && !marked.cutMark && marked.body.endsWith('…'), JSON.stringify(marked).slice(0, 400));
            // Edit says how many hidden characters the words hold: none until it is pressed, none at all for words without any
            await ev(`${rowOf('Pay<U+202E>gnp.exe')}.querySelector('.inbox-review-name').click(); true`);
            await waitFor(`!!document.querySelector('#proposal-dialog[open]')`, at + 'the detail for the hidden count', 5000);
            const beforeEdit = await ev(`(document.querySelector('#proposal-dialog .proposal-hidden') || { hidden: true }).hidden`);
            await ev(`[...document.querySelectorAll('#proposal-dialog button')].find(b => b.textContent === 'Edit and approve').click(); true`);
            const hint = await ev(`(() => { const n = document.querySelector('#proposal-dialog .proposal-hidden'); return { shown: !n.hidden, text: n.textContent }; })()`);
            await ev(`document.querySelector('#proposal-dialog').close(); true`);
            check(at + "Edit says 'These words hold 3 hidden characters' when there are some (title 1, body 2), not before it is pressed and not for clean words (the row Edit of the beta goal has none)", beforeEdit === true && hint.shown && hint.text === 'These words hold 3 hidden characters.' && cleanBefore === true, JSON.stringify({ beforeEdit, hint, cleanBefore }));
            // the detail in view mode shows marked words in its fields, and Approve there sends no edit (the marked words are not the proposal's)
            await ev(`window.__posts = []; ${rowOf('Pay<U+202E>gnp.exe')}.querySelector('.inbox-review-name').click(); true`);
            await waitFor(`!!document.querySelector('#proposal-dialog[open]')`, at + 'the detail of the marked proposal', 5000);
            const viewVals = await ev(`[...document.querySelectorAll('#proposal-dialog input, #proposal-dialog textarea')].slice(0, 2).map(f => f.value)`);
            await ev(`[...document.querySelectorAll('#proposal-dialog button')].find(b => b.textContent === 'Approve').click(); true`);
            await waitFor(`!document.querySelector('#proposal-dialog[open]')`, at + 'the dialog closed after Approve', 8000);
            const viewPosts = await ev(`window.__posts`);
            check(at + 'the detail shows the marked title and body; Approve in it sends no edit', viewVals[0] === 'Pay<U+202E>gnp.exe' && /git<U\+200D>status<U\+202E> now/.test(viewVals[1]) && viewPosts.length === 1 && viewPosts[0].id === 16 && Object.keys(viewPosts[0].body).length === 0, JSON.stringify([viewVals.map(v => v.slice(0, 40)), viewPosts]));
            // an expired one is dismissed in this browser
            await ev(`[...document.querySelectorAll('${T} tbody tr')].find(tr => tr.querySelector('.inbox-review-name').textContent === 'An old idea').querySelector('button').click(); true`);
            await waitFor(`!/An old idea/.test(document.querySelector('${T}').textContent)`, at + 'the expired row gone', 5000);
            check(at + 'Dismiss takes an expired proposal off the list', true);
            check(at + 'text holds 4.5:1 in the table', (await auditRegion(ev, [T])).fails.length === 0);
        }
        // Team settings: the three planning limits are fields, and they save to the machine (the real server)
        const wide = { w: 1280, h: 900, phone: false, theme: 'dark' };
        await Emulation.setDeviceMetricsOverride({ width: wide.w, height: wide.h, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        const sub = await ev(`fetch('/api/board/${TEAM}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'claude-pl-1' }) }).then(r => r.status)`);
        assert.ok(sub < 300);
        await ev(`import((window.__coralStatic || '/static/') + 'team_working_mode.js').then(m => m.showTeamWorkingMode(${JSON.stringify(TEAM)}, { page: (document.getElementById('qa-ts-host') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'qa-ts-host' }))), tab: 'workflow' })).then(() => true)`);
        await waitFor(`!!document.querySelector('#team-settings-workspace .sv[data-ready]')`, 'the Team settings', 15000);
        const f = await ev(`(() => { const q = n => document.querySelector('#team-settings-workspace [name=' + n + ']'); return { max: !!q('max_open_goals'), goals: !!q('goals_need_approval'), tasks: !!q('tasks_need_approval'), maxValue: q('max_open_goals') && q('max_open_goals').value }; })()`);
        check('Team settings has the open-goals limit and the two approval switches, all off to begin with', f.max && f.goals && f.tasks && (f.maxValue === '0' || f.maxValue === ''), JSON.stringify(f));
        await ev(`(() => { const set = (n, v) => { const e = document.querySelector('#team-settings-workspace [name=' + n + ']'); if (e.type === 'checkbox') e.click(); else { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } }; set('max_open_goals', '3'); set('goals_need_approval'); set('tasks_need_approval'); return true; })()`);
        await ev(`[...document.querySelectorAll('#team-settings-workspace button')].find(b => /^Save settings/.test(b.textContent.trim())).click(); true`);
        await waitFor(`fetch('/api/board/${TEAM}/settings').then(r => r.json()).then(s => s.max_open_goals === 3 && s.goals_need_approval === true && s.tasks_need_approval === true)`, 'the limits saved', 15000);
        check('the limits are saved to the machine: 3 open goals, both approvals on', true);
        await removeBoards(ev, [TEAM]).catch(() => {});
    } catch (e) { console.log('ERROR ' + (e.stack || e)); results.push(false); }
    await client.close();
    if (results.every(Boolean)) console.log('proposals_browser: all ok'); else { console.log('FAILED'); process.exit(1); }
})();
