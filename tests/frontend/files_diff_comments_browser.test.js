// Comments on an agent's diff (#12536, the Operator: "let me comment in the files diff view too, similar to how we handle the artifacts review"): select lines in a file's inline diff, press Comment, write it, and the thread
// stands under that diff; the comment is made on the key diff:<team>:<session>:<16 hex of the path> with the file, the side, the lines, the quoted lines and the state it was made on; the agent's reply comes into the
// thread in place; a comment whose lines left the diff says "outdated" and stays. Lines selected in a removed block are old-side lines. 1280 and 390 px. The panel's reads and the comments routes are answered in the
// page. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

const ORIG = Array.from({ length: 60 }, (_, i) => `func f${i}() int { return ${i} }`);
ORIG[5] = '}'; ORIG[45] = '}'; // a line that repeats: the removed one is line 46, and the first match of it is line 6 (#12560)
const CUR = ORIG.slice();
CUR[40] = 'func f40() int { return 4000 } // CHANGED LINE ONE';
CUR[41] = 'func f41() int { return 4100 } // CHANGED LINE TWO';
CUR[10] = 'func f10() int { return 1000 }';
CUR.splice(45, 1); // the second } is removed
const FILES = { 'e.go': { status: 'modified', original: ORIG.join('\n'), current: CUR.join('\n'), additions: 3, deletions: 3 } };
const TEAM = 'team-x', SID = 'wp-sess1';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 800, true]]) {
            const tag = `${w} px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`window.__files = ${JSON.stringify(FILES)}; window.__posts = []; window.__comments = [];
                (() => { const R = window.fetch; const json = (b, status = 201) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                    window.fetch = (u, o = {}) => { const url = new URL(String(u), location.href), p = decodeURIComponent(url.pathname);
                        if (/\\/api\\/sessions\\/live\\/wp\\/files(\\/refresh)?$/.test(p)) return json({ files: Object.entries(window.__files).map(([filepath, f]) => ({ filepath, status: f.status, additions: f.additions, deletions: f.deletions })), is_git: true, compare: { label: 'HEAD' } }, 200);
                        const m = /^\\/api\\/artifacts\\/(diff:[^/]+)\\/comments$/.exec(p);
                        if (m && (!o.method || o.method === 'GET')) return json({ comments: window.__comments, locked: false, you: { kind: 'owner', name: 'You', can_comment: true, can_lock: false }, limits: {} }, 200);
                        if (m && o.method === 'POST') { const b = JSON.parse(o.body); window.__posts.push({ key: m[1], ...b }); const c = { id: window.__comments.length + 1, parent_id: null, anchor: b.anchor, body: b.body, author: { subject: 'install-owner-id', name: 'You', kind: 'owner' }, created_at: new Date().toISOString(), mine: true, can: { reply: true, edit: true, delete: true, resolve: true }, sent_to: 'Dev' }; window.__comments.push(c); return json(c); }
                        const f = window.__files[String(url.searchParams.get('filepath') || '').replace(/^[/]+/, '')];
                        if (f && /\\/file-original$/.test(p)) return json({ content: f.original }, 200);
                        if (f && /\\/file-content$/.test(p) && !(o && o.method === 'PUT')) return json({ content: f.current }, 200);
                        return R(u, o); }; })(); true`);
            await ev(`window.__m.add('wp', 'A', 3, { sleeping: false, session_id: '${SID}', board_project: '${TEAM}' }); true`);
            await ev(framesJs(30)); // the first live list renders from several answers: a few frames, no single completion event
            await ev(`window.selectLiveSession('wp', 'claude', '${SID}', 'local'); true`);
            await waitFor(`!!document.getElementById('changed-files-title')`, `${tag}: the files panel`, 8000);
            await ev(`window.switchAgenticTab && window.switchAgenticTab('files', 'top'); window.toggleAgenticPanel && window.toggleAgenticPanel(true); true`);
            await waitFor(`document.getElementById('changed-files-title').getClientRects().length > 0`, `${tag}: the Files header on screen`, 8000);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'changed_files.js'); await m.loadChangedFiles('wp', '${SID}'); return true; })()`);
            await waitFor(`document.querySelectorAll('#changed-files-list .file-item').length === 1`, `${tag}: the changed file`, 8000);
            await ev(`document.querySelector('#changed-files-list .file-expand-btn[data-path="e.go"]').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"] .cm-line') && !!document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"] .diff-comments .ac-panel')`, `${tag}: the diff with its comments panel`, 12000);
            check(`${tag}: no comment button before anything is selected`, await ev(`(document.querySelector('.diff-comment-btn') || { hidden: true }).hidden`));

            // select the two changed lines in the new side of the diff
            await ev(`(() => { const lines = [...document.querySelectorAll('#changed-files-list .file-diff[data-filepath="e.go"] .cm-content > .cm-line')]; const a = lines.find(l => /CHANGED LINE ONE/.test(l.textContent)), b = lines.find(l => /CHANGED LINE TWO/.test(l.textContent)); const r = document.createRange(); r.setStart(a.firstChild, 0); const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); let tn = null; for (let n; (n = w.nextNode());) tn = n; r.setEnd(tn, tn.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"]').dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; })()`);
            await waitFor(`!document.querySelector('.diff-comment-btn').hidden`, `${tag}: the Comment button appears at the selection`, 4000);
            const btnGeo = await ev(`(() => { const b = document.querySelector('.diff-comment-btn').getBoundingClientRect(), s = document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"]').getBoundingClientRect(); return { inSlot: b.left >= s.left - 1 && b.right <= s.right + 1 && b.top >= s.top && b.height >= 28, w: b.width, h: b.height }; })()`);
            check(`${tag}: the button sits inside the diff and is touchable`, btnGeo.inSlot, JSON.stringify(btnGeo));
            await ev(`document.querySelector('.diff-comment-btn').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list .diff-comments .ac-input')`, `${tag}: the composer opens under the diff`, 4000);
            check(`${tag}: the composer quotes the selected lines`, /CHANGED LINE ONE/.test(await ev(`document.querySelector('#changed-files-list .diff-comments .ac-quote').textContent`)));
            await ev(`(() => { const ta = document.querySelector('#changed-files-list .diff-comments .ac-input'); ta.value = 'Why 4000 and not 40?'; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#changed-files-list .diff-comments .ac-send').click(); return true; })()`);
            await waitFor(`window.__posts.length === 1`, `${tag}: the comment is sent`, 6000);
            const post = await ev(`window.__posts[0]`);
            check(`${tag}: the comment is made on the file's diff key`, /^diff:team-x:wp-sess1:[0-9a-f]{16}$/.test(post.key), post.key);
            check(`${tag}: the anchor names the file, the side and the lines`, post.anchor.path === 'e.go' && post.anchor.side === 'new' && post.anchor.start_line === 41 && post.anchor.end_line === 42, JSON.stringify(post.anchor));
            check(`${tag}: the anchor carries the lines, some context and the state`, /CHANGED LINE ONE/.test(post.anchor.quote) && /CHANGED LINE TWO/.test(post.anchor.quote) && /f39/.test(post.anchor.prefix) && /f42/.test(post.anchor.suffix) && /^modified \+3 -3$/.test(post.anchor.base), JSON.stringify(post.anchor));
            check(`${tag}: the board is the agent's team`, post.board === 'team-x', String(post.board));
            await waitFor(`!!document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"] .diff-comments .ac-card')`, `${tag}: the thread stands under the diff`, 6000);
            const card = await ev(`(() => { const c = document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"] .diff-comments .ac-card'); return { text: c.textContent, lines: /lines 41-42/.test(c.textContent), outdated: /outdated/.test(c.textContent) }; })()`);
            check(`${tag}: the card shows the words, the lines, and is not outdated`, /Why 4000 and not 40\?/.test(card.text) && card.lines && !card.outdated, JSON.stringify(card));
            check(`${tag}: the page does not scroll sideways`, await ev(`document.documentElement.scrollWidth <= innerWidth`));

            // lines of the removed block are old-side lines, numbered in the file as it was
            await ev(`(() => { const d = [...document.querySelectorAll('#changed-files-list .file-diff[data-filepath="e.go"] .cm-deletedChunk')].find(x => /return 40 \\}/.test(x.textContent)); const w = document.createTreeWalker(d, NodeFilter.SHOW_TEXT); let first = null, last = null; for (let n; (n = w.nextNode());) { if (/f40/.test(n.nodeValue) && !first) first = n; last = n; } const r = document.createRange(); r.setStart(first, 0); r.setEnd(first, first.nodeValue.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"]').dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; })()`);
            await waitFor(`!document.querySelector('.diff-comment-btn').hidden`, `${tag}: the Comment button appears on removed lines too`, 4000);
            await ev(`document.querySelector('.diff-comment-btn').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list .diff-comments .ac-input')`, `${tag}: the composer opens for the removed lines`, 4000);
            await ev(`(() => { const ta = document.querySelector('#changed-files-list .diff-comments .ac-input'); ta.value = 'Was 40 right?'; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#changed-files-list .diff-comments .ac-send').click(); return true; })()`);
            await waitFor(`window.__posts.length === 2`, `${tag}: the second comment is sent`, 6000);
            const old = await ev(`window.__posts[1].anchor`);
            check(`${tag}: removed lines are old-side lines with the file's own numbers`, old.side === 'old' && old.start_line === 41 && old.end_line === 41 && /f40/.test(old.quote), JSON.stringify(old));

            // a removed line that repeats elsewhere is numbered where it was removed (#12560: the first match was line 6)
            await ev(`(() => { const d = [...document.querySelectorAll('#changed-files-list .file-diff[data-filepath="e.go"] .cm-deletedChunk')].find(x => /f44/.test(x.textContent)); d.scrollIntoView({ block: 'center' }); const w = document.createTreeWalker(d.querySelectorAll('.cm-deletedLine')[1], NodeFilter.SHOW_TEXT); const n = w.nextNode(); const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, n.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"]').dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; })()`);
            await waitFor(`!document.querySelector('.diff-comment-btn').hidden`, `${tag}: the Comment button appears on the removed brace`, 4000);
            await ev(`document.querySelector('.diff-comment-btn').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list .diff-comments .ac-input')`, `${tag}: the composer opens for the brace`, 4000);
            await ev(`(() => { const ta = document.querySelector('#changed-files-list .diff-comments .ac-input'); ta.value = 'Why drop this brace?'; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#changed-files-list .diff-comments .ac-send').click(); return true; })()`);
            await waitFor(`window.__posts.length === 3`, `${tag}: the third comment is sent`, 6000);
            const brace = await ev(`window.__posts[2].anchor`);
            check(`${tag}: a removed line that repeats is numbered where it was removed`, brace.side === 'old' && brace.start_line === 46 && brace.end_line === 46, JSON.stringify(brace));

            // selections that cannot be commented on: outside the diff, and across removed and kept lines
            await ev(`(() => { const r = document.createRange(); const t = document.querySelector('#changed-files-list .file-item[data-filepath="e.go"] .file-name'); r.selectNodeContents(t); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"]').dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; })()`);
            await ev(framesJs(8));
            check(`${tag}: a selection outside the diff offers no comment`, await ev(`document.querySelector('.diff-comment-btn').hidden`));
            await ev(`(() => { const slot = document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"]'), d = slot.querySelector('.cm-deletedChunk'), line = [...slot.querySelectorAll('.cm-content > .cm-line')].find(l => /CHANGED LINE ONE/.test(l.textContent)); const r = document.createRange(); r.setStart(d.querySelector('.cm-deletedLine').firstChild || d, 0); const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT); let tn = null; for (let n; (n = w.nextNode());) tn = n; r.setEnd(tn, tn.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); slot.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; })()`);
            await waitFor(`!document.querySelector('.diff-comment-btn').hidden`, `${tag}: a selection across removed and kept lines says so`, 4000);
            const across = await ev(`({ text: document.querySelector('.diff-comment-btn').textContent, off: document.querySelector('.diff-comment-btn').disabled })`);
            check(`${tag}: removed and kept lines in one selection are refused in words`, across.off && /one side/.test(across.text), JSON.stringify(across));
            await ev(`document.querySelector('.diff-comment-btn').click(); true`);
            check(`${tag}: pressing the refused button opens no composer`, await ev(`!document.querySelector('#changed-files-list .diff-comments .ac-input')`));

            // the lines leave the diff: the thread stays and says outdated
            await ev(`window.__files['e.go'].current = window.__files['e.go'].original.replace('func f20() int { return 20 }', 'func f20() int { return 2000 }'); window.__files['e.go'].additions = 1; window.__files['e.go'].deletions = 1; window.refreshChangedFiles(false).then(() => true)`);
            await waitFor(`!!document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"] .diff-comments .ac-card') && /outdated/.test(document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"] .diff-comments .ac-card').textContent)`, `${tag}: the comment says outdated once its lines are gone`, 10000).catch(() => {});
            check(`${tag}: a comment whose lines left the diff is kept and says outdated`, await ev(`/outdated/.test((document.querySelector('#changed-files-list .diff-comments .ac-card') || {}).textContent || '')`));
        }
    } finally { await client.close(); }
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    console.log('files_diff_comments_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
