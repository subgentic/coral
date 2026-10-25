// Knowledge distillation survives leaving the view (#3325), on the team page's Knowledge tab (#7457: the dock's panel and its progress and failure notes went). The server runs a
// distillation in the background; the dashboard follows it from knowledge_distill.js, wherever the person is:
//   - start → leave the team → the team header says "Distilling…" → come back: the button says Distilling… and is off, and no second run was started;
//   - it completes while you are elsewhere: a toast says the knowledge is ready, the chip goes, and the tab lists the entries with their Updated column;
//   - a partial run and a failure each have their toast; with no knowledge the page is the empty one and Distill starts a run again;
//   - a run in progress is found after a reload, without opening the tab;
//   - a run lost to a server restart (running → none) says so in a toast.
// /api/teams/detail/alpha/distill-knowledge and /knowledge are scripted in the page.
//
// Expects CORAL_TEST_URL + CDP_PORT from tests/frontend/run.sh. Exit 0 / 1.

const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;

const results = [];
function check(label, cond, detail) {
    const v = cond ? 'PASS' : 'FAIL';
    results.push(v);
    console.log(`[${v}] ${label}${detail !== undefined ? ' — ' + detail : ''}`);
}

// The scripted server. window.__distill is the job status; window.__bundle the knowledge.
// sessionStorage keeps them across a reload of the page.
const STUB = `(function(){
  const load = (k, d) => { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
  window.__distill = load('qa-distill', { status: 'none' });
  window.__bundle = load('qa-bundle', { exists: false });
  window.__posts = 0;
  window.__save = () => { sessionStorage.setItem('qa-distill', JSON.stringify(window.__distill)); sessionStorage.setItem('qa-bundle', JSON.stringify(window.__bundle)); };
  const real = window.fetch.bind(window);
  const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
  window.fetch = (url, opts = {}) => {
    const u = String(url); const m = (opts.method || 'GET').toUpperCase();
    if (u.includes('/api/teams/detail/alpha/distill-knowledge')) {
      if (m === 'POST') {
        if (window.__distill.status === 'running') return json(window.__distill);
        window.__posts++;
        window.__distill = { team_name: 'alpha', status: 'running', progress: { phase: 'starting', total: 0, completed: 0 }, started_at: new Date().toISOString() };
        return json(window.__distill, 202);
      }
      return json(window.__distill);
    }
    if (u.includes('/api/teams/detail/alpha/knowledge')) { window.__bundleReads = (window.__bundleReads || 0) + 1; return json(window.__bundle); }
    if (u.includes('/api/board/alpha/messages/all')) return json({ total: 0, messages: [] });
    if (u.includes('/api/board/alpha/status')) return json({ summary: {}, observed_at: new Date().toISOString(), agents: [], unassigned_tasks: [], health_report: [] });
    if (u.includes('/api/board/alpha/working-mode/presets')) return json({ presets: [] });
    if (u.includes('/api/board/alpha/working-mode')) return json({ mode: 'none', dependency_guidance: false, custom_instructions: '' });
    if (u.includes('/api/board/alpha/tasks')) return json({ tasks: [], next_cursor: '', total_open: 0, total_completed: 0 });
    if (u.includes('/api/board/alpha/paused')) return json({ paused: false });
    if (u.includes('/api/board/alpha/subscribers')) return json([]);
    return real(url, opts);
  };
})();`;

