// A worker started in its own worktree (#21468, concept mocks v3 idea 3): its header says "Own worktree · task-N" (any other worker shows none); the person's Archive dialog has the tick box "Also remove its worktree"
// (on, with "The folder task-N is deleted. The branch is kept."), only for such a worker; Archive with the box on asks the server to remove the worktree and says what became of it, off asks for nothing more; and a kept
// worktree is one row in Activity with the reason. On the harness's stand-in agents and the Activity list's own record shape; the server side (clean, dirty, outside the folder, the branch kept) is in Go's tests.
// With CORAL_SCREENSHOT_DIR set it saves one picture of each, 1440 and 390, light and dark.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    // The whole window, and with a selector also the element alone (what the side-by-side sheet sets next to the mock's).
    const shot = async (name, sel) => {
        const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true });
        const save = (n, data) => fs.writeFileSync(`${dir}/${n}.png`, Buffer.from(data, 'base64'));
        save(name, (await Page.captureScreenshot({ format: 'png' })).data);
        if (!sel) return;
        const r = await ev(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.getClientRects().length); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
        if (r) save(name + '-crop', (await Page.captureScreenshot({ format: 'png', clip: { ...r, scale: 1 } })).data);
    };
    const KEPT = '3 files are not committed. Nothing was removed.';
    const setup = async (width, theme) => {
        await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`localStorage.clear(); localStorage.setItem('coral-live-view-mode', 'chat'); true`);
        await ev(`(() => { const m = window.__m;
            m.add('w-402', 'W', 20, { sleeping: false, display_name: '#402: Remove the old billing flag' }); m.add('w-plain', 'P', 20, { sleeping: false, display_name: 'Plain worker' });
            window.__qaState.liveSessions.find(s => s.session_id === 'w-402-id').own_worktree = 'task-402';
            window.__qaCalls = []; const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u); if (/\\/archive$/.test(url) && /w-402-id/.test(url)) { window.__qaCalls.push(o.body || ''); const wt = window.__qaWt; return Promise.resolve(new Response(JSON.stringify({ ok: true, archived: true, sleeping: true, ...(wt ? { worktree: wt } : {}) }), { status: 200, headers: { 'Content-Type': 'application/json' } })); } return real(u, o); };
            document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});
            T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
    };
    const visibleChips = () => ev(`[...document.querySelectorAll('.own-worktree-chip')].filter(c => c.getClientRects().length).map(c => c.textContent)`);
    const dialog = () => ev(`(() => { const d = document.getElementById('confirm-modal'); if (!d || getComputedStyle(d).display === 'none') return null; const c = document.getElementById('confirm-modal-choice'); return { title: document.getElementById('confirm-modal-title').textContent, message: document.getElementById('confirm-modal-message').textContent, tick: c ? c.querySelector('input').checked : null, tickWords: c ? c.innerText.replace(/\\s+/g, ' ').trim() : null, buttons: [...d.querySelectorAll('.modal-actions button')].map(b => b.textContent.trim()) }; })()`);
    const pressArchive = () => ev(`[...document.querySelectorAll('#confirm-modal .modal-actions button')].find(b => /^Archive$/.test(b.textContent.trim())).click(); true`);
    const failures = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, theme] of [[1440, 'dark'], [1440, 'light'], [390, 'dark'], [390, 'light']]) {
            const at = `${width} ${theme}`;
            await setup(width, theme);
            // 1. the header chip: for the worker that has its own worktree, not for the other
            await select('w-402');
            await waitFor(`[...document.querySelectorAll('.own-worktree-chip')].some(c => c.getClientRects().length)`, `${at}: the chip`, 8000);
            assert.deepEqual([...new Set(await visibleChips())], ['Own worktree · task-402'], `${at}: the header says where it works`);
            assert.equal(await ev(`getComputedStyle([...document.querySelectorAll('.own-worktree-chip')].find(c => c.getClientRects().length)).fontSize`), '12px', `${at}: the chip's text is the mock's 12px`);
            await ev(framesJs(3)); await shot(`header-${width}-${theme}`, '.terminal-header');
            await select('w-plain');
            await waitFor(`![...document.querySelectorAll('.own-worktree-chip')].some(c => c.getClientRects().length)`, `${at}: no chip on a worker without the flag`, 8000);
            // 2. the Archive dialog: the mock's words and a ticked box, for the worker that has a worktree of its own
            await ev(`window.__qaWt = { state: 'kept', name: 'task-402', reason: ${JSON.stringify(KEPT)} }; window.toggleAgentArchive('w-402', 'claude', 'w-402-id', 'archive'); true`);
            await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, `${at}: the question`, 5000);
            const dlg = await dialog();
            assert.equal(dlg.title, 'Archive "#402: Remove the old billing flag"?', `${at}: the title`);
            assert.equal(dlg.message, 'It leaves the sidebar. You can start it again from Archived.');
            assert.equal(dlg.tick, true, `${at}: the box is on, as the mock draws it`);
            assert.equal(dlg.tickWords, 'Also remove its worktree The folder task-402 is deleted, with any files git ignores (such as .env or build output). The branch is kept.');
            assert.deepEqual(dlg.buttons, ['Cancel', 'Archive']);
            // the mock's own sizes for the tick box (measured in the mock at 1440 and 390: title 13px, help 12px at 17.4px, 3px under the title)
            const sizes = await ev(`(() => { const q = e => { const s = getComputedStyle(e); return { fs: s.fontSize, lh: s.lineHeight, mt: s.marginTop }; }; const c = document.getElementById('confirm-modal-choice'); return { title: q(c.querySelector('b')), help: q(c.querySelector('div > div')), code: q(c.querySelector('code')) }; })()`);
            assert.deepEqual(sizes, { title: { fs: '13px', lh: '18.85px', mt: '0px' }, help: { fs: '12px', lh: '17.4px', mt: '3px' }, code: { fs: '12px', lh: sizes.code.lh, mt: '0px' } }, `${at}: the tick box's sizes are the mock's`);
            await ev(framesJs(3)); await shot(`dialog-${width}-${theme}`, '#confirm-modal .modal-content');
            // Archive with the box on: the server is asked to remove it, and what became of it is told
            await pressArchive();
            await waitFor(`window.__qaCalls.length >= 1`, `${at}: the archive call`, 5000);
            assert.equal(JSON.parse(await ev(`window.__qaCalls[0]`)).remove_worktree, true, `${at}: asked to remove the worktree`);
            await waitFor(`[...document.querySelectorAll('.toast, [role=status], #toast')].some(t => /worktree was kept: 3 files are not committed/.test(t.textContent))`, `${at}: the kept worktree is told`, 5000);
        }
        // 3. the box off asks for nothing more; the other worker gets the plain question with no box
        await setup(1440, 'dark');
        await ev(`window.__qaWt = null; window.toggleAgentArchive('w-402', 'claude', 'w-402-id', 'archive'); true`);
        await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the question', 5000);
        await ev(`document.querySelector('#confirm-modal-choice input').click(); true`);
        await pressArchive();
        await waitFor(`T.state.liveSessions.find(s => s.session_id === 'w-402-id').archived === true`, 'archived', 5000);
        assert.deepEqual(await ev(`window.__qaCalls.filter(b => /remove_worktree/.test(b))`), [], 'box off: no call asks for the worktree to be removed');
        await ev(`window.toggleAgentArchive('w-plain', 'claude', 'w-plain-id', 'archive'); true`);
        await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the plain question', 5000);
        const plain = await dialog();
        assert.equal(plain.title, 'Archive agent'); assert.equal(plain.tick, null, 'a worker with no worktree of its own has no box');
        await ev(`[...document.querySelectorAll('#confirm-modal .modal-actions button')].find(b => /^Cancel$/.test(b.textContent.trim())).click(); true`);
        // 4. a kept worktree is one row in Activity, with the reason, and the row can open the worker
        for (const [width, theme] of [[1440, 'dark'], [1440, 'light'], [390, 'dark'], [390, 'light']]) {
            const at = `${width} ${theme}`;
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            const at4 = new Date(Date.now() - 4 * 60000).toISOString();
            await ev(`(() => { window.T.state.settings = { ...window.T.state.settings, inbox_welcome: 'off' }; document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); const real = window.fetch;
                const json = o => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o) => { const path = new URL(String(u), location.href).pathname; if (path === '/api/activity') return json({ actions: [{ id: 1, team: 'shop', at: ${JSON.stringify(at4)}, actor: 'agent:Orchestrator', source: 'local', action: 'worktree_kept', item_kind: 'agent', item_id: 'worker-398', asker: 'Orchestrator', title: '#398 was archived, but its worktree was kept', note: ${JSON.stringify(KEPT)} }], check: { intact: true, rows: 1 } }); return real(u, o); };
                window.switchNavTab('hub-inbox'); })()`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.openInboxGroup('activity'))`);
            await waitFor(`/worktree was kept/.test(document.getElementById('group-table-view').textContent)`, `${at}: the Activity row`, 10000);
            const text = await ev(`document.getElementById('group-table-view').textContent.replace(/\\s+/g, ' ')`);
            assert.ok(text.includes('#398 was archived, but its worktree was kept') && text.includes(KEPT), `${at}: the row says which worker and why: ${text.slice(0, 300)}`);
            assert.equal(await ev(`[...document.querySelectorAll('#group-table-view button')].some(b => b.textContent.trim() === 'Open worker')`), true, `${at}: the row's button says Open worker (it opens the worker's page, not a folder)`);
            assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), true, `${at}: no sideways scroll`);
            await ev(framesJs(3)); await shot(`activity-${width}-${theme}`, '#group-table-view .al-row');
        }
        console.log('PASS worktree_flags_browser: the header chip, the Archive dialog with its box, the kept-worktree answer and its Activity row');
    } catch (e) { failures.push(e); } finally { await client.close(); }
    if (failures.length) { console.error(failures[0]); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
