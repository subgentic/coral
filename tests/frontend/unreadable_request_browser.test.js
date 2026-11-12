// #15501 (the Operator, on #15492): a permission request Coral cannot read whole (its top was on no read, or it is too long or hides characters) used to show a card with only "No". Now the card says
// Coral could not read this request in full and that it is answered in the agent's terminal: no No button, no list of answers, no half of the request, Open agent as the main button, on the Inbox row and
// in the Inbox card dialog, at 1280 and 390 px. Coral still never sends a Yes for it. The screen shape is the Operator's phone screenshot (a dashed rule and the warning line, "Do you want to proceed?",
// Yes / Yes and don't ask again / No). The agent's chat and answer-prompt routes are page stubs.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], T = '#group-table-view', S = `(window.__coralStatic || '/static/')`;
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const AGENT = { name: 'be', session_id: '00000001-0000-4000-8000-000000000001', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'DevOps Engineer', working_directory: '/repo/be', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Do you want to proceed?', waiting_since: new Date(Date.now() - 120000).toISOString() };
    const RULE = '─'.repeat(60);
    const CARD = {
        title: '', question: 'Do you want to proceed?', ask_id: 'ask1', only_reject: true, unreadable: true,
        target: `${RULE}\n│ Dangerous rm operation on statically-unresolvable target: command\n│ substitution output`,
        note: 'The top of this request is not on the screen, so Coral could not read it in full. Coral cannot answer it here: answer it in the agent\'s terminal.',
        options: [{ n: 1, label: 'Yes', action: 'select' }, { n: 2, label: "Yes, and don't ask again for rm commands", action: 'select' }, { n: 3, label: 'No', action: 'select' }],
    };
    const dialog = () => ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog[open]'); if (!d) return null; const open = [...d.querySelectorAll('.inbox-ask-buttons button')].find(b => b.textContent === 'Open agent'); return { text: d.textContent.replace(/\\s+/g, ' '), answers: [...d.querySelectorAll('.inbox-ask-offers-list button')].map(b => b.textContent), buttons: [...d.querySelectorAll('button')].map(b => b.textContent), openPrimary: !!open && open.classList.contains('btn-primary'), hasTarget: !!d.querySelector('.inbox-ask-text[aria-label="What it wants to run"]'), fits: d.scrollWidth <= d.clientWidth + 1 }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(INBOX_WORLD);
            await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
                window.__posts = []; window.__opened = [];
                window.selectLiveSession = (...a) => { window.__opened.push(a); return Promise.resolve(); };
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                    if (u.pathname === '/api/sessions/live/be/chat') return json({ prompt_options: ${JSON.stringify(CARD)} });
                    if (u.pathname === '/api/sessions/live/be/answer-prompt' && opts.method === 'POST') { window.__posts.push(JSON.parse(opts.body)); return json({ ok: true }); }
                    return original(url, opts); };
                return true; })()`);
            await ev(`(async () => { const { state } = await import(${S} + 'state.js'); const m = await import(${S} + 'inbox_tab.js'); state.liveSessions = [${JSON.stringify(AGENT)}]; m.updateInboxTab(); window.switchNavTab('hub-inbox'); await m.selectInboxTab('needs'); return true; })()`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 1`, at + 'the permission row', 15000); await ev(framesJs(6));
            // 1. the row: no answer, the words, Open agent as the main button
            await waitFor(`/could not read this request in full/i.test(document.querySelector('${T} tbody tr').textContent)`, at + 'the row says Coral could not read it', 8000).catch(() => {});
            const row = await ev(`(() => { const r = document.querySelector('${T} tbody tr'); const o = r.querySelector('button.inbox-open-agent'); return { answers: [...r.querySelectorAll('button.inbox-answer')].map(b => b.textContent), text: r.textContent.replace(/\\s+/g, ' '), open: o ? { text: o.textContent, primary: o.classList.contains('btn-primary') } : null }; })()`);
            check(row.answers.length === 0, at + 'the row has no answer button, not even No: ' + JSON.stringify(row.answers));
            check(/could not read this request in full/i.test(row.text) && /answer it in the agent.s terminal/i.test(row.text), at + 'the row says it and where to answer: ' + row.text);
            check(!!row.open && row.open.text === 'Open agent' && row.open.primary, at + 'Open agent is the main button on the row: ' + JSON.stringify(row.open));
            check(!/can only be rejected/i.test(row.text), at + 'the old wording is gone from the row');
            const seen = await ev(`(() => { const r = document.querySelector('${T} tbody tr'), n = r.querySelector('.inbox-unread'), o = r.querySelector('button.inbox-open-agent'), vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; return { note: vis(n), open: vis(o), touch: !${mobile} || (!!o && o.getBoundingClientRect().height >= 40) }; })()`);
            check(seen.note && seen.open && seen.touch, at + 'the words and Open agent are on screen on the row (a phone too), as a touch target: ' + JSON.stringify(seen));
            await shot(`unreadable-row-${w}`);
            // 2. the dialog (the phone's card): the same, and not half of the request
            await ev(`document.querySelector('${T} tbody tr .dt-primary').click(); true`);
            await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open] .inbox-card-body > *')`, at + 'the card dialog', 8000);
            const d = await dialog();
            check(!!d && d.answers.length === 0, at + 'the dialog has no list of answers: ' + JSON.stringify(d && d.answers));
            check(!!d && !d.buttons.includes('No') && !d.buttons.includes('Yes'), at + 'no No and no Yes button anywhere in the dialog: ' + JSON.stringify(d && d.buttons));
            check(!!d && /could not read this request in full/i.test(d.text) && /answer it in the agent.s terminal/i.test(d.text), at + 'the dialog says it and where to answer: ' + (d && d.text));
            check(!!d && !/can only be rejected|not on the screen/i.test(d.text), at + 'the old wording is gone from the dialog');
            check(!!d && !d.hasTarget && !/Dangerous rm operation|───/.test(d.text), at + 'the cut half of the request is not drawn as if it were the request');
            check(!!d && d.openPrimary, at + 'Open agent is the main button of the dialog');
            check(!!d && d.fits, at + 'nothing sideways in the dialog');
            await shot(`unreadable-dialog-${w}`);
            // 3. nothing was sent, and Open agent goes to the agent
            check((await ev(`window.__posts.length`)) === 0, at + 'nothing was sent to the agent');
            await ev(`[...document.querySelectorAll('dialog.inbox-ask-dialog[open] .inbox-ask-buttons button')].find(b => b.textContent === 'Open agent').click(); true`);
            await waitFor(`window.__opened.length === 1`, at + 'Open agent opens the agent', 5000).catch(() => {});
            check((await ev(`window.__opened.length`)) === 1 && (await ev(`window.__posts.length`)) === 0, at + 'Open agent opened the agent and sent nothing');
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('unreadable_request_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