const BUNDLE = { exists: true, index: '# Team alpha\\n\\nWhat the team knows.', agents: [{ name: 'lead', content: '# Lead\\n\\nNotes.' }] };

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Emulation } = client;
    const exceptions = [];
    const ev = async expression => {
        const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
        return r.result.value;
    };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const until = (x, what, timeout = 5000) => waitFor(x, what, { soft: true, timeout });
    const S = `(window.__coralStatic||'/static/')`;
    const boot = async () => {
        await Page.navigate({ url: BASE }); await Page.loadEventFired();
        await coralReady();
        await ev(`(async () => {
            const { state } = await import(${S}+'state.js');
            const render = await import(${S}+'render.js');
            const kd = await import(${S}+'knowledge_distill.js');
            kd.distillHooks.pollMs = 150;
            window.__render = render; window.__state = state; window.__kd = kd;
            // The app's own live list (re-renders, e.g. for the Distilling chip, redraw from it).
            window._coralSetLiveSessions([{ session_id: 'alpha-1', name: 'alpha-1', agent_type: 'claude', board_project: 'alpha', display_name: 'Alpha agent', working_directory: '/tmp/alpha' }]);
            return true;
        })()`);
    };
    const panelText = () => ev(`(document.getElementById('team-panel-knowledge') || {}).textContent || ''`);
    const chip = () => ev(`!!document.querySelector('.session-group-header .team-distill-chip')`);
    const toasts = () => ev(`[...document.querySelectorAll('.toast .toast-message')].map(t => t.textContent)`);
    const openKnowledge = () => ev(`window.openTeamPage('alpha', { tab: 'knowledge' }); true`);
    const leave = async () => {
        await ev(`window.exitTeamPage({ force: true }); true`);
        await until(`!window.__state.selectedTeam`, 'the team page left');
    };

    try {
        await Promise.all([Page.enable(), Runtime.enable()]);
        Runtime.exceptionThrown(e => exceptions.push((((e.exceptionDetails || {}).exception || {}).description || 'exception').slice(0, 200)));
        // A clean scripted server for the first load only; a later reload keeps its state.
        const clean = await Page.addScriptToEvaluateOnNewDocument({ source: `sessionStorage.removeItem('qa-distill'); sessionStorage.removeItem('qa-bundle');` });
        await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Emulation.setDeviceMetricsOverride({ width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
        await boot();
        await Page.removeScriptToEvaluateOnNewDocument({ identifier: clean.identifier });

        // ── Start, leave, come back ──
        await openKnowledge();
        await until(`/No knowledge yet/.test((document.getElementById('team-panel-knowledge') || {}).textContent || '')`, 'the empty knowledge view');
        check('no knowledge yet: the empty view with Distill', /No knowledge yet/.test(await panelText()));
        await ev(`document.querySelector('#team-panel-knowledge .team-distill').click(); true`);
        await until(`window.__posts === 1 && /Distilling…/.test(document.getElementById('team-panel-knowledge').textContent)`, 'the run started');
        check('Distill starts one run and the button says Distilling…, off', (await ev('window.__posts')) === 1 && /Distilling…/.test(await panelText()) && (await ev(`document.querySelector('#team-panel-knowledge .team-distill').disabled`)));

        await leave();
        await until(`!!document.querySelector('.session-group-header .team-distill-chip')`, 'the Distilling chip');
        check('away from the team: its header says Distilling…', await chip());
        await ev(`window.__distill.progress = { phase: 'extracting', agent: 'lead', total: 4, completed: 2 }; window.__bundleReads = 0; true`);
        await openKnowledge();
        await until(`/Distilling…/.test((document.getElementById('team-panel-knowledge') || {}).textContent || '')`, 'the run on return');
        check('back on the Knowledge tab: the run in progress is shown (Distilling…, off)', /Distilling…/.test(await panelText()) && (await ev(`document.querySelector('#team-panel-knowledge .team-distill').disabled`)));
        check('coming back started no second run', (await ev('window.__posts')) === 1);

        // ── It completes while you are elsewhere ──
        await leave();
        await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); window.__bundle = ${JSON.stringify(BUNDLE)}; window.__distill = { team_name: 'alpha', status: 'complete', started_at: '2026-10-14T06:00:00Z', finished_at: '2026-10-14T06:05:00Z' }; true`);
        await until(`[...document.querySelectorAll('.toast .toast-message')].some(t => /Knowledge for alpha is ready/.test(t.textContent))`, 'the ready toast');
        check('completed elsewhere: a toast says the knowledge is ready', (await toasts()).some(t => /Knowledge for alpha is ready/.test(t)), JSON.stringify(await toasts()));
        await until(`!document.querySelector('.session-group-header .team-distill-chip')`, 'the chip gone');
        check('the Distilling chip is gone', !(await chip()));
        await openKnowledge();
        await until(`document.querySelectorAll('#team-panel-knowledge tbody tr').length > 0`, 'the entries');
        const done = await panelText();
        check('the tab lists the knowledge: the team\'s index, with its Updated column', /Index/.test(done) && /Updated/.test(done), done.slice(0, 160));

        // ── A partial run (QA's #3325 note 2): complete, but some agents couldn't be distilled ──
        await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); true`);
        await ev(`document.querySelector('#team-panel-knowledge .team-distill').click(); true`);
        await until(`window.__posts === 2`, 'the partial re-distill');
        await ev(`window.__distill = { team_name: 'alpha', status: 'complete', finished_at: '2026-10-14T06:07:00Z', failed_agents: [{ agent: 'lead', error: 'claude CLI failed: exit status 1' }, { agent: 'qa', error: '' }], collaboration_error: 'claude CLI timed out after 2m0s' }; true`);
        await until(`[...document.querySelectorAll('.toast .toast-message')].some(t => /couldn't be distilled/.test(t.textContent))`, 'the partial toast');
        check('partial: the toast says it is ready, but 2 agents could not be distilled',
            (await toasts()).some(t => /Knowledge for alpha is ready, but 2 agents couldn't be distilled/.test(t)), JSON.stringify(await toasts()));

        // ── A failure with earlier knowledge: that knowledge, with a note ──
        await ev(`document.querySelector('#team-panel-knowledge .team-distill').click(); true`);
        await until(`window.__posts === 3`, 'the re-distill');
        await ev(`window.__distill = { team_name: 'alpha', status: 'failed', error: 'claude exited 1', finished_at: '2026-10-14T06:10:00Z' }; true`);
        await until(`[...document.querySelectorAll('.toast .toast-message')].some(t => /Knowledge distillation for alpha failed: claude exited 1/.test(t.textContent))`, 'the failure toast');
        check('a failure toast too', (await toasts()).some(t => /Knowledge distillation for alpha failed: claude exited 1/.test(t)), JSON.stringify(await toasts()));

        // ── A failure with no knowledge yet: the empty page and Distill again ──
        await ev(`window.__bundle = { exists: false }; true`);
        await leave();
        await openKnowledge();
        await until(`/No knowledge yet/.test((document.getElementById('team-panel-knowledge') || {}).textContent || '')`, 'the empty page');
        await ev(`document.querySelector('#team-panel-knowledge .team-distill').click(); true`);
        await until(`window.__posts === 4`, 'Distill starts a run again');
        check('Distill starts a run again', (await ev('window.__posts')) === 4);

        // ── A run in progress is found after a reload, without opening the tab ──
        await ev(`window.__distill.progress = { phase: 'formatting', total: 4, completed: 4 }; window.__save(); true`);
        await Page.reload({}); await Page.loadEventFired();
        await boot();
        await until(`!!document.querySelector('.session-group-header .team-distill-chip')`, 'the chip after a reload');
        check('after a reload the running distillation is found: the header says Distilling…', await chip());
        await ev(`window.__distill = { team_name: 'alpha', status: 'complete', finished_at: '2026-10-14T06:20:00Z' }; window.__save(); true`);
        await until(`[...document.querySelectorAll('.toast .toast-message')].some(t => /Knowledge for alpha is ready/.test(t.textContent))`, 'the ready toast after the reload');
        check('and it is followed to the end (toast)', (await toasts()).some(t => /Knowledge for alpha is ready/.test(t)));

        // ── The server restarts mid-run: the status goes back to 'none' ──
        await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); window.__distill = { team_name: 'alpha', status: 'running', progress: { phase: 'extracting', agent: 'lead', total: 4, completed: 1 } }; window.__save(); true`);
        await ev(`(async () => { const m = await import((window.__coralStatic||'/static/')+'knowledge_distill.js'); await m.refreshDistill('alpha'); return true; })()`);
        await until(`!!document.querySelector('.session-group-header .team-distill-chip')`, 'the chip for the new run');
        await ev(`window.__distill = { status: 'none' }; window.__save(); true`);
        await until(`[...document.querySelectorAll('.toast .toast-message')].some(t => /was interrupted/.test(t.textContent))`, 'the interrupted toast');
        check('lost to a restart: a toast says it was interrupted', (await toasts()).some(t => /The distillation for alpha was interrupted \(Coral restarted\); start it again/.test(t)), JSON.stringify(await toasts()));
        await until(`!document.querySelector('.session-group-header .team-distill-chip')`, 'the chip to go');
        check('and the Distilling chip is gone', !(await chip()));
        check('no page exceptions', exceptions.length === 0, JSON.stringify(exceptions));
    } finally {
        await client.close();
    }
})().then(() => {
    const failed = results.filter(r => r === 'FAIL').length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
}).catch(err => { console.error(err); process.exit(1); });
