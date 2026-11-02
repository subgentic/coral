// #3343: in the board chat, each run of consecutive "Coral Task Queue" lines is one muted,
// collapsible row, so what people and agents wrote isn't buried. The messages themselves are
// unchanged (the @mention notifications they carry are server-side and untouched); select mode
// shows every line so each can still be selected.
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');

const BASE = require('./test_base').BASE;

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Emulation } = client;
    const ev = async expression => {
        const result = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const S = `(window.__coralStatic||'/static/')`;
    try {
        await Promise.all([Page.enable(), Runtime.enable()]);
        await Emulation.setDeviceMetricsOverride({ width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired();
        await coralReady();

        console.log('The grouping');
        const g = await ev(`(async () => {
            const m = await import(${S}+'board_system_lines.js');
            const Q = 'Coral Task Queue';
            const msgs = [
                { id: 1, subscriber_id: 'QA', job_title: 'QA', content: 'hello' },
                { id: 2, subscriber_id: Q, is_system: true, content: '@notify-all [New Task #7 (low)] Fix it — run claim' },
                { id: 3, subscriber_id: Q, is_system: true, content: '[Task #7 claimed by Backend Dev] Fix it' },
                { id: 4, subscriber_id: Q, is_system: true, content: '[Task #7 completed by Backend Dev] Outcome: success' },
                { id: 5, subscriber_id: 'Lead', job_title: 'Lead', content: 'done?' },
                { id: 6, subscriber_id: Q, is_system: true, content: '@Backend Dev [Task #8 (high)] <b>x</b> — assigned to you' },
            ];
            const items = m.groupTaskQueueRuns(msgs);
            const box = document.createElement('div');
            box.innerHTML = items.map(it => it.kind === 'queue' ? m.renderTaskQueueRun(it, () => 'T') : '<div class="plain">' + it.m.content + '</div>').join('');
            document.body.appendChild(box);
            const runs = [...box.querySelectorAll('.mb-queue-run')];
            const out = {
                kinds: items.map(it => it.kind + (it.msgs ? ':' + it.msgs.length : '')),
                labels: runs.map(r => r.querySelector('.mb-queue-label').textContent),
                lines: runs[0].querySelectorAll('.mb-queue-line').length,
                ids: [...runs[0].querySelectorAll('.mb-queue-line')].map(l => l.dataset.messageId),
                openAtFirst: runs[0].open,
                escaped: !runs[1].querySelector('b'),
                noCollapse: m.groupTaskQueueRuns(msgs, false).every(it => it.kind === 'msg'),
            };
            // A run is open by default (#11585). A closed one stays closed across a re-render (the chat re-renders on every poll), the others stay as they were drawn, and a row that grows keeps its state;
            // closed and opened the way a click does (no inline handler: the Hub's CSP strips those).
            const again = () => { box.innerHTML = m.groupTaskQueueRuns(msgs).map(it => it.kind === 'queue' ? m.renderTaskQueueRun(it, () => 'T') : '').join(''); };
            await new Promise(res => { runs[0].addEventListener('toggle', res, { once: true }); runs[0].querySelector('summary').click(); });
            again();
            out.closedAfter = !box.querySelector('.mb-queue-run[data-queue-run="2"]').open;
            out.otherOpen = box.querySelector('.mb-queue-run[data-queue-run="6"]').open;
            const grown = [{ id: 1.5, subscriber_id: Q, is_system: true, content: '[Task #6 claimed by QA] y' }, ...msgs.slice(1, 4), { id: 4.5, subscriber_id: Q, is_system: true, content: '[Task #9 claimed by QA] z' }];
            box.innerHTML = m.groupTaskQueueRuns(grown).map(it => m.renderTaskQueueRun(it, () => 'T')).join('');
            out.grownClosed = !box.querySelector('.mb-queue-run').open && box.querySelectorAll('.mb-queue-line').length === 5;
            // Opening it again is remembered the same way.
            const row = box.querySelector('.mb-queue-run');
            await new Promise(res => { row.addEventListener('toggle', res, { once: true }); row.querySelector('summary').click(); });
            again();
            out.openAfter = box.querySelector('.mb-queue-run[data-queue-run="2"]').open;
            box.innerHTML = m.groupTaskQueueRuns(grown).map(it => m.renderTaskQueueRun(it, () => 'T')).join('');
            out.grownOpen = box.querySelector('.mb-queue-run').open && box.querySelectorAll('.mb-queue-line').length === 5;
            out.noInlineHandler = !box.innerHTML.includes('ontoggle');
            box.remove();
            return out;
        })()`);
        assert.deepEqual(g.kinds, ['msg', 'queue:3', 'msg', 'queue:1']);
        assert.equal(g.labels[0], '#7 created; Backend Dev took #7; Backend Dev finished #7', 'a short run says what happened to which task and who did it (#10604; #7183 counted it)');
        assert.equal(g.labels[1], 'Task #8 created', 'a single line says its own task and what happened');
        assert.equal(g.lines, 3); assert.deepEqual(g.ids, ['2', '3', '4']);
        assert.equal(g.openAtFirst, true, 'open by default (#11585)');
        assert.ok(g.escaped, 'content is text, never markup');
        assert.ok(g.noCollapse, 'select mode: nothing collapsed');
        assert.ok(g.closedAfter && g.otherOpen, 'a closed row stays closed across re-renders and the others stay as drawn');
        assert.ok(g.grownClosed, 'and when it grows at either end');
        assert.ok(g.openAfter && g.grownOpen, 'a row opened again stays open, grown or not');
        assert.ok(g.noInlineHandler, 'no inline handler (the Hub CSP strips them)');
        console.log('   ✓ runs grouped, summarised, escaped, open state kept');

        console.log('The team chat');
        await ev(`(() => {
            const real = window.fetch.bind(window);
            const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
            const Q = 'Coral Task Queue';
            const msgs = [];
            for (let i = 1; i <= 30; i++) {
                const queue = i % 5 !== 0;
                msgs.push({ id: i, project: 'beta', subscriber_id: queue ? Q : 'Lead Developer', is_system: queue, job_title: queue ? '' : 'Lead Developer',
                    content: queue ? '[Task #' + i + ' claimed by QA] t' : 'human ' + i, created_at: new Date(Date.UTC(2026, 9, 14, 8, 0, i)).toISOString() });
            }
            // #12349: a Coral notice (postNotice posts it as the same sender, "[Coral] ...") is a notice, not 'A task updated': it ends the run before it and stands as its own row, then a new run starts
            msgs.push({ id: 31, project: 'beta', subscriber_id: Q, is_system: true, content: '[Task #31 claimed by QA] u', created_at: new Date(Date.UTC(2026, 9, 14, 8, 1, 1)).toISOString() });
            msgs.push({ id: 32, project: 'beta', subscriber_id: Q, is_system: true, content: '[Coral] Coral did not trust the folder /work/beta: it has no .git. The agents will ask about it in their own terminals; answer there.', created_at: new Date(Date.UTC(2026, 9, 14, 8, 1, 2)).toISOString() });
            msgs.push({ id: 33, project: 'beta', subscriber_id: Q, is_system: true, content: '[Task #33 claimed by QA] v', created_at: new Date(Date.UTC(2026, 9, 14, 8, 1, 3)).toISOString() });
            window.fetch = async (url, opts) => {
                const u = String(url);
                if (u.includes('/api/board/beta/messages/all')) {
                    const limit = Number(new URL(u, location.href).searchParams.get('limit') || 50);
                    return json({ total: msgs.length, messages: msgs.slice(-limit) });
                }
                if (u.includes('/api/board/beta/status')) return json({ summary: { available: 1 }, observed_at: new Date().toISOString(), agents: [], unassigned_tasks: [], health_report: [] });
                if (u.includes('/api/board/beta/working-mode/presets')) return json({ presets: [{ id: 'none', name: 'None', builtin: true, instructions: '' }] });
                if (u.includes('/api/board/beta/working-mode')) return json({ mode: 'none', dependency_guidance: false, custom_instructions: '' });
                if (u.includes('/api/board/beta/tasks')) return json([]);
                if (u.includes('/api/board/beta/paused')) return json({ paused: false });
                if (u.includes('/api/board/beta/subscribers')) return json([]);
                return real(url, opts);
            };
            return true;
        })()`);
        await ev(`(async () => {
            const render = await import(${S}+'render.js');
            render.renderLiveSessions([{ session_id: 'beta-1', name: 'beta-1', agent_type: 'claude', board_project: 'beta', display_name: 'Beta agent', working_directory: '/tmp/beta' }]);
            render.showBoardChatTab('beta'); // the board chat of an agent on the team (its Board tab)
            return true;
        })()`);
        await waitFor(`!!document.querySelector('#board-panel-msgs .mb-queue-run')`, 'the team chat with collapsed task-queue rows');
        const panel = await ev(`(() => { const p = document.getElementById('board-panel-msgs');
            return { runs: p.querySelectorAll('.mb-queue-run').length, bubbles: p.querySelectorAll('.mb-message').length,
                     humans: [...p.querySelectorAll('.mb-message-body')].map(b => b.textContent.trim()),
                     firstRun: p.querySelector('.mb-queue-label').textContent, lastRuns: [...p.querySelectorAll('.mb-queue-label')].slice(-2).map(e => e.textContent).join(' | ') }; })()`);
        assert.equal(panel.bubbles, 7, 'the 6 human messages and the Coral notice are full messages');
        assert.equal(panel.runs, 8, 'each run of 4 task-queue lines between them is one row, and the notice splits the last two lines into two runs');
        assert.deepEqual(panel.humans.slice(0, 6), ['human 5', 'human 10', 'human 15', 'human 20', 'human 25', 'human 30']);
        assert.match(panel.humans[6] || '', /^\[?Coral\]? Coral did not trust the folder/, 'the notice is shown as itself: ' + JSON.stringify(panel.humans[6]));
        assert.ok(!/updated/i.test(panel.lastRuns || ''), 'and no row says a task was updated: ' + panel.lastRuns);
        assert.match(panel.firstRun, /claimed|created|finished|in review|took/); assert.ok(!/task updates|coral-board/.test(panel.firstRun), 'the row is in words: ' + panel.firstRun);
        console.log('   ✓ 24 task-queue lines are 6 rows; the 6 human messages stand out');
        console.log('PASS board task-queue lines are collapsed');
    } finally { await client.close(); }
})().catch(error => { console.error(error); process.exit(1); });
