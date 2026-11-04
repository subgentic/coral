// #13169 (the operator's shot of a Codex 'Would you like to run the following command?' card): the permission dialog overlapped. Open agent and Close sat over the command and the choices, the choices' labels ran
// past their buttons, the command ran off the right edge unwrapped. The card shares .inbox-ask-dialog with the Operator's question dialog, whose 1000 px two-column grid auto-placed the card's body, error line and
// buttons into cells made for a reader and a reply box. The card now has its own layout: a column, the body scrolls, Open agent and Close are a row at the bottom, the command is a wrapped block, the choices wrap.
// Codex, Claude and Gemini prompt shapes, a 400-character command, at 1440 (the operator's question dialog's styles loaded first, as after any question opened), 390, and 390 with 200% text; light and dark.
// Asserts: nothing past the dialog's edge, no two of the card's parts overlap, no label wider than its button, the command wraps. The agent's chat and answer-prompt routes are page stubs.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const { themeJs } = require('./helpers/theme');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

const CMD = '/bin/zsh -lc "git add coral-go/pkg/frontend/static/css/permission_card_dialog.css coral-go/pkg/frontend/static/inbox_agent_card.js tests/frontend/permission_card_layout_browser.test.js && git diff --cached --stat && git diff --cached -- coral-go/pkg/frontend/static | head -n 400 && echo done-with-the-longest-line-of-all"'; // about 330 characters, no spaces to wrap at but a few
const LONGCMD = CMD + ' ' + 'x'.repeat(80) + ' ' + 'y'.repeat(60); // over 400
const SHAPES = {
    codex: { title: 'Would you like to run the following command?', question: 'Would you like to run the following command?', target: LONGCMD, ask_id: 'a-codex', options: [
        { n: 1, label: 'Yes, proceed (y)', action: 'select' },
        { n: 2, label: "Yes, and don't ask again for commands that start with `/bin/zsh -lc git add` (p)", action: 'select' },
        { n: 3, label: 'No, and tell Codex what to do differently (esc)', action: 'select' }] },
    claude: { title: 'Do you want to proceed?', question: 'Bash command\n\n' + CMD + '\nRun the staged diff', target: '', ask_id: 'a-claude', options: [
        { n: 1, label: 'Yes', action: 'select' },
        { n: 2, label: "Yes, and don't ask again for git diff commands in /Users/someone/Software/coral/coral-go", action: 'select' },
        { n: 3, label: 'No, and tell Claude what to do differently (esc)', action: 'select' }] },
    gemini: { title: 'Allow execution of: git?', question: 'Allow execution of: git?', target: LONGCMD, ask_id: 'a-gemini', options: [
        { n: 1, label: 'Allow once', action: 'select' }, { n: 2, label: 'Allow for this session', action: 'select' }, { n: 3, label: 'No, suggest changes (esc)', action: 'select' }] },
};

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], T = '#group-table-view', S = `(window.__coralStatic || '/static/')`;
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const AGENT = { name: 'be', session_id: '00000001-0000-4000-8000-000000000001', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Backend Dev', working_directory: '/repo/be', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run a command', waiting_since: new Date(Date.now() - 120000).toISOString() };
    const measure = () => ev(`(() => {
        const d = document.querySelector('dialog.inbox-ask-dialog[open]'); if (!d) return null;
        const R = e => e.getBoundingClientRect(), dr = R(d), vw = innerWidth, vh = innerHeight;
        const vis = e => e.getClientRects().length > 0;
        const parts = [...d.querySelectorAll('h2, .inbox-ask-sub, .inbox-ask-text, .inbox-ask-offers-list > button, .inbox-ask-buttons > button')].filter(vis).map(e => ({ cls: e.className || e.tagName, r: R(e), over: e.scrollWidth - e.clientWidth, t: e.textContent.slice(0, 24) }));
        const inter = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
        const overlaps = []; for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (inter(parts[i].r, parts[j].r)) overlaps.push(parts[i].t + ' x ' + parts[j].t);
        const past = parts.filter(p => p.r.right > dr.right + 1 || p.r.left < dr.left - 1).map(p => p.t);
        const wide = parts.filter(p => p.over > 1).map(p => p.t + ' +' + p.over);
        const foot = d.querySelector('.inbox-ask-buttons'), fr = R(foot), cmd = d.querySelector('.inbox-ask-text:last-of-type, .inbox-ask-text');
        return { dialog: { l: Math.round(dr.left), r: Math.round(dr.right), t: Math.round(dr.top), b: Math.round(dr.bottom), vw, vh }, inViewport: dr.left >= -1 && dr.right <= vw + 1 && dr.top >= -1 && dr.bottom <= vh + 1, overlaps, past, wide, n: parts.length,
            footBelowBody: fr.top >= R(d.querySelector('.inbox-card-body')).bottom - 1, footInside: fr.bottom <= dr.bottom + 1, display: getComputedStyle(d).display, cmdWraps: !cmd || cmd.scrollWidth <= cmd.clientWidth + 1 }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, zoom] of [[1440, 900, false, '100%'], [390, 844, true, '100%'], [390, 844, true, '200%']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(INBOX_WORLD);
            await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
                window.__card = null;
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                    if (u.pathname === '/api/sessions/live/be/chat') return json({ prompt_options: window.__card });
                    if (u.pathname === '/api/sessions/live/be/answer-prompt' && opts.method === 'POST') return json({ ok: true });
                    return original(url, opts); };
                return true; })()`);
            await ev(`(async () => { await import(${S} + 'operator_ask_dialog.js'); return true; })()`); // loads the question dialog's styles, its grid among them: the shot's state
            await ev(`(async () => { const { state } = await import(${S} + 'state.js'); const m = await import(${S} + 'inbox_tab.js'); state.liveSessions = [${JSON.stringify(AGENT)}]; m.updateInboxTab(); window.switchNavTab('hub-inbox'); await m.selectInboxTab('needs'); return true; })()`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 1`, 'the permission row', 15000); await ev(framesJs(6));
            for (const theme of ['dark', 'light']) {
                await ev(`${themeJs(theme)}; document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
                for (const [shape, card] of Object.entries(SHAPES)) {
                    const at = `${w}px ${zoom} ${theme} ${shape}: `;
                    await ev(`window.__card = ${JSON.stringify(card)}; true`);
                    await ev(`document.querySelector('${T} tbody tr .dt-primary').click(); true`);
                    await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open] .inbox-ask-offers-list button')`, at + 'the card dialog', 8000); await ev(framesJs(4));
                    const m = await measure();
                    check(!!m && m.n >= 6, at + 'the card drew its parts: ' + JSON.stringify(m));
                    if (m) {
                        check(m.inViewport, at + 'the dialog is inside the window: ' + JSON.stringify(m.dialog));
                        check(m.overlaps.length === 0, at + 'no two parts overlap: ' + m.overlaps.join('; '));
                        check(m.past.length === 0, at + 'nothing is past the dialog edge: ' + m.past.join('; '));
                        check(m.wide.length === 0, at + 'no label or line is wider than its box: ' + m.wide.join('; '));
                        check(m.footBelowBody && m.footInside, at + 'Open agent and Close are a row under the body, inside the dialog');
                        check(m.display === 'flex', at + 'the card is a column, not the question dialog\'s grid: ' + m.display);
                    }
                    if (theme === 'dark' && shape === 'codex') await shot(`permission_card_${w}_${zoom.replace('%', '')}`);
                    await ev(`[...document.querySelectorAll('dialog.inbox-ask-dialog[open] .inbox-ask-buttons button')].find(b => b.textContent === 'Close')?.click(); true`);
                    await waitFor(`!document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'Close closes the card', 4000);
                }
            }
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('permission_card_layout_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
