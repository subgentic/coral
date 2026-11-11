// #15078 (the Beta walk): a question about a task in review has Approve and Request changes (the board's own state, never the words), a plain Send reply says "Reply sent", an older question of an agent that asked
// again says "Older" in its dialog with Dismiss first, and the Needs you All pill no longer says "0 of 6" for the welcome cards. 1280 and 390 px; the asks and the reply route are stubbed in the page (as in ask_dialog_dismiss_browser).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const S = `(window.__coralStatic || '/static/')`;
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`(() => { const ago = m => new Date(Date.now() - m * 60000).toISOString();
                window.__asks = [
                    { board: 'team', board_label: 'Sprout', kind: 'ask', id: 50, asker: 'Lead', text: '@Operator which designs do you want?', at: ago(30), superseded: true },
                    { board: 'team', board_label: 'Sprout', kind: 'ask', id: 51, asker: 'Lead', text: '@Operator ignore my earlier questions: here is the plan, approve?', at: ago(20), goal_id: 0, task_id: 9, task_title: 'Build the app', task_in_review: true },
                    { board: 'team', board_label: 'Sprout', kind: 'ask', id: 52, asker: 'Dev', text: '@Operator may I delete the old table?', at: ago(10) } ];
                window.__posts = []; const orig = window.fetch.bind(window);
                window.fetch = (u, o) => { const url = String(u); const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                    if (url === '/api/operator-asks') return json(window.__asks);
                    const m = /^\\/api\\/board\\/([^/]+)\\/messages$/.exec(url);
                    if (m && o && o.method === 'POST') { const body = JSON.parse(o.body); window.__posts.push(body); window.__asks = window.__asks.filter(x => x.id !== body.reply_to); return json({ ok: true, id: 900 + window.__posts.length }); }
                    return orig(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 3`, at + 'the three questions', 10000);
            const open = who => ev(`document.querySelector('button[aria-label="Answer the question of ${who}"]').click(); true`);
            const btns = () => ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog[open]'); return d ? { sendrow: [...d.querySelectorAll('.inbox-ask-sendrow button')].map(b => b.textContent.trim()), footer: [...d.querySelectorAll('.inbox-ask-buttons button')].map(b => b.textContent.trim()), note: [...d.querySelectorAll('.inbox-ask-sub')].map(p => p.textContent).join(' | ') } : null; })()`);
            const closeDlg = async () => { await ev(`document.querySelector('dialog.inbox-ask-dialog[open]').dispatchEvent(new Event('cancel', { cancelable: true })); true`); await waitFor(`!document.querySelector('dialog.inbox-ask-dialog')`, at + 'the dialog closes', 4000); };

            // a plain question: reply box only, Send reply says it was sent
            const rows = await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(r => r.textContent.replace(/\\s+/g, ' ')).join(' || ')`);
            await open('Dev'); await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'the plain question opens', 4000);
            const plain = await btns();
            check(at + 'a plain question has no Approve or Request changes', !!plain && !plain.sendrow.includes('Approve') && !plain.sendrow.includes('Request changes'), JSON.stringify(plain));
            await ev(`(() => { const b = document.querySelector('dialog.inbox-ask-dialog[open] .inbox-ask-box'); b.value = 'yes, delete it'; b.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('dialog.inbox-ask-dialog[open] .inbox-ask-send').click(); return true; })()`);
            await waitFor(`!document.querySelector('dialog.inbox-ask-dialog')`, at + 'the dialog closes after Send reply', 4000);
            await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Reply sent to Dev/.test(t.textContent))`, at + 'a toast says the reply was sent');

            // the question about a task in review: Approve and Request changes
            const lead = []; // two Lead questions: the older one (asked again since) and the newer one about the task in review
            for (const i of [0, 1]) {
                await ev(`[...document.querySelectorAll('button[aria-label="Answer the question of Lead"]')][${i}].click(); true`);
                await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'a Lead question opens', 4000);
                lead.push(await btns()); await closeDlg();
            }
            const olderAt = lead.findIndex(x => x && /Older: Lead asked again/.test(x.note)), older = lead[olderAt];
            check(at + 'exactly one Lead question says it is older', olderAt >= 0 && lead.filter(x => /Older:/.test(x.note)).length === 1, JSON.stringify(lead));
            if (older) {
                check(at + 'the older question: Dismiss comes first in the footer', older.footer[0] === 'Dismiss', JSON.stringify(older));
                check(at + 'the older question has no Approve', !older.sendrow.includes('Approve'), JSON.stringify(older));
            }
            await ev(`[...document.querySelectorAll('button[aria-label="Answer the question of Lead"]')][${olderAt === 0 ? 1 : 0}].click(); true`);
            await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'the newer Lead question opens', 4000);
            const t = await btns();
            check(at + 'a task in review: Approve and Request changes beside Send reply', !!t && t.sendrow.includes('Approve') && t.sendrow.includes('Request changes'), JSON.stringify(t));
            // Request changes needs words
            await ev(`[...document.querySelectorAll('dialog.inbox-ask-dialog[open] .inbox-ask-review button')].find(b => b.textContent === 'Request changes').click(); true`);
            check(at + 'Request changes with nothing written asks for words and sends nothing', /Write what to change/.test(await ev(`document.querySelector('dialog.inbox-ask-dialog[open] .inbox-ask-error').textContent`)) && (await ev(`window.__posts.length`)) === 1);
            await ev(`(() => { const b = document.querySelector('dialog.inbox-ask-dialog[open] .inbox-ask-box'); b.value = 'add tests'; b.dispatchEvent(new Event('input', { bubbles: true })); [...document.querySelectorAll('dialog.inbox-ask-dialog[open] .inbox-ask-review button')].find(x => x.textContent === 'Request changes').click(); return true; })()`);
            await waitFor(`window.__posts.length === 2`, at + 'Request changes posts', 4000);
            const p = await ev(`window.__posts[1]`);
            check(at + 'Request changes says so and carries the words', /Changes requested:\s+add tests/.test(p.content) && p.reply_to === 51, JSON.stringify(p));
            await waitFor(`[...document.querySelectorAll('.toast')].some(x => /Sent: Request changes/.test(x.textContent))`, at + 'a toast says it');
            // the task left review after the list was read: Approve is refused, says why, and the buttons go (#15111)
            await closeDlg().catch(() => {});
            await ev(`window.__asks.push({ board: 'team', board_label: 'Sprout', kind: 'ask', id: 53, asker: 'Qa', text: '@Operator the build is ready: approve?', at: new Date().toISOString(), task_id: 11, task_title: 'Ship it', task_in_review: true }); import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
            await waitFor(`!!document.querySelector('button[aria-label="Answer the question of Qa"]')`, at + 'the Qa question', 8000);
            await ev(`document.querySelector('button[aria-label="Answer the question of Qa"]').click(); true`);
            await waitFor(`!![...document.querySelectorAll('dialog.inbox-ask-dialog[open] .inbox-ask-review button')].find(b => b.textContent === 'Approve')`, at + 'Approve is offered while the task is in review', 4000);
            await ev(`window.__asks.find(x => x.id === 53).task_in_review = false; true`); // the task moved on after the list was read
            const before = await ev(`window.__posts.length`);
            await ev(`[...document.querySelectorAll('dialog.inbox-ask-dialog[open] .inbox-ask-review button')].find(b => b.textContent === 'Approve').click(); true`);
            await waitFor(`/no longer waiting for review/.test((document.querySelector('dialog.inbox-ask-dialog[open] .inbox-ask-error') || {}).textContent || '')`, at + 'Approve says the task left review', 4000).catch(() => {});
            check(at + 'a task that left review: nothing sent, the reason said, Approve and Request changes gone, Send reply still there', (await ev(`window.__posts.length`)) === before && /no longer waiting for review/.test(await ev(`document.querySelector('dialog.inbox-ask-dialog[open] .inbox-ask-error').textContent`)) && (await ev(`document.querySelectorAll('dialog.inbox-ask-dialog[open] .inbox-ask-review button').length`)) === 0 && (await ev(`!!document.querySelector('dialog.inbox-ask-dialog[open] .inbox-ask-send')`)), JSON.stringify(await btns()));
        }
    } finally { await client.close(); }
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    console.log('ask_review_sent_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
