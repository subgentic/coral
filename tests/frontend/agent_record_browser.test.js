// Record as agent (#391): since the notice-target check, Coral types board notices only into the program it recorded as an agent's CLI,
// so an agent that was running before an update has its notices paused (its row's skipped_send says "notices paused ...") until it is
// recorded, woken or restarted. The agent view says so even with nothing unread; behind Options are Record as agent (reads the one
// candidate the server offers, asks with its program and pid, records it with the start it was given; a program that changed meanwhile
// records nothing) and Record for all agents (the server records every agent whose program is its resolved CLI and lists the rest, with
// why). Backend Dev's routes are answered by the test. At 1280 and 390 px, through agent_view_harness.js against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`window.__m.add('rec-agent', 'A', 3, { sleeping: false, display_name: 'Backend Dev' }); true`);
            await waitFor(`window._coralGetLiveSessions().some(r => r.session_id === 'rec-agent-id')`, `${tag}: the agent's row`, 8000);
            await ev(`window.selectLiveSession('rec-agent', 'claude', 'rec-agent-id', 'local'); true`);
            await coralReady(ev, 'agentSelected', 'rec-agent-id');
            const feed = extra => ev(`(() => { const rows = window._coralGetLiveSessions().map(r => r.session_id === 'rec-agent-id' ? { ...r, board_unread: 0, skipped_send: null, ...${JSON.stringify(extra)} } : r); window._coralSetLiveSessions(rows);
                return import(${S} + 'waiting.js').then(m => { m.syncWaitingNotice(rows.find(r => r.session_id === 'rec-agent-id')); return true; }); })()`);
            const vis = id => `(() => { const b = document.getElementById(${JSON.stringify(id)}); return !!b && !b.hidden; })()`;

            await feed({ skipped_send: { why: 'the screen could not be read', what: 'board message' } });
            check(`${tag}: another skipped send with nothing unread says nothing, and offers no Record`, (await ev(`document.getElementById('composer-waiting-text').textContent`)) === '' && !(await ev(vis('composer-waiting-record'))));
            await feed({ skipped_send: { why: 'notices paused: the foreground program is not the recorded agent', what: 'board message' } });
            const line = await ev(`document.getElementById('composer-waiting-text').textContent`);
            check(`${tag}: paused notices are said on the agent view even with nothing unread`, line === 'Board notices are paused for this agent', line);
            await ev(`document.getElementById('composer-waiting-list').hidden = false; document.getElementById('composer-waiting-detail').hidden = false; true`);
            check(`${tag}: behind Options, Record as agent and Record for all agents`, (await ev(vis('composer-waiting-record'))) && (await ev(vis('composer-waiting-record-all'))));

            // the routes, answered here: one candidate, then a record that succeeds; later a 409 and a bulk answer
            await ev(`window.__calls = []; window.__answer = { record: 200 }; window.__realFetch = window.__realFetch || window.fetch; window.fetch = (u, o) => { const s = String(u), json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
                if (s.includes('/agent-candidate')) { window.__calls.push({ u: s }); return json({ ok: true, paused: true, reason: 'not the recorded agent', candidate: window.__noCandidate ? null : { pid: 4242, start: 'opaque-start-1', program: 'node', under: window.__under || '', folder: '', unidentified: false, ...(window.__cand || {}) }, why_not: window.__noCandidate ? 'several foreground programs' : '' }); }
                if (s.includes('/record-agent') && !s.includes('/record-agents')) { window.__calls.push({ u: s, body: o && o.body }); return window.__answer.record === 409 ? json({ ok: false, code: 'changed', error: 'the foreground program is no longer that process' }, 409) : json({ ok: true, pid: 4242, program: 'node' }); }
                if (s.includes('/record-agents')) { window.__calls.push({ u: s, method: o && o.method }); return json({ ok: true, dry_run: /dry_run=1/.test(s), recorded: [{ session: 'claude-a', pid: 1, program: 'claude' }], left: [{ session: 'codex-b', reason: 'ambiguous: the program is node, which runs a script; record it with the button' }] }); }
                return window.__realFetch(u, o); }; true`);
            const toastSeen = re => waitFor(`[...document.querySelectorAll('.toast, [role=status], [role=alert]')].some(t => ${re}.test(t.textContent))`, `${tag}: the toast ${re}`, 5000);

            await ev(`document.getElementById('composer-waiting-record').click(); true`);
            await waitFor(`!!document.getElementById('confirm-modal') && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none' && /Record node/.test(document.getElementById('confirm-modal-message').textContent)`, `${tag}: the confirm`, 5000);
            const ask = await ev(`({ title: document.getElementById('confirm-modal-title').textContent, msg: document.getElementById('confirm-modal-message').textContent, yes: document.getElementById('confirm-modal-yes').textContent, calls: window.__calls.map(c => c.u) })`);
            check(`${tag}: it asks with the program, the pid and the agent's name, in Backend Dev's words, after reading this session's candidate`, ask.msg === "Record node (pid 4242) as Backend Dev's agent? Coral will then type board notices into it." && ask.yes === 'Record' && /\/api\/sessions\/live\/rec-agent-id\/agent-candidate$/.test(ask.calls[0]), JSON.stringify(ask));
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`window.__calls.some(c => /record-agent$/.test(c.u))`, `${tag}: the record request`, 5000);
            const rec = await ev(`window.__calls.find(c => /record-agent$/.test(c.u))`);
            check(`${tag}: it records exactly what it was offered: the pid and the start, unchanged, and no acknowledge_nested for a direct child`, JSON.stringify(JSON.parse(rec.body)) === JSON.stringify({ pid: 4242, start: 'opaque-start-1' }) && /\/api\/sessions\/live\/rec-agent-id\/record-agent$/.test(rec.u), JSON.stringify(rec));
            await toastSeen(/Recorded node as the agent/);
            check(`${tag}: and says so`, true);

            await ev(`window.__calls = []; window.__answer.record = 409; document.getElementById('composer-waiting-record').click(); true`);
            await waitFor(`/Record node/.test(document.getElementById('confirm-modal-message').textContent) && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, `${tag}: the confirm again`, 5000);
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await toastSeen(/changed: nothing was recorded/);
            check(`${tag}: a program that changed meanwhile (409) records nothing and says to read it again`, true);

            await ev(`window.__calls = []; window.__noCandidate = true; document.getElementById('composer-waiting-record').click(); true`);
            await toastSeen(/Nothing to record: several foreground programs/);
            check(`${tag}: with no single candidate it asks nothing and says why`, !(await ev(`window.__calls.some(c => /record-agent$/.test(c.u))`)));
            await ev(`window.__noCandidate = false; true`);

            // Security's rule: a program inside a nested shell is said plainly, and recorded only with a separate box ticked
            await ev(`window.__calls = []; window.__answer.record = 200; window.__under = 'bash'; document.getElementById('composer-waiting-record').click(); true`);
            await waitFor(`/running inside bash/.test(document.getElementById('confirm-modal-message').textContent) && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, `${tag}: the nested confirm`, 5000);
            const nested = await ev(`(() => { const box = document.querySelector('#confirm-modal-ack input'); return { msg: document.getElementById('confirm-modal-message').textContent, ack: (document.getElementById('confirm-modal-ack') || {}).textContent || '', ticked: box ? box.checked : null, disabled: document.getElementById('confirm-modal-yes').disabled }; })()`);
            check(`${tag}: inside a nested shell: the confirm says where it runs, the box is there and unticked, and Record waits for it`, /This program is running inside bash, a shell started in the terminal, not directly in the agent's terminal\./.test(nested.msg) && /I know this is the agent, not something I started by hand/.test(nested.ack) && nested.ticked === false && nested.disabled === true, JSON.stringify(nested));
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            check(`${tag}: Record with the box unticked sends nothing`, !(await ev(`window.__calls.some(c => /record-agent$/.test(c.u))`)));
            await ev(`(() => { const box = document.querySelector('#confirm-modal-ack input'); box.click(); return true; })()`);
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`window.__calls.some(c => /record-agent$/.test(c.u))`, `${tag}: the nested record`, 5000);
            const nrec = await ev(`window.__calls.find(c => /record-agent$/.test(c.u))`);
            check(`${tag}: ticked, it records with acknowledge_nested`, JSON.stringify(JSON.parse(nrec.body)) === JSON.stringify({ pid: 4242, start: 'opaque-start-1', acknowledge_nested: true }), JSON.stringify(nrec));
            await ev(`window.__under = ''; true`);
            const plainAgain = await ev(`(() => { window.showConfirmModal('t', 'm', () => {}, undefined, { label: 'X', danger: false }); const r = { box: !!document.getElementById('confirm-modal-ack'), disabled: document.getElementById('confirm-modal-yes').disabled }; window.hideConfirmModal(); return r; })()`);
            check(`${tag}: the next question asks with no box and its button enabled`, !plainAgain.box && !plainAgain.disabled, JSON.stringify(plainAgain));

            // Security's #4835: the name is the image's and the folder is shown next to it, both cleaned of bidi and control characters and capped
            await ev(`(() => { const rlo = String.fromCharCode(0x202e), nl = String.fromCharCode(10); window.__cand = { program: 'pe' + rlo + 'rl', folder: '/tmp/' + nl + 'd'.repeat(200) + '/node_modules/bin' }; return true; })()`);
            await ev(`window.__calls = []; document.getElementById('composer-waiting-record').click(); true`);
            await waitFor(`/Record perl/.test(document.getElementById('confirm-modal-message').textContent) && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, `${tag}: the confirm with a folder`, 5000);
            const where = await ev(`({ msg: document.getElementById('confirm-modal-message').textContent, box: !!document.getElementById('confirm-modal-ack') })`);
            const folderShown = (where.msg.match(/, from (.*?), as /) || [])[1] || '';
            check(`${tag}: the confirm names the image and its folder, cleaned (no bidi or line break) and the folder capped at 120 keeping its tail behind a leading ellipsis; no box for a direct child`,
                where.msg.startsWith('Record perl (pid 4242), from …d') && folderShown.length === 120 && folderShown.startsWith('…') && folderShown.endsWith('/node_modules/bin') && !/[\u0000-\u001f\u202a-\u202e]/.test(where.msg) && !where.box, JSON.stringify({ ...where, folderLen: folderShown.length }));
            await ev(`window.hideConfirmModal(); true`);

            // the cut counts characters, so a name of 70 emoji is cut to 63 and the ellipsis, never inside a surrogate pair
            await ev(`window.__cand = { program: String.fromCodePoint(0x1F600).repeat(70), folder: '' }; window.__calls = []; document.getElementById('composer-waiting-record').click(); true`);
            await waitFor(`/^Record ./.test(document.getElementById('confirm-modal-message').textContent) && /pid 4242/.test(document.getElementById('confirm-modal-message').textContent) && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, `${tag}: the confirm with a long name`, 5000);
            const cut = await ev(`(() => { const m = document.getElementById('confirm-modal-message').textContent; const name = m.slice('Record '.length, m.indexOf(' (pid')); const smile = String.fromCodePoint(0x1F600);
                return { chars: [...name].length, last: name.endsWith('…'), allSmiles: [...name.slice(0, -1)].every(c => c === smile), lone: /(?:[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF]))|(?:(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF])/.test(name) }; })()`);
            check(`${tag}: a long name is cut on characters: 63 whole emoji and the ellipsis, no lone surrogate`, cut.chars === 64 && cut.last && cut.allSmiles && !cut.lone, JSON.stringify(cut));
            await ev(`window.hideConfirmModal(); true`);

            // an image Coral can't read: said so, and recorded only with the box ticked, as acknowledge_nested
            await ev(`window.__cand = { program: 'an unknown program (pid 4242)', folder: '', unidentified: true }; window.__calls = []; document.getElementById('composer-waiting-record').click(); true`);
            await waitFor(`/unknown program/.test(document.getElementById('confirm-modal-message').textContent) && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, `${tag}: the unidentified confirm`, 5000);
            const unk = await ev(`(() => { const box = document.querySelector('#confirm-modal-ack input'); return { msg: document.getElementById('confirm-modal-message').textContent, ticked: box ? box.checked : null, disabled: document.getElementById('confirm-modal-yes').disabled }; })()`);
            check(`${tag}: an unidentified program: the confirm says Coral could not read it, the box is there and unticked, and Record waits for it`,
                unk.msg === "Record an unknown program (pid 4242) as Backend Dev's agent? Coral will then type board notices into it. Coral could not read which file this program runs." && unk.ticked === false && unk.disabled === true, JSON.stringify(unk));
            await ev(`document.querySelector('#confirm-modal-ack input').click(); document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`window.__calls.some(c => /record-agent$/.test(c.u))`, `${tag}: the unidentified record`, 5000);
            const urec = await ev(`window.__calls.find(c => /record-agent$/.test(c.u))`);
            check(`${tag}: ticked, it records with acknowledge_nested`, JSON.stringify(JSON.parse(urec.body)) === JSON.stringify({ pid: 4242, start: 'opaque-start-1', acknowledge_nested: true }), JSON.stringify(urec));
            await ev(`window.__cand = null; true`);

            // Record for all agents (#11415): the operator is shown each agent's program and pid first; nothing is recorded until Record all is pressed
            await ev(`window.__calls = []; document.getElementById('composer-waiting-record-all').click(); true`);
            await waitFor(`/Coral will type messages into these programs/.test(document.getElementById('confirm-modal-message').textContent) && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, `${tag}: the bulk confirm`, 5000);
            const bulkAsk = await ev(`({ msg: document.getElementById('confirm-modal-message').textContent, title: document.getElementById('confirm-modal-title').textContent, calls: window.__calls.map(c => c.u) })`);
            check(`${tag}: Record for all agents first reads a preview (dry_run) and records nothing`, bulkAsk.calls.length === 1 && /record-agents\?dry_run=1$/.test(bulkAsk.calls[0]), JSON.stringify(bulkAsk.calls));
            check(`${tag}: the confirm names each agent with its program and pid, says to check, and lists the ones it leaves`, bulkAsk.title === 'Record for all agents' && bulkAsk.msg.includes('claude-a: claude (pid 1)') && /Check that each is the agent you expect/.test(bulkAsk.msg) && /Not recorded here: codex-b/.test(bulkAsk.msg), bulkAsk.msg);
            await ev(`window.hideConfirmModal(); true`);
            check(`${tag}: cancelling records nothing`, (await ev(`window.__calls.filter(c => /record-agents$/.test(c.u)).length`)) === 0);
            await ev(`document.getElementById('composer-waiting-record-all').click(); true`);
            await waitFor(`/Coral will type messages/.test(document.getElementById('confirm-modal-message').textContent) && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, `${tag}: the bulk confirm again`, 5000);
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await toastSeen(/Recorded 1 agent\. Left paused: codex-b \(ambiguous/);
            const bulk = await ev(`window.__calls.find(c => /record-agents$/.test(c.u))`);
            check(`${tag}: confirmed, Record for all agents posts once and says what was recorded and what was left, with why`, !!bulk && bulk.method === 'POST', JSON.stringify(bulk));
            const help = await ev(`(() => { const h = document.getElementById('composer-waiting-record-help'); return { shown: !!h && !h.hidden, text: h ? h.textContent : '' }; })()`);
            check(`${tag}: one help line in Options says what recording does and what to check`, help.shown && /only into the agent process it recorded \(its PID and start time\)/.test(help.text) && /first check that the program running in this terminal is the agent you expect/.test(help.text), JSON.stringify(help));
            await ev(`window.fetch = window.__realFetch; true`);
        }
    } finally { await client.close(); }
    const failed = results.filter(r => !r).length;
    console.log(`${results.length - failed}/${results.length} checks passed`);
    if (failed) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
