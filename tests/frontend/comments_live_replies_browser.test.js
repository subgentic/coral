// #13299 (Developer experience, filming demo v5): an open comments panel (a file's in the viewer; a goal's tab uses the same panel) showed an agent's reply only when it was reopened. It now reads the thread every few seconds
// while it is open and on screen, and redraws when the thread differs: a reply that arrives while the panel is open appears without reopening, the panel keeps its scroll, a thread that did not change is not redrawn, and a
// closed viewer reads nothing. UI Reviewer's regressions (#13337): a late answer asked under another context is never shown (the same file hash in another team, a closed and reopened viewer), and a reply that arrives
// while a comment is being edited keeps the edit's words, caret and focus. The comments routes are page stubs (as in artifact_comments_browser); the poll is 400 ms here (the product's is 8 s). 1280 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const HEX = 'e'.repeat(64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the poll is on a timer: a stretch with no change is the thing measured
    const STUB = `(() => {
        const real = window.fetch; window.__gets = 0; window.__hold = null; window.__byBoard = null;
        const OWNER = { kind: 'owner', issuer: 'local', subject: 'Operator' };
        window.__cs = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, parent_id: null, anchor: { whole: true }, body: 'Comment number ' + (i + 1) + ' on the whole file.', author: OWNER, created_at: new Date(Date.now() - (40 - i) * 60000).toISOString() }));
        const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
        window.fetch = async (u, o) => { const url = String(u), method = (o && o.method) || 'GET';
            if (url.includes('/api/artifacts/${HEX}/comments') && method === 'GET') { window.__gets++;
                const board = new URL(url, location.origin).searchParams.get('board') || '', list = (window.__byBoard && window.__byBoard[board]) || window.__cs;
                if (window.__hold && window.__hold.board === board) await window.__hold.p;
                return json({ comments: list.map(c => ({ ...c, deleted: false, mine: true, can: { reply: true, edit: true, delete: true, resolve: true } })), locked: false, you: { kind: 'owner', name: 'Operator', can_comment: true, can_lock: true } }); }
            if (url.includes('/api/artifacts/${HEX}')) return new Response('# A note\\n\\nSome words.', { status: 200, headers: { 'Content-Type': 'text/markdown' } });
            return real(u, o); };
        return true; })()`;
    const panelText = () => ev(`document.querySelector('.ac-panel')?.textContent || ''`);
    const openViewer = async board => {
        await ev(`import(${S} + 'artifact_viewer.js').then(m => m.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'note.md', mediaType: 'text/markdown'${board ? `, board: ${JSON.stringify(board)}` : ''} })).then(() => true)`);
        await waitFor(`!!document.querySelector('.ac-toggle') && !document.querySelector('.ac-toggle').hidden`, 'the Comments button', 10000);
        if ((await ev(`document.querySelector('.ac-toggle').getAttribute('aria-expanded')`)) !== 'true') await ev(`document.querySelector('.ac-toggle').click(); true`);
    };
    const closeViewer = () => ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: 'window.__coralCommentsPollMs = 400;' });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(STUB);
        await openViewer();
        await waitFor(`/Comment number 30/.test(document.querySelector('.ac-panel')?.textContent || '')`, 'the thread in the panel', 10000);

        console.log('1. A reply that arrives while the panel is open appears without reopening, and the panel keeps its scroll');
        await ev(`(() => { const p = document.querySelector('.ac-panel'); p.scrollTop = 400; window.__top = p.scrollTop; return true; })()`);
        const top = await ev(`window.__top`);
        assert.ok(top > 100, 'the thread is long enough to scroll: ' + top);
        await ev(`window.__cs.push({ id: 31, parent_id: 1, anchor: null, body: 'The agent replied: it is done now.', author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date().toISOString() }); true`);
        await waitFor(`/The agent replied: it is done now/.test(document.querySelector('.ac-panel')?.textContent || '')`, 'the reply, with no reopening', 10000);
        const after = await ev(`document.querySelector('.ac-panel').scrollTop`);
        assert.ok(Math.abs(after - top) <= 2, `the scroll is kept (${top} before, ${after} after)`);
        await shot('comments-live-reply');
        console.log('   ✓');

        console.log('2. A thread that did not change is not redrawn (a draft or the focus is not disturbed)');
        await ev(`document.querySelector('.ac-panel .ac-card').dataset.mark = 'same'; window.__g0 = window.__gets; true`);
        await sleep(1600); // sleep-ok: a stretch of the poll with no change is the thing measured
        const quiet = await ev(`({ polled: window.__gets - window.__g0, kept: document.querySelector('.ac-panel .ac-card')?.dataset.mark })`);
        assert.ok(quiet.polled >= 2, 'the panel keeps reading while it is open: ' + JSON.stringify(quiet));
        assert.equal(quiet.kept, 'same', 'the cards were not redrawn when nothing changed: ' + JSON.stringify(quiet));
        console.log('   ✓');

        console.log('3. A reply that arrives while a comment is being edited keeps the edit: its words, its caret and the focus');
        await ev(`[...document.querySelectorAll('.ac-panel button')].find(b => b.textContent === 'Edit').click(); true`);
        await waitFor(`!!document.querySelector('.ac-panel textarea.ac-input')`, 'the editor', 8000);
        const typed = await ev(`(() => { const ta = document.querySelector('.ac-panel textarea.ac-input'), original = ta.value; ta.focus(); ta.value = original + ' - my unsaved edit'; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.setSelectionRange(3, 7); return { original, typed: ta.value }; })()`);
        assert.ok(/my unsaved edit$/.test(typed.typed) && typed.original !== typed.typed, 'the edit is typed: ' + JSON.stringify(typed));
        await ev(`window.__cs.push({ id: 40, parent_id: 2, anchor: null, body: 'A reply that arrived during the edit.', author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date().toISOString() }); true`);
        await waitFor(`/A reply that arrived during the edit/.test(document.querySelector('.ac-panel')?.textContent || '')`, 'the reply while editing', 10000);
        const ed = await ev(`(() => { const ta = document.querySelector('.ac-panel textarea.ac-input'); return ta ? { value: ta.value, start: ta.selectionStart, end: ta.selectionEnd, focused: document.activeElement === ta } : null; })()`);
        assert.ok(ed && ed.value === typed.typed, 'the edit keeps its words (not the saved text): ' + JSON.stringify({ ed, typed }));
        assert.ok(ed.start === 3 && ed.end === 7, 'the caret and selection are kept: ' + JSON.stringify(ed));
        assert.ok(ed.focused, 'the editor keeps the focus: ' + JSON.stringify(ed));
        await shot('comments-live-editing');
        await ev(`[...document.querySelectorAll('.ac-panel button')].find(b => b.textContent === 'Cancel')?.click(); true`);
        console.log('   ✓');

        console.log('4. A late answer asked under another context is never shown: the same file hash in another team');
        await closeViewer();
        await ev(`window.__byBoard = { 'team-a': [{ id: 1, parent_id: null, anchor: { whole: true }, body: 'Only in team A.', author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date().toISOString() }], 'team-b': [{ id: 1, parent_id: null, anchor: { whole: true }, body: 'Only in team B.', author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date().toISOString() }] }; true`);
        await openViewer('team-a');
        await waitFor(`/Only in team A/.test(document.querySelector('.ac-panel')?.textContent || '')`, "team A's thread", 10000);
        await ev(`window.__hold = { board: 'team-a', p: new Promise(r => { window.__release = r; }) }; window.__byBoard['team-a'].push({ id: 2, parent_id: null, anchor: { whole: true }, body: 'A late answer from team A.', author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date().toISOString() }); window.__g2 = window.__gets; true`);
        await waitFor(`window.__gets > window.__g2`, "team A's poll to be on its way (held)", 5000);
        await closeViewer();
        await openViewer('team-b');
        await waitFor(`/Only in team B/.test(document.querySelector('.ac-panel')?.textContent || '')`, "team B's thread", 10000);
        await ev(`window.__release(); window.__hold = null; true`);
        await sleep(1500); // sleep-ok: the held answer is let go and the panel is watched for it to (not) show
        const b = await panelText();
        assert.ok(/Only in team B/.test(b) && !/A late answer from team A|Only in team A/.test(b), "team B's panel shows team B's thread, not team A's late answer: " + b.slice(0, 160));
        console.log('   ✓');

        console.log('5. A late answer after the viewer closed does not draw the panel');
        await ev(`window.__hold = { board: 'team-b', p: new Promise(r => { window.__release = r; }) }; window.__byBoard['team-b'].push({ id: 2, parent_id: null, anchor: { whole: true }, body: 'A late answer from team B.', author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date().toISOString() }); window.__g3 = window.__gets; true`);
        await waitFor(`window.__gets > window.__g3`, "team B's poll to be on its way (held)", 5000);
        await closeViewer();
        await ev(`window.__release(); window.__hold = null; true`);
        await sleep(1200); // sleep-ok: the held answer is let go after the close and the panel is watched for it to (not) draw
        const shut = await ev(`({ shown: document.querySelector('.ac-panel')?.getClientRects().length || 0, text: document.querySelector('.ac-panel')?.textContent || '' })`);
        assert.ok(shut.shown === 0 && !/A late answer from team B/.test(shut.text), 'the closed viewer\'s panel stays closed and empty: ' + JSON.stringify(shut).slice(0, 200));
        console.log('   ✓');

        console.log('6. A closed viewer reads nothing');
        await ev(`window.__g1 = window.__gets; true`);
        await sleep(1500); // sleep-ok: a closed viewer's silence is the thing measured
        const idle = await ev(`window.__gets - window.__g1`);
        assert.equal(idle, 0, 'no reads after the viewer closed: ' + idle);
        console.log('   ✓');
        console.log('PASS comments live: a reply shows without reopening, scroll and edit kept, an unchanged thread is not redrawn, a late answer of another context or a closed viewer is never shown, a closed viewer reads nothing');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
