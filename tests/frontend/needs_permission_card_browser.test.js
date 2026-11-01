// A permission card opens over the Inbox (#11837, moment 3): the first thing every new agent asks is "Do you trust the files in this folder?", and its Needs you row used to send the person to the Agents tab. Open now
// shows the card in a dialog: what it asks, the lines it wants to run, and its own choices as buttons, including the one that lasts ("Yes, I trust this folder": the row never offers that one). A choice is answered through
// the chat card's route with the ask's id; a card that changed between the dialog and the click sends nothing; a request that can only be rejected offers the No form alone; a card with no single choice says so.
// The agent's chat and answer-prompt routes are page stubs. 1280 and 390 px.
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
    const AGENT = { name: 'be', session_id: '00000001-0000-4000-8000-000000000001', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Backend Dev', working_directory: '/repo/be', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Do you trust the files in this folder?', waiting_since: new Date(Date.now() - 120000).toISOString() };
    const TRUST = { title: 'Do you trust the files in this folder?', question: 'Do you trust the files in this folder?\nOnly continue for a folder you made or got from someone you trust.', target: '/home/me/Coral/team-a', unnumbered: true, ask_id: 'ask1', options: [{ n: 1, label: 'Yes, I trust this folder', action: 'select' }, { n: 2, label: 'No, exit', action: 'select' }] };
    const setCard = po => ev(`window.__card = ${JSON.stringify(po)}; window.__reads = 0; window.__posts = []; true`);
    const dialog = () => ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog[open]'); return d ? { title: d.querySelector('#inbox-card-title').textContent, text: d.textContent.replace(/\\s+/g, ' '), buttons: [...d.querySelectorAll('.inbox-ask-offers-list button')].map(b => b.textContent), err: (d.querySelector('.inbox-ask-error') || {}).textContent || '' } : null; })()`);
    const openRow = async () => { await ev(`document.querySelector('${T} tbody tr .dt-primary').click(); true`); await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open] .inbox-card-body > *')`, 'the card dialog', 8000); };
    const closeDialog = () => ev(`[...document.querySelectorAll('dialog.inbox-ask-dialog[open] .inbox-ask-buttons button')].find(b => b.textContent === 'Close')?.click(); true`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(INBOX_WORLD);
            await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
                window.__card = null; window.__reads = 0; window.__posts = [];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                    if (u.pathname === '/api/sessions/live/be/chat') { window.__reads++; const c = typeof window.__card === 'function' ? window.__card(window.__reads) : window.__card; return json({ prompt_options: c }); }
                    if (u.pathname === '/api/sessions/live/be/answer-prompt' && opts.method === 'POST') { window.__posts.push(JSON.parse(opts.body)); return json({ ok: true }); }
                    return original(url, opts); };
                return true; })()`);
            await setCard(TRUST);
            await ev(`(async () => { const { state } = await import(${S} + 'state.js'); const m = await import(${S} + 'inbox_tab.js'); state.liveSessions = [${JSON.stringify(AGENT)}]; m.updateInboxTab(); window.switchNavTab('hub-inbox'); await m.selectInboxTab('needs'); return true; })()`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 1`, at + 'the permission row', 15000); await ev(framesJs(6));
            // the row offers no trust button; Open stays in the Inbox and shows the whole card
            check(!(await ev(`[...document.querySelectorAll('${T} tbody tr .inbox-answer')].some(b => /trust/i.test(b.textContent))`)), at + 'the row itself never offers "trust this folder"');
            await openRow();
            let d = await dialog();
            check(await ev(`document.body.dataset.navTab`) === 'hub-inbox', at + 'Open leaves you in the Inbox');
            check(!!d && d.title === 'Backend Dev: Do you trust the files in this folder?' && /\/home\/me\/Coral\/team-a/.test(d.text) && /Only continue for a folder/.test(d.text) && !/files in this folder\? Do you trust/.test(d.text) && (d.text.match(/Do you trust the files/g) || []).length === 1, at + 'the card says what it asks once, the rest of the question and the folder: ' + JSON.stringify(d));
            check(!!d && d.buttons.join('|') === 'Yes, I trust this folder|No, exit', at + 'both of the card\'s own choices are buttons, the lasting one too: ' + JSON.stringify(d && d.buttons));
            check(await ev(`(() => { const a = document.activeElement; return !!a && !a.closest('.inbox-ask-offers-list') && a.textContent === 'Close'; })()`), at + 'the keyboard is on Close, never on an answer: a key held down while the card draws cannot answer a permission');
            await shot(`needs-permission-card-${w}`);
            // answering: the choice, its number and the ask's id go to the route; the dialog closes and the answer is said
            await ev(`[...document.querySelectorAll('dialog.inbox-ask-dialog[open] .inbox-ask-offers-list button')][0].click(); true`);
            await waitFor(`window.__posts.length === 1`, at + 'the answer was sent', 6000).catch(() => {});
            const posts = await ev(`window.__posts`);
            check(posts.length === 1 && posts[0].n === 1 && posts[0].label === 'Yes, I trust this folder' && posts[0].ask_id === 'ask1', at + 'the answer names the choice and the ask: ' + JSON.stringify(posts));
            check(!(await dialog()), at + 'the dialog closed after the answer');
            // a card that moved on between the dialog and the click: nothing is sent, and it says so
            await setCard(c => c);
            await ev(`window.__card = n => (n >= 2 ? { ...${JSON.stringify(TRUST)}, ask_id: 'ask2' } : ${JSON.stringify(TRUST)}); true`);
            await openRow();
            await ev(`[...document.querySelectorAll('dialog.inbox-ask-dialog[open] .inbox-ask-offers-list button')][0].click(); true`);
            await waitFor(`/changed/.test((document.querySelector('dialog.inbox-ask-dialog[open] .inbox-ask-error') || {}).textContent || '')`, at + 'a changed card is said', 6000).catch(() => {});
            check((await ev(`window.__posts.length`)) === 0 && /changed/.test((await dialog() || {}).err || ''), at + 'a card that changed sends nothing and says so: ' + JSON.stringify(await dialog()));
            await closeDialog();
            // only the No form when the request can only be rejected
            await setCard({ ...TRUST, only_reject: true });
            await openRow(); d = await dialog();
            check(!!d && d.buttons.join('|') === 'No, exit' && /can only be rejected/.test(d.text), at + 'a request that can only be rejected offers the No form alone: ' + JSON.stringify(d));
            await closeDialog();
            // no single choice (a multi-select): no buttons, a way to the agent
            await setCard({ ...TRUST, multi: true });
            await openRow(); d = await dialog();
            check(!!d && d.buttons.length === 0 && /Open the agent to answer it/.test(d.text), at + 'a card with no single choice says so: ' + JSON.stringify(d));
            await closeDialog();
            check(!(await dialog()), at + 'Close closes the dialog');
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_permission_card_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
