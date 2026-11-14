// Comment threads, polish (#15119, walk 3 N11-N15, N23): the reply box scrolls into view and says how to send (Enter adds a line, Ctrl/Cmd+Enter sends); Add comment shows for a selection over
// two lines or two paragraphs; the status line under a comment says what it means (no "already asked"), and its read mark is about the NEWEST message; a comment's place reads "In the file, line N";
// the comments pane keeps the choice made (a different file does not flip it) and the viewer does not change width when the pane opens. Stubbed comments API. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, waitStable } = require('./helpers/wait');
const HEX = 'e'.repeat(64);
const MD = ['# Plan', '', 'First line of a paragraph that goes on', 'and a second line of the same paragraph.', '', 'A separate second paragraph.', '', 'Last paragraph, with a few more words to quote.', '', '| Step | What happens |', '| --- | --- |', '| One | Add the columns behind a flag and fill them in batches. |', '| Two | Switch reads over. |'].join('\n');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const S = `(window.__coralStatic || '/static/')`;
    const ago = ms => `new Date(Date.now() - ${ms}).toISOString()`;
    const STUB = `(() => {
        if (window.__stubbed) return true; window.__stubbed = true;
        const real = window.fetch;
        const mk = (id, parent, body, mine, extra) => ({ id, parent_id: parent, anchor: parent ? null : { quote: 'A separate second paragraph.', start_line: 12, end_line: 12 }, body, author: { kind: mine ? 'owner' : 'agent', issuer: 'local', subject: mine ? 'Operator' : 'Lead Developer' }, created_at: ${ago(600000)}, ...extra });
        window.__cs = [mk(1, null, 'Is this right?', true, { asks: [{ agent: 'Lead Developer', open: true, replies: 1, seen: true, read_at: ${ago(300000)} }] }), mk(2, 1, 'Yes, it is.', false, { created_at: ${ago(420000)} }), mk(3, 1, 'Then add a note on timing.', true, { created_at: ${ago(60000)} })];
        for (let i = 4; i < 16; i++) window.__cs.push(mk(i, 1, 'More discussion ' + i + ' that takes a few words of room.', i % 2 === 0, { created_at: ${ago(500000)} }));
        window.__cs[window.__cs.length - 1].created_at = ${ago(30000)}; window.__cs[window.__cs.length - 1].author = { kind: 'owner', issuer: 'local', subject: 'Operator' };
        window.__sent = [];
        const json = (o, s) => Promise.resolve(new Response(JSON.stringify(o), { status: s || 200, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o) => { const url = String(u), method = (o && o.method) || 'GET';
            if (url.includes('/api/artifacts/${HEX}/comments')) {
                const can = c => ({ reply: c.parent_id == null, edit: false, delete: false, resolve: c.parent_id == null });
                if (method === 'GET') return json({ comments: window.__cs.map(c => ({ ...c, deleted: false, mine: c.author.kind === 'owner', can: can(c) })), locked: false, you: { kind: 'owner', can_comment: true, can_lock: true }, limits: {} });
                if (method === 'POST') { const b = JSON.parse(o.body); window.__sent.push(b); const c = mk(100 + window.__sent.length, b.parent_id == null ? null : b.parent_id, b.body, true, { anchor: b.anchor }); window.__cs.push(c); return json({ ...c, mine: true, can: can(c) }); }
            }
            if (url.includes('/api/artifacts/${HEX}')) return Promise.resolve(new Response(${JSON.stringify(MD)}, { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
            return real(u, o); };
        return true; })()`;
    const open = async () => { await ev(STUB); await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'plan.md', board: 'ask-team' })); true`); await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`, 'the document', 8000); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`import(${S} + 'safe_storage.js').then(({ browserLocal }) => { browserLocal.remove('coral-artifact-comments-open'); browserLocal.remove('coral-artifact-comments:text/markdown'); return true; })`);
            await open();
            await waitFor(`!!document.querySelector('.ac-toggle')`, `${at}the Comments button`, 8000);
            if (await ev(`document.querySelector('.ac-toggle').getAttribute('aria-expanded') !== 'true'`)) await ev(`document.querySelector('.ac-toggle').click(); true`);
            await waitFor(`document.querySelectorAll('.ac-card').length >= 1`, `${at}the thread`, 8000);
            await waitFor(`document.querySelector('.ac-panel').classList.contains('ac-sheet-open')`, `${at}the comments open`, 6000);
            await waitFor(`document.querySelector('.ac-panel').getBoundingClientRect().top < innerHeight - 40`, `${at}the panel on screen (a phone's sheet slides in)`, 6000);

            console.log(`${at}1. The place reads in plain words`);
            const lines = await ev(`document.querySelector('.ac-lines')?.textContent`);
            assert.equal(lines, 'In the file, line 12', at + 'line label: ' + lines);

            console.log(`${at}2. Reply: the box is in view, says how to send, and Ctrl+Enter sends`);
            await ev(`document.querySelector('.ac-panel').scrollTop = 0; document.querySelector('.ac-card .ac-replybox').click(); true`);
            await waitFor(`!!document.querySelector('.ac-card .ac-input')`, `${at}the reply box`, 4000);
            await waitStable(ev, `(() => { const r = document.querySelector('.ac-panel').getBoundingClientRect(); return [r.top, r.bottom].map(Math.round).join(); })()`, `${at}the sheet to stop sliding`); // a phone's sheet slides in for 0.2 s
            const inView = await ev(`(() => { const t = document.querySelector('.ac-card .ac-input').getBoundingClientRect(), p = document.querySelector('.ac-panel').getBoundingClientRect(); return t.top >= p.top - 1 && t.bottom <= Math.max(p.bottom, innerHeight) + 1 && t.bottom <= innerHeight + 1; })()`);
            assert.ok(inView, at + 'the reply box is scrolled into view: ' + JSON.stringify(await ev(`(() => { const t = document.querySelector('.ac-card .ac-input').getBoundingClientRect(), p = document.querySelector('.ac-panel'), r = p.getBoundingClientRect(); return { t: [t.top, t.bottom], p: [r.top, r.bottom], h: innerHeight, st: p.scrollTop, sh: p.scrollHeight, ch: p.clientHeight }; })()`)));
            const hint = await ev(`document.querySelector('.ac-card .ac-counter:not(.ac-sendhint)').textContent`);
            assert.ok(mobile ? / \/ \d+$/.test(hint) && !/sends/.test(hint) : / · (Ctrl\+Enter|⌘ Return) sends$/.test(hint), at + (mobile ? 'a touch screen has no shortcut to say: ' : 'the shortcut is said beside the count: ') + hint);
            await ev(`(() => { const ta = document.querySelector('.ac-card .ac-input'); ta.focus(); ta.value = 'Thanks'; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', modifiers: 2 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 });
            await waitFor(`window.__sent.length === 1 && window.__sent[0].body === 'Thanks'`, `${at}Ctrl+Enter sent the reply`, 6000);
            await ev(`window.__sent.length = 0; true`);

            console.log(`${at}3. The status line: the read mark is about the newest message, and no "already asked"`);
            const status = () => ev(`document.querySelector('.ac-card[data-id="1"] .ac-ask-status')?.textContent || null`);
            let st = await status();
            assert.ok(st && /^Lead Developer replied$/.test(st), at + 'the agent replied: a reply is never overridden to "not read yet" (F29): ' + st);
            await ev(`window.__cs[0].asks[0].read_at = new Date().toISOString(); document.querySelector('.artifact-viewer-close')?.click(); true`);
            await waitFor(`document.getElementById('artifact-viewer').hidden`, `${at}the viewer closes`, 4000);
            await open();
            if (await ev(`document.querySelector('.ac-toggle').getAttribute('aria-expanded') !== 'true'`)) await ev(`document.querySelector('.ac-toggle').click(); true`);
            await waitFor(`!!document.querySelector('.ac-card[data-id="1"] .ac-ask-status')`, `${at}the status line`, 6000);
            st = await status();
            assert.ok(/^Lead Developer replied$/.test(st || ''), at + 'a reply stays replied, never downgraded to Read by (F29): ' + st);

            console.log(`${at}4. A selection over two paragraphs and over a line break shows Add comment`);
            for (const [label, js] of [['two paragraphs', `(() => { const ps = [...document.querySelectorAll('#artifact-viewer .artifact-viewer-body p')]; const r = document.createRange(); r.setStart(ps[0].firstChild, 3); r.setEnd(ps[1].firstChild, 8); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; })()`], ['a triple click (the end is the start of the next block)', `(() => { const p = document.querySelector('#artifact-viewer .artifact-viewer-body p'); const r = document.createRange(); r.setStart(p.firstChild, 0); r.setEnd(p.nextElementSibling, 0); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; })()`], ['a table cell over to the next row', `(() => { const tds = [...document.querySelectorAll('#artifact-viewer .artifact-viewer-body td')]; const r = document.createRange(); r.setStart(tds[1].firstChild, 0); r.setEnd(tds[2].firstChild, 0); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; })()`], ['one paragraph over its line break', `(() => { const p = document.querySelector('#artifact-viewer .artifact-viewer-body p'); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; })()`]]) {
                await ev(js);
                await waitFor(`(() => { const b = document.querySelector('.ac-selbtn'); return !!b && !b.hidden && b.getClientRects().length > 0; })()`, `${at}Add comment for ${label}`, 4000);
            }

            console.log(`${at}5. Opening the comments does not move the header's buttons, and the choice is kept`);
            if (!mobile) {
                await ev(`document.querySelector('.artifact-viewer-close')?.click(); true`);
                await waitFor(`document.getElementById('artifact-viewer').hidden`, `${at}closed`, 4000);
                await ev(`import(${S} + 'safe_storage.js').then(({ browserLocal }) => { browserLocal.remove('coral-artifact-comments:text/markdown'); return true; })`);
                await open();
                await waitFor(`!!document.querySelector('.ac-toggle') && !document.querySelector('.ac-toggle').hidden`, `${at}the toggle`, 6000);
                const pos = () => ev(`(() => { const out = {}; for (const sel of ['.ac-toggle', '.artifact-viewer-close']) { const e = document.querySelector('#artifact-viewer ' + sel); if (!e) continue; const r = e.getBoundingClientRect(); out[sel] = Math.round(r.left) + ',' + Math.round(r.top); } return out; })()`);
                const shut = await ev(`document.querySelector('.ac-toggle').getAttribute('aria-expanded')`);
                const before = await pos();
                await ev(`document.querySelector('.ac-toggle').click(); true`);
                await waitFor(`document.querySelector('.ac-toggle').getAttribute('aria-expanded') !== ${JSON.stringify(shut)}`, `${at}the toggle flips`, 4000);
                await waitFor(`document.querySelector('.ac-panel').getClientRects().length > 0 === (document.querySelector('.ac-toggle').getAttribute('aria-expanded') === 'true')`, `${at}the panel follows`, 4000);
                const afterPos = await pos(); const dlg = await ev(`(() => { const v = document.getElementById('artifact-viewer'), r = v.getBoundingClientRect(), m = v.querySelector('.artifact-viewer-main')?.getBoundingClientRect(); return [r.left, r.width, m && m.width]; })()`); assert.deepEqual(afterPos, before, at + 'the header buttons did not move when the comments opened or closed: ' + JSON.stringify({ before, afterPos, dlg }));
            }
        }
        console.log('PASS comment thread polish');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
