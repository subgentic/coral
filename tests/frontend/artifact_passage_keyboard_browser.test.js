// A passage comment by keyboard (#15173, Beta walk 7 H1: a document cannot be selected from the keyboard, so a keyboard-only person had no way to comment on a passage, and the empty panel said 'Select some text'):
// Tab reaches the document, Enter there starts choosing a passage, Down moves to the next, Enter opens the comment box on that passage (its words are the quote, the keyboard is in the box), Ctrl+Enter sends it anchored
// to the passage, Escape leaves the choosing; the empty panel names the way. Stubbed comments API. 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const HEX = 'd'.repeat(64);
const MD = ['# Plan', '', 'First paragraph of the plan that says what we build.', '', 'Second paragraph that says how long it takes.', '', '- A list item about the database', '- A list item about the cache', '', 'Last paragraph with the risks.'].join('\n');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const S = `(window.__coralStatic || '/static/')`, problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const key = async (k, extra = {}) => { const codes = { Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38 }, base = { key: k, code: k, windowsVirtualKeyCode: codes[k] || 0, ...(k === 'Enter' ? { text: '\r' } : {}), ...extra }; await Input.dispatchKeyEvent({ type: 'keyDown', ...base }); await Input.dispatchKeyEvent({ type: 'keyUp', ...base }); };
    const active = () => ev(`(() => { const a = document.activeElement; return a ? { tag: a.tagName.toLowerCase(), text: (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60), body: a.classList.contains('artifact-viewer-body'), input: a.classList.contains('ac-input') } : null; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
        await ev(`(() => { const real = window.fetch; window.__sent = [];
            const json = (o, s) => Promise.resolve(new Response(JSON.stringify(o), { status: s || 200, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u), method = (o && o.method) || 'GET';
                if (url.includes('/api/artifacts/${HEX}/comments')) {
                    if (method === 'GET') return json({ comments: [], locked: false, you: { kind: 'owner', can_comment: true, can_lock: true }, limits: {} });
                    if (method === 'POST') { const b = JSON.parse(o.body); window.__sent.push(b); return json({ id: 1, parent_id: null, anchor: b.anchor, body: b.body, author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date().toISOString(), mine: true, can: { reply: true, edit: false, delete: false, resolve: true } }); }
                }
                if (url.includes('/api/artifacts/${HEX}')) return Promise.resolve(new Response(${JSON.stringify(MD)}, { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
                return real(u, o); }; return true; })()`);
        await ev(`import(${S} + 'safe_storage.js').then(({ browserLocal }) => { browserLocal.set('coral-artifact-comments-open', 'open'); browserLocal.set('coral-artifact-comments:text/markdown', 'open'); return true; })`);
        await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'plan.md', board: 'kb-team' })); true`);
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`, 'the document', 8000);
        await waitFor(`document.querySelector('#artifact-viewer .artifact-viewer-body').getAttribute('tabindex') === '0'`, 'the document is a tab stop', 6000).catch(() => {});
        const hint = await ev(`(document.querySelector('.ac-panel .empty-state') || {}).textContent || ''`);
        check(/Enter/.test(hint) && /passage/.test(hint), 'the empty panel names the keyboard way: ' + JSON.stringify(hint));
        // Tab until the document has the keyboard (a handful of stops: the header's buttons come first)
        let a = await active();
        for (let i = 0; i < 25 && !(a && a.body); i++) { await key('Tab'); a = await active(); }
        check(a && a.body, 'Tab reaches the document: ' + JSON.stringify(a));
        await key('Enter');
        a = await active(); check(a && /Plan|First paragraph/.test(a.text) && !a.body, 'Enter starts choosing: the keyboard is on the first passage: ' + JSON.stringify(a));
        await key('ArrowDown'); a = await active(); await key('ArrowDown'); a = await active();
        check(a && /Second paragraph|First paragraph/.test(a.text), 'Down moves to another passage: ' + JSON.stringify(a));
        await key('Enter');
        await waitFor(`!!document.querySelector('.ac-panel .ac-input')`, 'the comment box opens', 4000).catch(() => {});
        a = await active(); check(a && a.input, 'Enter on a passage puts the keyboard in the comment box: ' + JSON.stringify(a));
        const quote = await ev(`(document.querySelector('.ac-panel .ac-quote') || {}).textContent || ''`);
        check(/Second paragraph that says how long it takes\./.test(quote), 'the box quotes the chosen passage: ' + JSON.stringify(quote));
        await ev(`(() => { const ta = document.querySelector('.ac-panel .ac-input'); ta.value = 'How long exactly?'; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', modifiers: 2 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 });
        await waitFor(`window.__sent.length === 1`, 'the comment is sent', 6000).catch(() => {});
        const sent = await ev(`window.__sent[0] || null`);
        check(sent && sent.body === 'How long exactly?' && sent.anchor && /Second paragraph that says how long it takes\./.test(sent.anchor.quote), 'the comment is anchored to the passage: ' + JSON.stringify(sent));
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('artifact_passage_keyboard_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
