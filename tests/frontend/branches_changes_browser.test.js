// #17202: Branches opens its own scoped diff; a line comment targets that branch's agent,
// even while another agent is selected. Desktop and phone use the same controls.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 850, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`(() => {
                window.__posts = []; window.__fileReads = []; window.__diffMode = 'uncommitted'; window.__modePuts = [];
                const real = window.fetch, json = (x, status = 200) => Promise.resolve(new Response(JSON.stringify(x), { status, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o = {}) => {
                    const url = new URL(String(u), location.href), p = decodeURIComponent(url.pathname);
                    if (p === '/api/board/review-team/branches') return json({ available: true, repos: [{ base: 'main', worktrees: [{ branch: 'feature', changed: 1, untracked: 0, agents: [{ name: 'worker', display_name: 'Builder', session_id: 'branch-session-1', agent_type: 'claude' }] }] }] });
                    if (p === '/api/settings/git-diff-mode' && o.method === 'PUT') { window.__diffMode = JSON.parse(o.body).mode; window.__modePuts.push(window.__diffMode); return json({ mode: window.__diffMode }); }
                    if (p === '/api/sessions/live/worker/files') { window.__fileReads.push(url.searchParams.get('session_id')); return json({ diff_mode: window.__diffMode, files: [{ filepath: 'a.js', status: 'modified', additions: 1, deletions: 1 }], is_git: true, compare: { label: 'Since my last commit' } }); }
                    if (p === '/api/sessions/live/worker/file-original') return json({ content: 'const before = true;\\nconst value = 1;\\n' });
                    if (p === '/api/sessions/live/worker/file-content') return json({ content: 'const before = true;\\nconst value = 2;\\n' });
                    const m = /^\\/api\\/artifacts\\/(diff:[^/]+)\\/comments$/.exec(p);
                    if (m && o.method === 'POST') { const body = JSON.parse(o.body); window.__posts.push({ subject: m[1], ...body }); return json({ id: 1, body: body.body, anchor: body.anchor, mine: true, author: { name: 'You', kind: 'owner' }, created_at: new Date().toISOString(), can: {}, sent_to: 'Builder' }, 201); }
                    if (m) return json({ comments: [], locked: false, you: { kind: 'owner', name: 'You', can_comment: true, can_lock: true }, limits: {} });
                    return real(u, o);
                };
                const host = document.createElement('div'); host.id = 'branch-test-host'; document.body.append(host);
                return true;
            })()`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'branches_tab.js'); const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); state.currentSession = { type: 'live', name: 'other', session_id: 'other-session', board_project: 'other-team' }; await m.showTeamBranches(document.getElementById('branch-test-host'), 'review-team'); return true; })()`);
            assert.equal(await ev(`!!document.querySelector('#branch-test-host .branches-changes')`), true, 'Branches offers a button to open the changed files');
            await ev(`document.querySelector('.branches-changes').click(); true`);
            await waitFor(`!!document.querySelector('.branches-changes-dialog .branch-file-open')`, 'Branch changes list');
            await ev(`(() => { const select = document.querySelector('.branch-compare'); select.value = 'last_commit'; select.dispatchEvent(new Event('change')); return true; })()`);
            await waitFor(`window.__fileReads.length === 2 && !document.querySelector('.branch-compare').disabled`, 'Comparison changed');
            assert.deepEqual(await ev('window.__modePuts'), ['last_commit']);
            await ev(`document.querySelector('.branch-file-open').click(); true`);
            await waitFor(`!!document.querySelector('.branches-changes-dialog .file-diff .cm-line') && !!document.querySelector('.branches-changes-dialog .diff-line-comment')`, 'Diff and discoverable line comment');
            assert.deepEqual(await ev('window.__fileReads'), ['branch-session-1', 'branch-session-1']);
            await ev(`(() => { const line = [...document.querySelectorAll('.branches-changes-dialog .cm-line')].find(e => e.textContent.includes('const value = 2;')); const range = document.createRange(); range.selectNodeContents(line); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); document.querySelector('.branches-changes-dialog .diff-line-comment').click(); return true; })()`);
            await waitFor(`!!document.querySelector('.branches-changes-dialog .ac-input')`, 'Line composer');
            await ev(`(() => { const input = document.querySelector('.branches-changes-dialog .ac-input'); input.value = 'Please explain this change'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.branches-changes-dialog .ac-send').click(); return true; })()`);
            await waitFor('window.__posts.length === 1', 'Comment sent');
            const post = await ev('window.__posts[0]');
            assert.match(post.subject, /^diff:review-team:branch-session-1:/);
            assert.equal(post.anchor.path, 'a.js'); assert.equal(post.anchor.side, 'new');
            assert.equal(post.anchor.start_line, 2); assert.equal(post.anchor.end_line, 2);
            assert.equal(post.anchor.quote, 'const value = 2;');
            await ev(`document.querySelector('.branches-changes-dialog .branch-close').click(); true`);
            await waitFor(`!document.querySelector('.branches-changes-dialog')`, 'Close destroys the dialog');
            console.log('PASS Branches diff and line-comment delivery at ' + width);
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
