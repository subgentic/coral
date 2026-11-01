// Where an agent lives (#11580, the operator): the header's repo:branch follows the selected agent (two agents of a team on two worktrees show two different lines), a detached worktree says "detached at <commit>" instead
// of the word HEAD every detached agent shares, and the top of Files always says the agent's folder and branch, not only while it follows a worktree. Real isolated server, mock agents with their own folder and branch;
// drives Chrome over CDP through agent_view_harness.js. 1280 and 390.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const AGENTS = {
        'wt-a': { sid: 'wt-sid-a', branch: 'feat/a', commit_short: null, working_directory: '/work/coral-a', git_state: { is_worktree: true, base_branch: 'main', ahead: 1, behind: 0, dirty: 0 } },
        'wt-b': { sid: 'wt-sid-b', branch: 'HEAD', commit_short: 'abc1234', working_directory: '/work/coral-b', git_state: { is_worktree: true, base_branch: 'main', ahead: 0, behind: 0, dirty: 0 } },
        // two agents LAUNCHED in one folder that have each moved into their own worktree (#11704): the row says where each is now (current_directory), working_directory stays the launch folder
        'wt-c': { sid: 'wt-sid-c', branch: 'feat/c', commit_short: null, working_directory: '/work/launch', current_directory: '/work/launch-wt/c', git_state: { is_worktree: true, base_branch: 'main', ahead: 1, behind: 0, dirty: 2 } },
        'wt-d': { sid: 'wt-sid-d', branch: 'feat/d', commit_short: null, working_directory: '/work/launch', current_directory: '/work/launch-wt/d', git_state: { is_worktree: true, base_branch: 'main', ahead: 0, behind: 0, dirty: 0 } },
    };
    const header = () => ev(`(document.querySelector('#session-branch .branch-text') || {}).textContent || ''`);
    const where = () => ev(`(document.getElementById('files-where') || {}).textContent || ''`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => { const entry = window.__m.entry.bind(window.__m), by = ${JSON.stringify(AGENTS)}; window.__m.entry = a => ({ ...entry(a), repo_name: 'subgentic/coral', ...(by[a.name] ? { branch: by[a.name].branch, commit_short: by[a.name].commit_short, working_directory: by[a.name].working_directory, current_directory: by[a.name].current_directory || '', git_state: by[a.name].git_state } : {}) });
                for (const [n, a] of Object.entries(by)) window.__m.add(n, 'A', 4, { sleeping: false, session_id: a.sid }); return true; })()`);
            await waitFor(`(window.__qaState.liveSessions || []).filter(s => /^wt-sid-/.test(s.session_id)).length === 4`, at + 'both agents', 8000);
            const pick = async (name) => { await ev(`window.selectLiveSession(${JSON.stringify(name)}, 'claude', ${JSON.stringify(AGENTS[name].sid)}, 'local'); true`); await waitFor(`!!document.getElementById('terminal-header-label') && document.getElementById('terminal-header-label').textContent.length > 0`, at + 'the header', 8000); await ev(`new Promise(r => setTimeout(r, 300))`); }; // sleep-ok: the header settles after the agent is selected

            await pick('wt-a');
            const ha = await header(), wa = await where();
            check(ha === 'subgentic/coral : feat/a', at + 'agent A\'s header is its repo and branch: ' + JSON.stringify(ha));
            check(/coral-a/.test(wa) && /feat\/a/.test(wa), at + 'Files names agent A\'s folder and branch at the top: ' + JSON.stringify(wa));
            await pick('wt-b');
            const hb = await header(), wb = await where();
            check(hb === 'subgentic/coral : detached at abc1234', at + 'agent B (detached) says where it is, not the word HEAD: ' + JSON.stringify(hb));
            check(/coral-b/.test(wb) && /detached at abc1234/.test(wb) && wb !== wa, at + 'Files follows the agent: ' + JSON.stringify(wb));
            await pick('wt-c');
            const wc = await where(), dirC = await ev(`(document.querySelector('#live-session-view .terminal-header') || {}).getAttribute?.('data-folder') || ''`);
            check(/launch-wt\/c/.test(wc) && /feat\/c/.test(wc), at + 'Files names where agent C is now, not the folder it was launched in: ' + JSON.stringify(wc));
            check(dirC === '/work/launch-wt/c', at + 'and so does the header\'s folder: ' + JSON.stringify(dirC));
            await pick('wt-d');
            const wd = await where();
            check(/launch-wt\/d/.test(wd) && /feat\/d/.test(wd) && wd !== wc, at + 'agent D, launched in the same folder, is somewhere else: ' + JSON.stringify([wc, wd]));
            await pick('wt-a');
            check((await header()) === ha && (await where()) === wa, at + 'and back to A it is A again: ' + JSON.stringify([await header(), await where()]));
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('agent_where_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
