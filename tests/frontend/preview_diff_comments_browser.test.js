// #17546: the preview diff uses the existing line-comment delivery path and leaves Chat readable at 1440.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const FILES = { 'e.go': { status: 'modified', original: 'package main\nfunc main() { old() }\n', current: 'package main\nfunc main() { changed() }\n', additions: 1, deletions: 1 } };
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const shot = async name => {
        if (!process.env.CORAL_SCREENSHOT_DIR) return;
        fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    };
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD + `;localStorage.setItem('coral-live-view-mode', 'chat');localStorage.setItem('coral-preview-pane-dock', 'column'); localStorage.setItem('coral-preview-column-width', '600');` });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await setTheme(ev, 'light');
            await ev(`window.__files = ${JSON.stringify(FILES)}; window.__posts = []; window.__comments = [];
                (() => { const R = window.fetch; const json = (b, status = 201) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                    window.fetch = (u, o = {}) => { const url = new URL(String(u), location.href), p = decodeURIComponent(url.pathname);
                        if (/\\/api\\/sessions\\/live\\/(wp|nt)\\/files(\\/refresh)?$/.test(p)) return json({ files: Object.entries(window.__files).map(([filepath, f]) => ({ filepath, status: f.status, additions: f.additions, deletions: f.deletions })), is_git: true, compare: { label: 'HEAD' } }, 200);
                        const m = /^\\/api\\/artifacts\\/(diff:[^/]+)\\/comments$/.exec(p);
                        if (m && (!o.method || o.method === 'GET')) return json({ comments: window.__comments, locked: false, you: { kind: 'owner', name: 'You', can_comment: true, can_lock: true }, limits: {} }, 200);
                        if (m && o.method === 'POST') { const b = JSON.parse(o.body); window.__posts.push({ key: m[1], ...b }); const c = { id: window.__comments.length + 1, parent_id: null, anchor: b.anchor, body: b.body, author: { subject: 'install-owner-id', name: 'You', kind: 'owner' }, created_at: new Date().toISOString(), mine: true, can: { reply: true, edit: true, delete: true, resolve: true }, sent_to: 'Dev' }; window.__comments.push(c); return json(c); }
                        const f = window.__files[String(url.searchParams.get('filepath') || '').replace(/^[/]+/, '')];
                        if (f && /\\/file-original$/.test(p)) return json({ content: f.original }, 200);
                        if (f && /\\/file-content$/.test(p) && !(o && o.method === 'PUT')) return json({ content: f.current }, 200);
                        return R(u, o); }; })(); true`);
        await ev(`window.__m.add('wp', 'A', 3, { sleeping: false, session_id: 'wp-sess1', board_project: 'team-x' }); true`);
        await ev(framesJs(3));
        await ev(`window.selectLiveSession('wp', 'claude', 'wp-sess1', 'local'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'preview_pane.js').then(m => { m.openPreviewTab('e.go', 0, { diff: true }); return true; })`);
        await waitFor(`!!document.querySelector('#preview-body .cm-line')`, 'preview diff');
        await ev(framesJs(3)); await shot('preview-1440');
        const width = await ev(`document.getElementById('live-history-messages').getBoundingClientRect().width`);
        if (width < 419) problems.push(`Chat keeps 420 px: ${width}`);
        const icon = await waitFor(`!!document.querySelector('#preview-toolbar .file-comment-btn')`, 'preview comment button', 3000).then(() => true).catch(() => false);
        if (!icon) { console.log('preview diagnostic', await ev(`({ session: T.state.currentSession, hidden: document.getElementById('preview-body').hidden, drawing: document.getElementById('preview-body').dataset.drawing, notes: document.getElementById('preview-body').textContent.slice(-1500), icons: document.querySelectorAll('.file-comment-btn').length })`)); problems.push('Preview diff offers the existing comments component'); }
        if (icon) {
            await ev(`(() => { const line = [...document.querySelectorAll('#preview-body .cm-content .cm-line')].find(l => l.textContent.includes('changed()')); const range = document.createRange(); range.selectNodeContents(line); const s = getSelection(); s.removeAllRanges(); s.addRange(range); document.getElementById('preview-body').dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; })()`);
            await waitFor(`!!document.querySelector('#preview-body .diff-comment-btn:not([hidden])')`, 'comment on selected line');
            await ev(`document.querySelector('#preview-body .diff-comment-btn').click(); true`);
            await waitFor(`!!document.querySelector('#preview-body .ac-input')`, 'line comment composer');
            await ev(`(() => { const t = document.querySelector('#preview-body .ac-input'); t.value = 'Please explain this changed call'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#preview-body .ac-send').click(); return true; })()`);
            await waitFor(`window.__posts.length === 1`, 'comment sent to existing diff endpoint');
            const post = await ev(`window.__posts[0]`);
            assert.match(post.key, /^diff:team-x:wp-sess1:[0-9a-f]{16}$/);
            assert.equal(post.board, 'team-x');
            assert.equal(post.anchor.path, 'e.go'); assert.equal(post.anchor.start_line, 2); assert.equal(post.anchor.side, 'new');
            assert.match(post.anchor.quote, /changed/);
            await waitFor(`!!document.querySelector('#preview-body .ac-card')`, 'sent comment thread');
            await shot('comment-1440');
            await ev(`import((window.__coralStatic || '/static/') + 'preview_pane.js').then(m => { m.closeAllTabs(); return true; })`);
            assert.equal(await ev(`document.querySelectorAll('#preview-toolbar .file-comment-btn').length`), 0, 'closing the diff removes its comments button');
        }
        assert.deepEqual(problems, []);
        console.log('preview_diff_comments: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
