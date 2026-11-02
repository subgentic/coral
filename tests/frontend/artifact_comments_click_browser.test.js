// The first real click on a comment's author name after typing a reply is not lost (#12301): in a file's comment thread the reply box's blur used to redraw the thread between the mouse going down and coming up, so the click never
// landed and a second one was needed. Real mouse events (CDP Input) at 1280 and 390 px, against the comments suite's stubbed API: type in a reply box, then press and release on another comment's author name: that card is made current at the first click,
// and the text typed is still in the box. The author is a running agent here (its name is a link that opens its chat, #12168): the first press-and-release on it asks "Leave this dialog?" since a reply is typed (#12299).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme, installAudit, auditRegion } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const HEX = 'd'.repeat(64);
const MD = ['# Migration plan', '', '## Steps', '', '1. Add the new columns behind a flag and backfill in batches of 500 rows.', '2. Switch reads to the new columns.', '', '## Risks', '', 'The backfill takes a write lock on large databases, so it must run off-peak.', '', 'Add a flag. Then wait. Add a flag again at the end.'].join('\n');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const STUB = `(() => {
        const real = window.fetch; window.__calls = []; window.__cs = [
            { id: 1, parent_id: null, anchor: { quote: 'backfill in batches of 500 rows.', prefix: 'columns behind a flag and', suffix: '2. Switch', start_line: 5, end_line: 5 }, body: 'Batches of 500 is too small. Try 5,000.', author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date(Date.now() - 120000).toISOString() },
            { id: 2, parent_id: 1, anchor: null, body: 'Agreed. Last run took 9 s per 5,000.', author: { kind: 'hub', issuer: 'coral-hub', subject: 'hub-user-3f2a' }, created_at: new Date(Date.now() - 60000).toISOString() },
            { id: 3, parent_id: null, anchor: { quote: 'takes a write lock on large databases', prefix: 'The backfill', suffix: ', so it must run' }, body: 'Define off-peak: 02:00 to 05:00 UTC?', author: { kind: 'hub', issuer: 'coral-hub', subject: 'hub-user-3f2a' }, created_at: new Date(Date.now() - 3600000).toISOString() },
            { id: 4, parent_id: null, anchor: { quote: 'Run the backfill nightly until it is done.' }, body: 'This step was reworded.', author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date(Date.now() - 259200000).toISOString() },
            { id: 5, parent_id: null, anchor: { quote: 'Switch reads to the new columns.' }, body: 'Fine.', author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date(Date.now() - 86400000).toISOString(), resolved_at: new Date().toISOString(), resolved_by: { issuer: 'local', subject: 'Operator' } },
        ]; window.__next = 6; window.__role = 'owner'; window.__locked = false; window.__missing = false;
        const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o) => {
            const url = String(u), method = (o && o.method) || 'GET';
            if (url.includes('/api/artifacts/${HEX}/comments')) {
                window.__calls.push({ method, url, body: o && o.body ? JSON.parse(o.body) : null });
                if (window.__missing) return json({ error: 'not found' }, 404);
                const me = window.__role, mine = c => (me === 'owner' && c.author.kind === 'owner'), sub = url.split('/comments')[1].split('?')[0];
                const can = c => ({ reply: me === 'owner' && !window.__locked && c.parent_id == null, edit: mine(c) && !window.__locked, delete: mine(c), resolve: me === 'owner' && !window.__locked && c.parent_id == null });
                if (method === 'GET') return json({ comments: window.__cs.filter(c => !c.deleted_at || window.__cs.some(r => r.parent_id === c.id && !r.deleted_at)).map(c => ({ ...c, deleted: !!c.deleted_at, body: c.deleted_at ? '' : c.body, mine: mine(c), can: can(c) })), locked: window.__locked, you: { kind: me === 'owner' ? 'owner' : 'hub', name: me === 'owner' ? 'Operator' : 'hub-user-3f2a', can_comment: me === 'owner' && !window.__locked, reason: me === 'owner' ? '' : 'Your Coral Hub access is view only.', can_lock: me === 'owner' }, limits: { body: 8192, quote: 2048, comments: 500 } });
                if (me !== 'owner' && sub !== '') return json({ error: 'Your Coral Hub access is view only.' }, 403);
                if (method === 'POST' && sub === '') { const b = JSON.parse(o.body); const c = { id: window.__next++, parent_id: b.parent_id == null ? null : b.parent_id, anchor: b.anchor, body: b.body, author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date().toISOString() }; window.__cs.push(c); return json({ ...c, can: can(c), ...(b.parent_id != null ? { sent_to: 'Dev, QA' } : {}) }, 201); }
                const m = /^\\/(\\d+)(\\/(resolve|reopen))?$/.exec(sub); const c = m && window.__cs.find(x => x.id === Number(m[1]));
                if (m && c) {
                    if (method === 'PATCH') { c.body = JSON.parse(o.body).body; c.edited_at = new Date().toISOString(); return json({ ...c, can: can(c) }); }
                    if (method === 'DELETE') { if (!mine(c)) return json({ error: 'Only the author can delete a comment.' }, 403); c.deleted_at = new Date().toISOString(); return json({ ok: true }); }
                    if (m[3] === 'resolve') { c.resolved_at = new Date().toISOString(); return json({ ...c, can: can(c) }); }
                    if (m[3] === 'reopen') { delete c.resolved_at; return json({ ...c, can: can(c) }); }
                }
                if (sub === '/lock') { window.__locked = method === 'PUT'; return json({ ok: true }); }
                return json({ error: 'nope' }, 404);
            }
            if (url.includes('/api/artifacts/${HEX}')) return Promise.resolve(new Response(${JSON.stringify(MD)}, { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
            return real(u, o);
        };
        return true; })()`;
    const rect = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
    const open = async (extra) => {
        await ev(STUB);
        if (extra) await ev(extra);
        await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'plan.md' }); return true; })()`);
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`, 'the document', 8000);
    };
    const load = async (w, h, mobile, theme) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
        await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: theme }] });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`try { localStorage.removeItem('coral-artifact-comments-open'); } catch {} true`); // each view starts as a new viewer: nothing remembered
        await installAudit(ev); await setTheme(ev, theme);
    };

    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await load(w, h, mobile, 'dark');
            await open(`window.__cs.push({ id: 6, parent_id: null, anchor: { quote: 'Switch reads to the new columns.' }, body: 'I can do that today.', author: { kind: 'agent', issuer: 'coral', subject: 'Writer' }, created_at: new Date().toISOString() }); T.state.liveSessions = [{ session_id: 's-writer', name: 'writer-1', agent_type: 'claude', board_subscriber_id: 'Writer', board_project: '', archived: false }]; true`);
            await waitFor(`document.querySelectorAll('.ac-card').length >= 3`, `${w}: the threads`, 6000);
            if (mobile) { await ev(`document.querySelector('.ac-toggle').click(); true`); await waitFor(`!!document.querySelector('.ac-panel.ac-sheet-open')`, `${w}: the sheet`, 4000); }
            await ev(`document.querySelector('.ac-card[data-id="1"] .ac-replybox').click(); true`);
            await waitFor(`!!document.querySelector('.ac-input')`, `${w}: the reply box`, 4000);
            await ev(`document.querySelector('.ac-input').focus(); true`);
            await Input.insertText({ text: 'A reply I am typing' });
            const at = await ev(`(() => { const e = document.querySelector('.ac-card[data-id="6"] .ac-author'); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
            await Input.dispatchMouseEvent({ type: 'mouseMoved', x: at.x, y: at.y });
            await Input.dispatchMouseEvent({ type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
            await Input.dispatchMouseEvent({ type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
            await ev(framesJs(3));
            const after = await ev(`({ asks: !!document.querySelector('#confirm-modal') && getComputedStyle(document.querySelector('#confirm-modal')).display !== 'none', typed: (document.querySelector('.ac-input') || {}).value || '' })`);
            assert.ok(after.asks, `${w}: the first real click on a running agent's name in a comment asks "Leave this dialog?": ` + JSON.stringify(after));
            assert.equal(after.typed, 'A reply I am typing', `${w}: and the reply typed is still in the box`);
        }
    } finally { await client.close(); }
    console.log('artifact_comments_click_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
