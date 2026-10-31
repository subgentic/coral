// The Operator shares a file with an agent from its Artifacts tab (#11376): files dropped on the list, or chosen with the button (a phone has no drag), are uploaded as the Operator's (octet-stream with the name in
// a header, one request a file) and ONE message tells the agent; the list shows them. A drop target appears while a file is dragged in; an oversized, empty or refused file says why in words and sends nothing it
// should not; an agent with no team has neither the button nor a target. The board's routes are stood in for by a page-side stub that records every request. 1280 px dark and 390 px light (touch).
// Drives Chrome over CDP through the harness; run_cdp_suites.mjs finds it by name.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme, installAudit, auditRegion } = require('./helpers/contrast');

const TEAM = 'share-team-' + Date.now().toString(36);
const HEX = n => n.toString(16).padStart(2, '0').repeat(32);

const STUB = `(() => {
    const R = window.fetch; window.__up = []; window.__msg = []; window.__data = []; window.__refuse = null;
    const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
    window.fetch = async (u, o = {}) => {
        const url = new URL(String(u), location.origin), m = (o.method || 'GET').toUpperCase();
        if (m === 'POST' && url.pathname === '/api/board/${TEAM}/operator-artifacts') {
            const h = o.headers || {}, size = o.body && o.body.size;
            window.__up.push({ session: url.searchParams.get('session_id'), type: h['Content-Type'], name: h['X-Artifact-Name'], size });
            if (window.__refuse) return json({ error: 'x', code: window.__refuse.code }, window.__refuse.status);
            const id = String(window.__up.length).padStart(2, '0').repeat(32);
            window.__data.unshift({ id, name: decodeURIComponent(escape(h['X-Artifact-Name'])), media_type: 'text/plain', size, created_at: new Date().toISOString(), uri: 'coral://artifacts/' + id, available: true, inline: false, reference_count: 1, source: 'upload', produced_by: 'Operator' });
            return json({ uri: 'coral://artifacts/' + id, id, name: h['X-Artifact-Name'], size }, 201);
        }
        if (m === 'POST' && url.pathname === '/api/board/${TEAM}/operator-artifacts/message') { const b = JSON.parse(o.body); window.__msg.push(b); return json({ delivered: true, files: b.digests.length, to: 'Share Agent' }); }
        if (m === 'GET' && url.pathname === '/api/board/${TEAM}/artifacts') return json({ project: '${TEAM}', artifacts: window.__data.slice(), has_more: false, truncated: false, session_id: url.searchParams.get('session_id') });
        if (url.pathname === '/api/session-artifacts') return json({ session_id: url.searchParams.get('session_id'), artifacts: [], has_more: false, truncated: false });
        return R(u, o);
    };
    return true;
})()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await require('./helpers/wait').settle(ev, 400, 300); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const root = '#agentic-panel-artifacts-view .goals-page';
    const open = async view => {
        await Emulation.setDeviceMetricsOverride({ width: view.w, height: view.h, deviceScaleFactor: 1, mobile: view.phone });
        await Emulation.setTouchEmulationEnabled({ enabled: view.phone });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await require('./helpers/wait').coralReady(ev); await ev(`localStorage.clear(); true`);
        await installAudit(ev); await setTheme(ev, view.theme);
        await ev(STUB);
    };
    const showAgent = async session => {
        await ev(`(async () => { const S = (window.__coralStatic || '/static/'); const { state } = await import(S + 'state.js'); const files = await import(S + 'changed_files.js'); const { showView } = await import(S + 'utils.js');
            state.currentSession = Object.assign({ type: 'live', name: 'share-agent', display_name: 'Share Agent', session_id: 'sa-1' }, ${JSON.stringify(session)}); showView('live-session-view');
            const side = document.getElementById('agentic-state'); side.classList.remove('collapsed'); side.style.width = ''; files.initFileSearch(); files.syncFilesViewerSession(); return true; })()`);
        await ev(`(() => { const side = document.getElementById('agentic-state'); if (window.innerWidth <= 767 && side.getBoundingClientRect().width === 0) (document.getElementById('popout-panel-toggle-btn') || document.getElementById('panel-toggle-btn')).click(); return true; })()`);
        await ev(`localStorage.removeItem('coral-agentic-tab-top'); window.switchAgenticTab('artifacts', 'top'); true`);
    };
    // a File of `size` bytes named `name`, dropped on the list (drag events with a real DataTransfer) or chosen with the button (the input's files and a change event)
    const dropOn = files => ev(`(() => { const dt = new DataTransfer(); for (const [n, size, text] of ${JSON.stringify(files)}) dt.items.add(new File([text !== undefined ? text : new ArrayBuffer(size)], n)); const r = document.querySelector('${root}');
        for (const t of ['dragenter', 'dragover', 'drop']) r.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt })); return true; })()`);
    const chooseWith = files => ev(`(() => { const dt = new DataTransfer(); for (const [n, size, text] of ${JSON.stringify(files)}) dt.items.add(new File([text !== undefined ? text : new ArrayBuffer(size)], n)); const i = document.querySelector('${root} .share-drop input[type=file]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const statusText = () => ev(`document.querySelector('${root} .share-drop-status').textContent`);
    const waitStatus = (re, what) => waitFor(`${re}.test(document.querySelector('${root} .share-drop-status')?.textContent || '')`, what, 10000);
    const reset = () => ev(`window.__up = []; window.__msg = []; window.__refuse = null; true`);

    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const view of [{ w: 1280, h: 900, phone: false, theme: 'dark' }, { w: 390, h: 844, phone: true, theme: 'light' }]) {
            const at = `${view.w}px ${view.theme}: `;
            await open(view);
            await showAgent({ board_project: TEAM });
            await waitFor(`!!document.querySelector('${root} .share-drop-pick')`, at + 'the Upload button', 10000);
            const ui = await ev(`(() => { const b = document.querySelector('${root} .share-drop-pick'), r = b.getBoundingClientRect(); return { name: b.getAttribute('aria-label'), text: b.textContent, h: Math.round(r.height), hint: document.querySelector('${root} .share-drop-hint').textContent }; })()`);
            check(at + 'a button named for the agent, and a line that says who can read the file and who is told', ui.name === 'Upload a file for Share Agent' && ui.text === 'Upload a file' && /Every agent on this team can read them; only Share Agent is told/.test(ui.hint), JSON.stringify(ui));
            if (view.phone) check(at + 'the button is a 44 px target on a phone', ui.h >= 44, String(ui.h));
            // the drop target while a file is dragged over, and gone after it leaves
            await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.txt')); document.querySelector('${root}').dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt })); return true; })()`);
            const over = await ev(`(() => { const r = document.querySelector('${root}'), t = r.querySelector('.share-drop-target'); return { on: r.classList.contains('share-drop-on'), shown: t.getClientRects().length > 0, text: t.textContent }; })()`);
            check(at + 'a drop target says where the file goes while it is dragged in', over.on && over.shown && over.text === 'Drop to share with Share Agent', JSON.stringify(over));
            if (!view.phone) await shot('operator-share-target-1280');
            await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.txt')); document.querySelector('${root}').dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: dt })); return true; })()`);
            check(at + 'and it is gone when the file leaves', await ev(`!document.querySelector('${root}').classList.contains('share-drop-on')`));
            // a small file: one upload, one message, and the list shows it
            await reset();
            if (view.phone) await chooseWith([['notes.md', 0, '# notes for the agent']]); else await dropOn([['notes.md', 0, '# notes for the agent']]);
            await waitStatus(/^Shared a file with Share Agent\./, at + 'the file shared');
            const sent = await ev(`({ up: window.__up, msg: window.__msg })`);
            check(at + 'exactly one upload as octet-stream with the name, and exactly one message', sent.up.length === 1 && sent.up[0].type === 'application/octet-stream' && sent.up[0].name === 'notes.md' && sent.up[0].size === 21 && sent.up[0].session === 'sa-1' && sent.msg.length === 1 && sent.msg[0].session_id === 'sa-1' && sent.msg[0].digests.length === 1, JSON.stringify(sent));
            await waitFor(`[...document.querySelectorAll('${root} tbody tr')].some(r => /notes\\.md/.test(r.textContent))`, at + 'the file in the list', 10000);
            check(at + 'the file is in the agent\'s list', true);
            await shot(`operator-share-done-${view.w}`);
            // several files: one upload each, ONE message; a name with letters beyond Latin-1 arrives intact
            await reset();
            await dropOn([['one.txt', 0, 'one'], ['two.txt', 0, 'two'], ['ünï-名前.txt', 0, 'three']]);
            await waitStatus(/^Shared 3 files with Share Agent\./, at + 'three files shared');
            const many = await ev(`({ up: window.__up.map(u => decodeURIComponent(escape(u.name))), msg: window.__msg })`);
            check(at + 'three files are three uploads and ONE message; a non-Latin name arrives as written', many.up.length === 3 && many.up[2] === 'ünï-名前.txt' && many.msg.length === 1 && many.msg[0].digests.length === 3, JSON.stringify(many));
            // oversized: refused with a reason, nothing sent, nobody told
            await reset();
            await dropOn([['big.bin', 64 * 1024 * 1024 + 1]]);
            await waitStatus(/Not shared, big\.bin: it is over 64 MiB/, at + 'the oversized file refused');
            const big = await ev(`({ up: window.__up.length, msg: window.__msg.length })`);
            check(at + 'an oversized file is refused with its reason and nothing is sent', big.up === 0 && big.msg === 0, JSON.stringify(big));
            check(at + 'and the refusal is shown as a problem (4.5:1)', (await auditRegion(ev, [`${root} .share-drop`])).fails.length === 0);
            // an empty file; a refusal from the server in words
            await reset(); await dropOn([['empty.txt', 0, '']]);
            await waitStatus(/Not shared, empty\.txt: it is empty/, at + 'the empty file');
            await ev(`window.__refuse = { status: 413, code: 'artifact_quota' }; true`);
            await dropOn([['full.txt', 0, 'data']]);
            await waitStatus(/Not shared, full\.txt: the artifact store is full/, at + 'the store-full refusal in words');
            await ev(`window.__refuse = { status: 409, code: 'board_paused' }; true`);
            await dropOn([['paused.txt', 0, 'data']]);
            await waitStatus(/Not shared, paused\.txt: the team is paused/, at + 'the paused refusal in words');
            check(at + 'a refused upload tells nobody', await ev(`window.__msg.length === 0`));
            // an agent with no team has neither the button nor a target
            await showAgent({ board_project: '' });
            await ev(`window.switchAgenticTab('files', 'top'); window.switchAgenticTab('artifacts', 'top'); true`);
            await waitFor(`!!document.querySelector('#agentic-panel-artifacts-view .goals-page')`, at + 'the standalone list', 10000);
            check(at + 'an agent with no team has no Upload button', await ev(`!document.querySelector('${root} .share-drop-pick')`));
        }
    } catch (e) { console.log('ERROR ' + (e.stack || e)); results.push(false); }
    await client.close();
    if (results.every(Boolean)) console.log('operator_share_browser: all ok'); else { console.log('FAILED'); process.exit(1); }
})();
