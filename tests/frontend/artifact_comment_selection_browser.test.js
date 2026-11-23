// A comment's text can be selected and copied (the Operator, native app: 'After I highlight it it immediately is unselected'). The click that ends a selection is not a click on the card (it redrew the panel and
// dropped the selection), and the panel's own poll waits while text in it is selected, then draws what changed (a new read receipt included). 1280 and 390 px. Comments stubbed at the page's fetch. Isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const HEX = 'e'.repeat(64);
const MD = ['# Plan', '', 'A plan to read.', ''].join('\n');
const ago = ms => new Date(Date.now() - ms).toISOString();
const COMMENTS = [
    { id: 1, parent_id: null, anchor: { whole: true }, body: 'Copy these words please.', asks: [{ agent: 'Writer A', open: true, replies: 0, seen: false, nudged: false, read_at: '' }] },
    { id: 2, parent_id: null, anchor: { whole: true }, body: 'Another comment.', asks: [] },
].map(c => ({ ...c, author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: ago(20 * 60000) }));

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const S = `(window.__coralStatic || '/static/')`;
    const SEL = `(() => { const s = getSelection(); return { text: s.toString(), collapsed: s.isCollapsed }; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`localStorage.clear(); globalThis.__coralCommentsPollMs = 300; window.__cs = ${JSON.stringify(COMMENTS)}; (() => { const real = window.fetch, json = (o, s = 200) => Promise.resolve(new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                    if (url.includes('/api/artifacts/${HEX}/comments') && m === 'GET') return json({ comments: window.__cs.map(c => ({ ...c, deleted: false, mine: true, can: { reply: true, edit: false, delete: false, resolve: true } })), locked: false, you: { kind: 'owner', can_comment: true, can_lock: true }, limits: {} });
                    if (url.includes('/api/artifacts/${HEX}')) return Promise.resolve(new Response(${JSON.stringify(MD)}, { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
                    return real(u, o); }; return true; })()`);
            await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'plan.md', board: 'ask-team' }); return true; })()`);
            await waitFor(`!!document.querySelector('.ac-toggle')`, `${at}the comments toggle`, 8000);
            await ev(`(() => { const t = document.querySelector('.ac-toggle'); if (t && t.getAttribute('aria-expanded') !== 'true') t.click(); return true; })()`);
            await waitFor(`document.querySelectorAll('#artifact-viewer .ac-card').length >= 2`, `${at}the comments`, 8000);
            const select = () => ev(`(() => { const p = document.querySelector('#artifact-viewer .ac-card[data-id="1"] .ac-body'); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); })()`);
            const sample = await select();
            check(sample === 'Copy these words please.', `${at}the comment's text can be selected: ` + JSON.stringify(sample));
            check(await ev(`getComputedStyle(document.querySelector('#artifact-viewer .ac-card[data-id="1"] .ac-body')).userSelect !== 'none'`), `${at}the comment text is selectable (no user-select: none)`);
            // 1. the click that ends the highlight lands on the card
            await ev(`document.querySelector('#artifact-viewer .ac-card[data-id="1"] .ac-body').click(); true`);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: waiting for a redraw that must NOT happen
            let s = await ev(SEL);
            check(s.text === sample && !s.collapsed, `${at}a click that ends a selection keeps the selected text: ` + JSON.stringify(s));
            // 2. a poll goes by, nothing changed
            await select(); await new Promise(r => setTimeout(r, 1300)); // sleep-ok: waiting for a redraw that must NOT happen
            s = await ev(SEL);
            check(s.text === sample && !s.collapsed, `${at}polls with nothing new keep the selection: ` + JSON.stringify(s));
            // 3. a new read receipt arrives while the text is selected
            await ev(`window.__cs[0].asks[0].read_at = new Date().toISOString(); window.__cs[0].asks[0].seen = true; true`);
            await new Promise(r => setTimeout(r, 1300)); // sleep-ok: waiting for a redraw that must NOT happen
            s = await ev(SEL);
            check(s.text === sample && !s.collapsed, `${at}a new read receipt does not drop the selection: ` + JSON.stringify(s));
            // ... and the line is drawn once the selection is let go
            await ev(`getSelection().removeAllRanges(); true`);
            await waitFor(`/^Read by Writer A/.test((document.querySelector('#artifact-viewer .ac-card[data-id="1"] .ac-ask-status')?.textContent || '').trim())`, `${at}the receipt is drawn once nothing is selected`, 8000);
            // a plain click on a card still makes it the current thread
            await ev(`document.querySelector('#artifact-viewer .ac-card[data-id="2"] .ac-body').click(); true`);
            check(await ev(`document.querySelector('#artifact-viewer .ac-card[data-id="2"]').classList.contains('ac-active')`), `${at}a plain click still makes the card current`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS selected comment text stays selected through a click, a poll and a new read receipt');
})().catch(e => { console.error(e); process.exit(1); });
