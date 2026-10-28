// Desktop pass 25 (#10288, #10291): (1) Resume's folder is where the session ran, says so, and warns when it is changed or gone; (2) a resumed agent opens when it is listed; (3) All chats says
// "Reading your past sessions..." while the first index pass is going, not "No chats here", and shows the chat once it is read; (4) Session Info on Coral's own terminal says how to attach, not an empty
// Attach Command. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { FOLDER_ROWS } = require('./helpers/folder_rows');

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const quiet = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the checks that nothing else happens
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);

        // ── (3) All chats while the first index pass is going ──
        const ROW = { session_id: 'past-1', source_type: 'claude', agent_name: '', display_name: '', summary: 'An old chat', last_timestamp: '2026-10-20T10:00:00Z', duration_sec: 60, message_count: 3, starred: false, archived: false, active: false };
        await ev(`(() => { const R = window.fetch; window.__hist = 0; window.__indexing = true;
            window.fetch = (u, o) => { const url = new URL(String(u), location.href), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (url.pathname === '/api/sessions/history/counts') return json({ all: window.__indexing ? 0 : 1, group: 0, notes: 0, starred: 0, active: 0, archived: 0, by_agent_type: {}, tags: [] });
                if (url.pathname === '/api/sessions/history') { window.__hist++; return json(window.__indexing ? { sessions: [], total: 0, page: 1, page_size: 0, indexing: true } : { sessions: [${JSON.stringify(ROW)}], total: 1, page: 1, page_size: 50 }); }
                return R(u, o); }; return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`document.querySelectorAll('.view-list-item').length > 3`, 'the folders', 10000);
        await ev(`document.querySelector('.view-list-item[data-key="chats"]').click(); true`);
        await waitFor(`/Reading your past sessions/.test(document.body.innerText)`, 'the reading line', 6000);
        assert.doesNotMatch(await ev(`document.body.innerText`), /No chats here/, 'not "No chats here" while the history is being read');
        await ev(`window.__indexing = false; true`); // the first pass finishes: the list is read again by itself
        await waitFor(`document.querySelectorAll('button.dt-primary, button.dt-person').length >= 1`, 'the chat once it is read', 12000);
        assert.doesNotMatch(await ev(`document.body.innerText`), /Reading your past sessions/, 'the line goes with the reading');

        // ── (4) Session Info on Coral's own terminal ──
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'lazy_panels.js'); await m.loadModals(); return true; })()`); // the dialogs load on first use
        await ev(`(() => { const R = window.fetch; window.fetch = (u, o) => { const url = new URL(String(u), location.href);
            if (/\\/api\\/sessions\\/live\\/info-a\\/info$/.test(url.pathname)) return Promise.resolve(new Response(JSON.stringify({ agent_name: 'info-a', agent_type: 'claude', tmux_session_name: '', tmux_command: window.__tmuxCmd || '', working_directory: '/x', log_path: '' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            return R(u, o); }; return true; })()`);
        await ev(`(async () => { const st = await import((window.__coralStatic || '/static/') + 'state.js'); st.state.currentSession = { type: 'live', name: 'info-a', session_id: 'info-a-id', agent_type: 'claude' }; return true; })()`);
        const info = async cmd => { await ev(`window.__tmuxCmd = ${JSON.stringify(cmd)}; (async () => { const m = await import((window.__coralStatic || '/static/') + 'info_dialog.js'); await m.showInfoModal(); })(); true`); await quiet(500); return ev(`(() => ({ note: !document.getElementById('info-attach-note').hidden, text: document.getElementById('info-attach-note').textContent, code: !document.getElementById('info-tmux-command').hidden, copy: !document.getElementById('info-copy-btn').hidden, link: !!document.querySelector('#info-attach-note [data-on-click=m-open-terminal-settings]') }))()`); };
        let i = await info('');
        assert.deepEqual([i.note, i.code, i.copy, i.link], [true, false, false, true], 'on Coral\'s own terminal the row says why there is nothing to attach to, with the Settings link: ' + JSON.stringify(i));
        assert.match(i.text, /nothing to attach to/);
        i = await info('tmux attach -t claude-abc');
        assert.deepEqual([i.note, i.code, i.copy], [false, true, true], 'on tmux the command and Copy are shown');

        // ── (1) Resume: the folder the session ran in ──
        await ev(`(() => { const R = window.fetch; window.fetch = (u, o) => { const url = new URL(String(u), location.href);
            const m = url.pathname.match(/\\/api\\/sessions\\/history\\/([^/]+)\\/resume-info$/);
            if (m) { const info = { 'ran-here': { working_dir: '/work/project', working_dir_from: 'session', working_dir_exists: true, agent_type: 'claude', permission_mode: 'plan' }, 'ran-default': { working_dir: '/work/project', working_dir_from: 'session', working_dir_exists: true, agent_type: 'claude', permission_mode: 'default' }, 'ran-gone': { working_dir: '/work/removed', working_dir_from: 'session', working_dir_exists: false, agent_type: 'claude' }, 'ran-nowhere': { agent_type: 'claude' } }[m[1]] || {};
                return Promise.resolve(new Response(JSON.stringify(info), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
            return R(u, o); }; return true; })()`);
        const resume = async id => { await ev(`(async () => { const st = await import((window.__coralStatic || '/static/') + 'state.js'); st.state.currentSession = { type: 'history', name: '${id}', agent_type: 'claude' }; st.state.historySessionsList = [{ session_id: '${id}', source_type: 'claude' }]; const m = await import((window.__coralStatic || '/static/') + 'resume_dialog.js'); await m.showResumeModal(); })(); true`); await quiet(400); return ev(`(() => ({ dir: document.getElementById('resume-dir').value, note: document.getElementById('resume-dir-note').hidden ? '' : document.getElementById('resume-dir-note').textContent, warn: document.getElementById('resume-dir-note').classList.contains('is-warning') }))()`); };
        let r = await resume('ran-here');
        assert.deepEqual([r.dir, r.note, r.warn], ['/work/project', 'This is where the session ran.', false], 'the folder is where it ran, and says so: ' + JSON.stringify(r));
        await ev(`(() => { const i = document.getElementById('resume-dir'); i.value = '/somewhere/else'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        r = await ev(`(() => ({ note: document.getElementById('resume-dir-note').textContent, warn: document.getElementById('resume-dir-note').classList.contains('is-warning') }))()`);
        assert.match(r.note, /ran in \/work\/project\. Resuming somewhere else may not find the files/, 'changed: the warning: ' + r.note);
        assert.equal(r.warn, true);
        r = await resume('ran-gone');
        assert.match(r.note, /ran in \/work\/removed, which is not there any more/, 'a folder that is gone says so: ' + r.note);
        r = await resume('ran-nowhere');
        assert.equal(r.note, '', 'a chat with no known folder says nothing about one');

        // ── (2) a resumed agent opens when it is listed ──
        await ev(`window.__selected = []; window.selectLiveSession = (name, type, sid, server) => { window.__selected.push([name, type, sid, server]); return Promise.resolve(); }; window.showChatView = () => { window.__chatShown = true; }; true`);
        await ev(`(() => { const R = window.fetch; window.__liveReads = 0; window.fetch = (u, o) => { const url = new URL(String(u), location.href);
            if (url.pathname === '/api/sessions/live') return Promise.resolve(new Response(JSON.stringify(window.__resumedListed ? [{ session_id: 'resumed-id', name: 'resumed', agent_type: 'claude', server: 'local', working_directory: '/work/project', status: 'idle' }] : []), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            if (url.pathname === '/api/sessions/launch') { window.__launchBody = JSON.parse(o.body); } if (url.pathname === '/api/sessions/launch') return Promise.resolve(new Response(JSON.stringify({ session_id: 'resumed-id', name: 'resumed' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            return R(u, o); }; return true; })()`);
        await resume('ran-here');
        assert.equal(await ev(`document.getElementById('resume-mode-note').textContent`), 'Resumes in Plan mode, the mode this chat ran in.', 'the dialog says the mode it resumes in');
        await ev(`(async () => { const st = await import((window.__coralStatic || '/static/') + 'state.js'); window.__resumedListed = false; await window.resumeLaunchNew(); setTimeout(() => { window.__resumedListed = true; }, 1500); })(); true`);
        await waitFor(`window.__selected.length === 1`, 'the resumed agent opened', 12000);
        assert.deepEqual(await ev(`window.__selected[0]`), ['resumed', 'claude', 'resumed-id', 'local']);
        assert.equal(await ev(`!!window.__chatShown`), true, 'in its chat');
        assert.deepEqual(await ev(`[window.__launchBody.flags, window.__launchBody.permission_mode, window.__launchBody.resume_session_id]`), [['--permission-mode', 'plan'], null, 'ran-here'], 'a Plan chat is resumed with Plan\'s own flags, never the saved default: ' + JSON.stringify(await ev('window.__launchBody')));
        await resume('ran-default');
        assert.equal(await ev(`document.getElementById('resume-mode-note').textContent`), 'Resumes in Default mode, the mode this chat ran in.');
        await ev(`window.__launchBody = null; window.resumeLaunchNew(); true`); await waitFor(`!!window.__launchBody`, 'the launch', 4000);
        assert.deepEqual(await ev(`[window.__launchBody.permission_mode, window.__launchBody.flags || null]`), ['default', null], 'a Default chat is resumed in Default, named explicitly');
        await resume('ran-nowhere');
        assert.match(await ev(`document.getElementById('resume-mode-note').textContent`), /mode was not recorded: it resumes in your saved default/, 'none recorded says so');
        await ev(`window.__launchBody = null; window.resumeLaunchNew(); true`); await waitFor(`!!window.__launchBody`, 'the launch', 4000);
        assert.deepEqual(await ev(`[window.__launchBody.permission_mode || null, window.__launchBody.flags || null]`), [null, null], 'nothing is sent: the saved default applies');
        console.log('PASS resume and index: the folder it ran in, opens when listed, Reading your past sessions, how to attach');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
