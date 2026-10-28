// One-line tips where the words are (#10074 area 2, Desktop #10070 and Mobile #10069): a newcomer hovering a term finds what it means without leaving the screen. Copy only, no renames.
//  - New agent: each Permission mode option says what it lets the agent do (Plan, Accept edits, Auto, Bypass permissions vs Don't ask are told apart), the provider list names the plain terminal "Plain terminal (no AI)", Thinking, Flags
//    and Tool permissions each say what they are.
//  - The top tabs (Inbox, Automations, Docs) and the Inbox's Needs you and Artifacts rows say what is behind them (Artifacts: "Files agents shared").
//  - The agent header's icons say what they do (Chat view, Terminal view, open in its own window, show or hide the side panel).
// 1280 px; isolated dev server over CDP, through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const { install: installNA, openNewAgent } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await sleep(350); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }; // sleep-ok: a picture waits for the paint
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await installNA(ev);

        // the top tabs
        const tabs = await ev(`Object.fromEntries(['hub-inbox', 'automations', 'docs'].map(k => [k, (document.getElementById('nav-tab-' + k) || {}).title || '']))`);
        check('the Inbox, Automations and Docs tabs say what is behind them', /waiting|needs you/i.test(tabs['hub-inbox']) && /schedule|run/i.test(tabs.automations) && /how coral works|docs|guide/i.test(tabs.docs), JSON.stringify(tabs));

        // the Inbox's rows
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`[...document.querySelectorAll('.view-list-name')].some(n => n.textContent === 'Needs you')`, 'the Inbox rows', 10000);
        const rows = await ev(`Object.fromEntries(['Needs you', 'Artifacts'].map(n => { const b = [...document.querySelectorAll('.view-list-name')].find(x => x.textContent === n); return [n, b ? (b.closest('button') || {}).title || '' : null]; }))`);
        check('Needs you and Artifacts say what they hold (Artifacts: files agents shared)', /waiting|question|permission|review/i.test(rows['Needs you'] || '') && /^Files agents shared/i.test(rows.Artifacts || ''), JSON.stringify(rows));
        await shot('tips-inbox-1280');

        // the agent header's icons
        await ev(`window.switchNavTab('agents'); window.__m.add('tip-agent', 'T', 2, { sleeping: false }); window.T.render.renderLiveSessions(window.T.state.liveSessions); true`);
        const head = await ev(`Object.fromEntries(['live-view-btn-chat', 'live-view-btn-terminal', 'terminal-open-window-link', 'popout-panel-toggle-btn', 'chat-find-btn'].map(id => { const e = document.getElementById(id); return [id, e ? { title: e.title, name: e.getAttribute('aria-label') } : null]; }))`);
        check('the header icons have a tip that says what they do and a name that agrees', /read and send/i.test(head['live-view-btn-chat'].title) && /what the agent sees|terminal/i.test(head['live-view-btn-terminal'].title) && /own window/i.test(head['terminal-open-window-link'].title) && /side panel/i.test(head["popout-panel-toggle-btn"].title) && /find/i.test(head['chat-find-btn'].title) && Object.values(head).every(h => h.name && h.name.length > 2), JSON.stringify(head));

        // the New agent dialog
        await openNewAgent(ev, waitFor);
        const dlg = await ev(`(() => { const o = [...(window.__na.dialog() || document).querySelectorAll('.acf-permission-mode option')].map(x => [x.value, x.title]); const t = [...document.querySelectorAll('.acf-agent-type option')].find(x => x.value === 'terminal'); const root = window.__na.dialog() || document, q = s => (root.querySelector(s) || {}).title || '';
            return { modes: Object.fromEntries(o), terminal: t ? t.textContent : null, thinking: q('.acf-thinking'), flags: q('.acf-flags'), tools: q('.acf-tools-details summary') }; })()`);
        const m = dlg.modes;
        check('each Permission mode says what it lets the agent do, and Bypass and Don\'t ask are told apart', ['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk'].every(k => (m[k] || '').length > 10) && /reads only/i.test(m.plan) && /edit/i.test(m.acceptEdits) && /protected|isolated/i.test(m.bypassPermissions) && /approved|pre-approved/i.test(m.dontAsk) && m.bypassPermissions !== m.dontAsk, JSON.stringify(m));
        check('the plain terminal is named "Plain terminal (no AI)" in the agent list', dlg.terminal === 'Plain terminal (no AI)', String(dlg.terminal));
        check('Thinking, Flags and Tool permissions each say what they are', /how hard/i.test(dlg.thinking) && /options|command/i.test(dlg.flags) && /allow|without asking|tools/i.test(dlg.tools), JSON.stringify([dlg.thinking, dlg.flags, dlg.tools]));
        await shot('tips-new-agent-1280');

        // Settings > Agents: each row says in one visible line what it does (the longer note stays behind its (i))
        await ev(`window.hideLaunchModal && window.hideLaunchModal(); window.showSettingsModal(); true`);
        await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none'`, 'Settings', 8000);
        await ev(`document.getElementById('settings-tab-agents').click(); true`);
        await sleep(600); // sleep-ok: the pane is drawn when its tab is picked
        const rowsHelp = await ev(`Object.fromEntries(['settings-working-dir', 'settings-default-thinking-claude', 'settings-auto-resume', 'settings-auto-goals', 'settings-agent-low-priority', 'settings-board-auto-attach', 'settings-nudge-claude-artifacts', 'settings-codex-trust-hooks'].map(id => { const e = document.getElementById(id), row = e && e.closest('.sv-row'), h = row && [...row.querySelectorAll('.sv-help')].find(x => x.getClientRects().length > 0 && x.textContent.trim()); return [id, h ? h.textContent.trim() : null]; }))`);
        check('each Settings > Agents row has a visible one-line description', Object.values(rowsHelp).every(t => t && t.length > 15 && t.length < 110), JSON.stringify(rowsHelp));
        await shot('tips-settings-agents-1280');
    } finally { await client.close(); }
    if (results.some(x => !x)) { console.error(`${results.filter(x => !x).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} tip checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
