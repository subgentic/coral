// Comments on an agent's diff (#12536, the Operator: "let me comment in the files diff view too, similar to how we handle the artifacts review"): select lines in a file's inline diff, press Comment, write it, and the thread
// stands under that diff; the comment is made on the key diff:<team>:<session>:<16 hex of the path> with the file, the side, the lines, the quoted lines and the state it was made on; the agent's reply comes into the
// thread in place; a comment whose lines left the diff says "outdated" and stays. Lines selected in a removed block are old-side lines. 1280 and 390 px. The panel's reads and the comments routes are answered in the
// page. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

const ORIG = Array.from({ length: 60 }, (_, i) => `func f${i}() int { return ${i} }`);
// lines that repeat (#12560): a run of three } with distinct lines around it (old lines 46, 47, 48), and one more } at line 6 that a search for the line would find first. The diff removes the last of the three (old line 48).
ORIG[4] = '    return 4'; ORIG[5] = '}'; ORIG[44] = '    return nil'; ORIG[45] = '}'; ORIG[46] = '}'; ORIG[47] = '}';
const CUR = ORIG.slice();
CUR[40] = 'func f40() int { return 4000 } // CHANGED LINE ONE';
CUR[41] = 'func f41() int { return 4100 } // CHANGED LINE TWO';
CUR[10] = 'func f10() int { return 1000 }';
CUR.splice(47, 1); // the last } of the run is removed
const FILES = { 'e.go': { status: 'modified', original: ORIG.join('\n'), current: CUR.join('\n'), additions: 3, deletions: 3 } };
// A file found by searching the diff.view's own chunks against a nearest-line search of the old file (the 'repeat' case, #12560): the removed } at old line 10 is the only removed row of its block; a search for the line finds
// line 2 first, and a search that guesses where it must be (the line it is drawn before, moved by the hunks above) says 7.
const M_ORIG = ['', '}', '', 'a()', 'end', '}', '}', 'a()', '}', '}'], M_CUR = ['}', '}', 'a()', 'b()', '}', '}', 'a()', '}'];
const TEAM = 'team-x', SID = 'wp-sess1';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    // Make a selection and wait for the button that answers it. The editor may draw again after a scroll and drop a selection made in the same moment, as a person's would be, so the selection is made again (up to five times) after the page has settled.
    const pick = async (tag, js, what) => {
        for (let i = 0; i < 5; i++) {
            await ev(js); await ev(framesJs(8));
            if (await ev(`!document.querySelector('.diff-comment-btn').hidden`)) return true;
        }
        problems.push(`${tag}: ${what}`); return false;
    };
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
                        if (/\\/api\\/sessions\\/live\\/(wp|nt)\\/files(\\/refresh)?$/.test(p)) return json({ files: Object.entries(window.__files).map(([filepath, f]) => ({ filepath, status: f.status, additions: f.additions, deletions: f.deletions })), is_git: true, compare: { label: 'HEAD' } }, 200);
                        const m = /^\\/api\\/artifacts\\/(diff:[^/]+)\\/comments$/.exec(p);
                        if (m && (!o.method || o.method === 'GET')) return json({ comments: window.__comments, locked: false, you: { kind: 'owner', name: 'You', can_comment: true, can_lock: true }, limits: {} }, 200);
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

            // #13528 (the Operator: the Comments panel under every file is too much): the thread is not drawn until it is asked for; one small comment icon sits in the file's row, with a name, a tip and a 24 px box
            const FILE = `#changed-files-list .file-diff[data-filepath="e.go"]`, ROW = `#changed-files-list .file-item[data-filepath="e.go"]`;
            const quiet = await ev(`(() => { const ic = document.querySelector('${ROW} .file-comment-btn'), box = document.querySelector('${FILE} .diff-comments'), r = ic && ic.getBoundingClientRect(), shown = e => !!e && e.getClientRects().length > 0;
                return { icon: !!ic, label: ic && ic.getAttribute('aria-label'), title: ic && ic.title, expanded: ic && ic.getAttribute('aria-expanded'), controls: ic && ic.getAttribute('aria-controls') === (box && box.id), w: r && Math.round(r.width), h: r && Math.round(r.height), inRow: !!ic && !!ic.closest('.file-item'), boxShown: shown(box), seen: ['.ac-title', '.ac-lock', '.ac-lock-note', '.ac-whole', '.empty-state'].filter(c => shown(box && box.querySelector(c))), countHidden: ic && ic.querySelector('.file-comment-count').hidden }; })()`);
            check(`${tag}: one comment icon in the file's row, named for the file, with a tip`, quiet.icon && quiet.inRow && quiet.label === 'Comment on e.go' && quiet.title === 'Comment on e.go' && quiet.controls, JSON.stringify(quiet));
            check(`${tag}: the icon is a 24 px box at least and says it is closed`, quiet.w >= 24 && quiet.h >= 24 && quiet.expanded === 'false', JSON.stringify(quiet));
            check(`${tag}: nothing of the panel shows at rest (no heading, no Lock, no lock note, no empty text, no whole-file button) and there is no count`, !quiet.boxShown && quiet.seen.length === 0 && quiet.countHidden, JSON.stringify(quiet));
            await ev(`document.querySelector('${ROW} .file-comment-btn').click(); true`);
            await waitFor(`document.querySelector('${FILE} .diff-comments').getClientRects().length > 0 && !!document.querySelector('${FILE} .diff-comments .ac-input')`, `${tag}: pressing the icon opens the composer for the file`, 5000);
            const asked = await ev(`(() => { const box = document.querySelector('${FILE} .diff-comments'), has = c => !!box.querySelector(c), ic = document.querySelector('${ROW} .file-comment-btn'); return { expanded: ic.getAttribute('aria-expanded'), focused: document.activeElement && document.activeElement.classList.contains('ac-input'), lock: has('.ac-lock'), lockNote: has('.ac-lock-note'), whole: has('.ac-whole'), empty: has('.empty-state') }; })()`);
            check(`${tag}: the composer is open and focused, the icon says expanded`, asked.expanded === 'true' && asked.focused, JSON.stringify(asked));
            check(`${tag}: Lock is reachable inside the opened thread, without its explanation, the empty text or the whole-file button`, asked.lock && !asked.lockNote && !asked.whole && !asked.empty, JSON.stringify(asked));
            await ev(`document.querySelector('${FILE} .diff-comments .ac-cancel').click(); true`);
            await waitFor(`document.querySelector('${FILE} .diff-comments').getClientRects().length === 0`, `${tag}: cancelling a comment on a file with none leaves nothing open`, 4000);
            check(`${tag}: and the icon says closed again`, await ev(`document.querySelector('${ROW} .file-comment-btn').getAttribute('aria-expanded')`) === 'false');

            // select the two changed lines in the new side of the diff
            await pick(tag, `(() => { const lines = [...document.querySelectorAll('#changed-files-list .file-diff[data-filepath="e.go"] .cm-content > .cm-line')]; const a = lines.find(l => /CHANGED LINE ONE/.test(l.textContent)), b = lines.find(l => /CHANGED LINE TWO/.test(l.textContent)); const r = document.createRange(); r.setStart(a.firstChild, 0); const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); let tn = null; for (let n; (n = w.nextNode());) tn = n; r.setEnd(tn, tn.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"]').dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; })()`, `the Comment button appears at the selection`);
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
            const counted = await ev(`(() => { const ic = document.querySelector('#changed-files-list .file-item[data-filepath="e.go"] .file-comment-btn'), n = ic.querySelector('.file-comment-count'); return { count: n.textContent, shown: !n.hidden && n.getClientRects().length > 0, label: ic.getAttribute('aria-label') }; })()`);
            check(`${tag}: the icon carries the count of comments and says it in its name`, counted.shown && counted.count === '1' && /e\.go, 1 comment$/.test(counted.label), JSON.stringify(counted));
            check(`${tag}: the thread's quote keeps the lines' breaks and indentation`, await ev(`(() => { const q = document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"] .diff-comments .ac-card .ac-quote'); return /^pre/.test(getComputedStyle(q).whiteSpace) && q.textContent.includes('\\n'); })()`));
            const card = await ev(`(() => { const c = document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"] .diff-comments .ac-card'); return { text: c.textContent, lines: /lines 41-42/.test(c.textContent), outdated: /outdated/.test(c.textContent) }; })()`);
            check(`${tag}: the card shows the words, the lines, and is not outdated`, /Why 4000 and not 40\?/.test(card.text) && card.lines && !card.outdated, JSON.stringify(card));
            check(`${tag}: the page does not scroll sideways`, await ev(`document.documentElement.scrollWidth <= innerWidth`));

            // lines of the removed block are old-side lines, numbered in the file as it was
            await pick(tag, `(() => { const d = [...document.querySelectorAll('#changed-files-list .file-diff[data-filepath="e.go"] .cm-deletedChunk')].find(x => /return 40 \\}/.test(x.textContent)); const w = document.createTreeWalker(d, NodeFilter.SHOW_TEXT); let first = null, last = null; for (let n; (n = w.nextNode());) { if (/f40/.test(n.nodeValue) && !first) first = n; last = n; } const r = document.createRange(); r.setStart(first, 0); r.setEnd(first, first.nodeValue.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"]').dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; })()`, `the Comment button appears on removed lines too`);
            await ev(`document.querySelector('.diff-comment-btn').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list .diff-comments .ac-input')`, `${tag}: the composer opens for the removed lines`, 4000);
            await ev(`(() => { const ta = document.querySelector('#changed-files-list .diff-comments .ac-input'); ta.value = 'Was 40 right?'; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#changed-files-list .diff-comments .ac-send').click(); return true; })()`);
            await waitFor(`window.__posts.length === 2`, `${tag}: the second comment is sent`, 6000);
            const old = await ev(`window.__posts[1].anchor`);
            check(`${tag}: removed lines are old-side lines with the file's own numbers`, old.side === 'old' && old.start_line === 41 && old.end_line === 41 && /f40/.test(old.quote), JSON.stringify(old));

            // a removed line that repeats is numbered where the diff removed it (#12560: a search found line 6 first)
            await pick(tag, `(() => { const d = [...document.querySelectorAll('#changed-files-list .file-diff[data-filepath="e.go"] .cm-deletedChunk')].find(x => [...x.querySelectorAll('.cm-deletedLine')].some(r => r.textContent.trim() === '}')); d.scrollIntoView({ block: 'center' }); const rows = [...d.querySelectorAll('.cm-deletedLine')]; const w = document.createTreeWalker(rows[rows.length - 1], NodeFilter.SHOW_TEXT); const n = w.nextNode(); const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, n.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"]').dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; })()`, `the Comment button appears on the removed brace`);
            await ev(`document.querySelector('.diff-comment-btn').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list .diff-comments .ac-input')`, `${tag}: the composer opens for the brace`, 4000);
            await ev(`(() => { const ta = document.querySelector('#changed-files-list .diff-comments .ac-input'); ta.value = 'Why drop this brace?'; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#changed-files-list .diff-comments .ac-send').click(); return true; })()`);
            await waitFor(`window.__posts.length === 3`, `${tag}: the third comment is sent`, 6000);
            const brace = await ev(`window.__posts[2].anchor`);
            check(`${tag}: the removed brace is a line of the run (46 to 48) the diff removed it from, not the first } of the file (6)`, brace.side === 'old' && brace.start_line >= 46 && brace.start_line <= 48 && brace.start_line === brace.end_line, JSON.stringify(brace));

            // a file whose repeated lines fool a search: the diff's own old line is named
            await ev(`window.__files['m.go'] = { status: 'modified', original: ${JSON.stringify(M_ORIG.join('\n'))}, current: ${JSON.stringify(M_CUR.join('\n'))}, additions: 2, deletions: 7 }; window.refreshChangedFiles(false).then(() => true)`);
            await waitFor(`document.querySelectorAll('#changed-files-list .file-item').length === 2`, `${tag}: the second changed file`, 8000);
            await ev(`document.querySelector('#changed-files-list .file-expand-btn[data-path="m.go"]').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list .file-diff[data-filepath="m.go"] .cm-deletedChunk') && !!document.querySelector('#changed-files-list .file-diff[data-filepath="m.go"] .diff-comments .ac-panel')`, `${tag}: m.go's diff with its comments`, 10000);
            let picked = false;
            for (let i = 0; i < 5 && !picked; i++) {
                await ev(`(() => { const slot = document.querySelector('#changed-files-list .file-diff[data-filepath="m.go"]'), d = [...slot.querySelectorAll('.cm-deletedChunk')].find(x => { const r = [...x.querySelectorAll('.cm-deletedLine')]; return r.length === 1 && r[0].textContent.trim() === '}'; }); d.scrollIntoView({ block: 'center' }); const row = d.querySelector('.cm-deletedLine'), w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), n = w.nextNode(), r = document.createRange(); r.setStart(n, 0); r.setEnd(n, n.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); slot.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; })()`);
                await ev(framesJs(8));
                picked = await ev(`!document.querySelector('#changed-files-list .file-diff[data-filepath="m.go"] .diff-comment-btn').hidden`);
            }
            check(`${tag}: the Comment button appears on the removed row of m.go`, picked);
            await ev(`document.querySelector('#changed-files-list .file-diff[data-filepath="m.go"] .diff-comment-btn').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list .file-diff[data-filepath="m.go"] .diff-comments .ac-input')`, `${tag}: the composer opens on m.go`, 4000);
            await ev(`(() => { const ta = document.querySelector('#changed-files-list .file-diff[data-filepath="m.go"] .diff-comments .ac-input'); ta.value = 'Which brace went?'; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#changed-files-list .file-diff[data-filepath="m.go"] .diff-comments .ac-send').click(); return true; })()`);
            await waitFor(`window.__posts.length === 4`, `${tag}: the fourth comment is sent`, 6000);
            const rep = await ev(`window.__posts[3].anchor`);
            check(`${tag}: a removed } among repeats is the view's own old line 10, not the first } (2) nor the guess (7)`, rep.path === 'm.go' && rep.side === 'old' && rep.start_line === 10 && rep.end_line === 10, JSON.stringify(rep));

            // a later row of a block of several removed rows is numbered by its row (#12560, QA): the first removed block of m.go holds old lines 1 to 5
            let rowPicked = false;
            for (let i = 0; i < 5 && !rowPicked; i++) {
                await ev(`(() => { const slot = document.querySelector('#changed-files-list .file-diff[data-filepath="m.go"]'), d = [...slot.querySelectorAll('.cm-deletedChunk')].find(x => x.querySelectorAll('.cm-deletedLine').length > 3); d.scrollIntoView({ block: 'center' }); const row = [...d.querySelectorAll('.cm-deletedLine')].find(r => r.textContent.trim() === 'end'), w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), n = w.nextNode(), r = document.createRange(); r.setStart(n, 0); r.setEnd(n, n.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); slot.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; })()`);
                await ev(framesJs(8));
                rowPicked = await ev(`!document.querySelector('#changed-files-list .file-diff[data-filepath="m.go"] .diff-comment-btn').hidden`);
            }
            check(`${tag}: the Comment button appears on a later row of a removed block`, rowPicked);
            await ev(`document.querySelector('#changed-files-list .file-diff[data-filepath="m.go"] .diff-comment-btn').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list .file-diff[data-filepath="m.go"] .diff-comments .ac-input')`, `${tag}: the composer opens on the later row`, 4000);
            await ev(`(() => { const ta = document.querySelector('#changed-files-list .file-diff[data-filepath="m.go"] .diff-comments .ac-input'); ta.value = 'And this one?'; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#changed-files-list .file-diff[data-filepath="m.go"] .diff-comments .ac-send').click(); return true; })()`);
            await waitFor(`window.__posts.length === 5`, `${tag}: the fifth comment is sent`, 6000);
            const later = await ev(`window.__posts[4].anchor`);
            check(`${tag}: the fifth row of the first removed block is old line 5`, later.side === 'old' && later.start_line === 5 && later.end_line === 5 && later.quote === 'end', JSON.stringify(later));

            // chunks the view will not give up: no button, never a line made up (#12560, QA)
            await ev(`window.__fieldWas = window.CoralCM.EditorState.prototype.field; window.CoralCM.EditorState.prototype.field = function () { throw new Error('no chunks'); }; true`);
            await ev(`(() => { const slot = document.querySelector('#changed-files-list .file-diff[data-filepath="m.go"]'), d = [...slot.querySelectorAll('.cm-deletedChunk')].find(x => x.querySelectorAll('.cm-deletedLine').length === 1), row = d.querySelector('.cm-deletedLine'), w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), n = w.nextNode(), r = document.createRange(); r.setStart(n, 0); r.setEnd(n, n.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); slot.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; })()`);
            await ev(framesJs(10));
            check(`${tag}: removed lines whose chunks cannot be read offer no comment`, await ev(`document.querySelector('#changed-files-list .file-diff[data-filepath="m.go"] .diff-comment-btn').hidden`));
            await ev(`window.CoralCM.EditorState.prototype.field = window.__fieldWas; getSelection().removeAllRanges(); true`);

            // selections that cannot be commented on: outside the diff, and across removed and kept lines
            await ev(`(() => { const r = document.createRange(); const t = document.querySelector('#changed-files-list .file-item[data-filepath="e.go"] .file-name'); r.selectNodeContents(t); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"]').dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; })()`);
            await ev(framesJs(8));
            check(`${tag}: a selection outside the diff offers no comment`, await ev(`document.querySelector('.diff-comment-btn').hidden`));
            await pick(tag, `(() => { const slot = document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"]'), d = slot.querySelector('.cm-deletedChunk'), line = [...slot.querySelectorAll('.cm-content > .cm-line')].find(l => /CHANGED LINE ONE/.test(l.textContent)); const r = document.createRange(); r.setStart(d.querySelector('.cm-deletedLine').firstChild || d, 0); const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT); let tn = null; for (let n; (n = w.nextNode());) tn = n; r.setEnd(tn, tn.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); slot.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; })()`, `a selection across removed and kept lines says so`);
            const across = await ev(`({ text: document.querySelector('.diff-comment-btn').textContent, off: document.querySelector('.diff-comment-btn').disabled })`);
            check(`${tag}: removed and kept lines in one selection are refused in words`, across.off && /one side/.test(across.text), JSON.stringify(across));
            await ev(`document.querySelector('.diff-comment-btn').click(); true`);
            check(`${tag}: pressing the refused button opens no composer`, await ev(`!document.querySelector('#changed-files-list .diff-comments .ac-input')`));

            // the lines leave the diff: the thread stays and says outdated
            await ev(`delete window.__files['m.go']; window.__files['e.go'].current = window.__files['e.go'].original.replace('func f20() int { return 20 }', 'func f20() int { return 2000 }'); window.__files['e.go'].additions = 1; window.__files['e.go'].deletions = 1; window.refreshChangedFiles(false).then(() => true)`);
            await waitFor(`!!document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"] .diff-comments .ac-card') && /outdated/.test(document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"] .diff-comments .ac-card').textContent)`, `${tag}: the comment says outdated once its lines are gone`, 10000).catch(() => {});
            check(`${tag}: a comment whose lines left the diff is kept and says outdated`, await ev(`/outdated/.test((document.querySelector('#changed-files-list .diff-comments .ac-card') || {}).textContent || '')`));
            // #12847: a team's subject digest may finish after Collapse all. Hold that await,
            // close the freshly opened editor, then let the real digest finish.
            await ev(`(() => { const original = crypto.subtle.digest; window.__digestWas = original; window.__heldDigests = []; crypto.subtle.digest = function(algorithm, bytes) { if (new TextDecoder().decode(bytes) !== 'e.go') return original.call(this, algorithm, bytes); return new Promise(resolve => window.__heldDigests.push(() => original.call(crypto.subtle, algorithm, bytes).then(resolve))); }; document.querySelector('#changed-files-list .files-expand-all').click(); return true; })()`);
            await waitFor(`document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"]').hidden`, `${tag}: close before the held digest`, 6000);
            await ev(`document.querySelector('#changed-files-list .files-expand-all').click(); true`);
            await waitFor(`window.__heldDigests.length > 0`, `${tag}: comments wait for the subject digest`, 8000);
            await ev(`document.querySelector('#changed-files-list .files-expand-all').click(); true`);
            await waitFor(`document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"]').hidden`, `${tag}: collapse while the digest waits`, 6000);
            await ev(`crypto.subtle.digest = window.__digestWas; Promise.all(window.__heldDigests.splice(0).map(release => release())).then(() => true)`);
            await ev(framesJs(3));
            check(`${tag}: a late subject digest cannot repopulate a collapsed diff`, await ev(`(() => { const slot = document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"]'); return slot.hidden && slot.children.length === 0; })()`));
            await ev(`document.querySelector('#changed-files-list .files-expand-all').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"] .diff-comments .ac-panel')`, `${tag}: comments work again after reopening`, 10000);

            // an agent on no team has no board to send a comment to: one line says so, and there is no Comment button (#12570)
            await ev(`window.__m.add('nt', 'A', 3, { sleeping: false, session_id: 'nt-sess1' }); true`);
            await ev(framesJs(10));
            await ev(`window.selectLiveSession('nt', 'claude', 'nt-sess1', 'local'); true`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'changed_files.js'); await m.loadChangedFiles('nt', 'nt-sess1'); return true; })()`);
            await waitFor(`document.querySelectorAll('#changed-files-list .file-item').length >= 1`, `${tag}: the files of the agent with no team`, 8000);
            // e.go is still open from before: the new list draws its diff by itself
            await waitFor(`!!document.querySelector('#changed-files-list .file-diff .diff-comments-note')`, `${tag}: a line says why there are no comments`, 10000);
            check(`${tag}: no team, no comments, and the line says so`, await ev(`(() => { const n = document.querySelector('#changed-files-list .file-diff .diff-comments-note'); return /need a team/.test(n.textContent) && !document.querySelector('#changed-files-list .diff-comments') && !document.querySelector('#changed-files-list .diff-comment-btn'); })()`));
        }
    } finally { await client.close(); }
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    console.log('files_diff_comments_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
