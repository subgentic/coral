// What the team page (the one team page, #7453; UI/UX's doc 7aa984fe and mock 896e13f3, and the text spec for coral-hub) is looked up by in the team_page_* suites: roles and accessible names, never an id or a class.
// install(ev) puts window.__tp in the page: page() is the main region that holds the team's h1, tablist() its tablist named "Team", tabs() its tabs, find(sel, rx) a visible control in the page (not in the sidebar or the
// detail pane), sidebar() the aside named "Agents", pane() the aside named "Details". It builds on helpers/new_agent.js (its __na has name, text, vis, box).
const na = require('./new_agent');
const SOURCE = `(() => {
    const A = window.__na;
    const main = () => [...document.querySelectorAll('main, [role=main]')].filter(A.vis).find(m => m.querySelector('h1')) || null;
    const page = () => main();
    const h1 = () => { const m = main(); return m ? m.querySelector('h1') : null; };
    const tablist = () => { const m = main(); return m ? [...m.querySelectorAll('[role=tablist]')].find(t => /^Team$/i.test(A.name(t))) || null : null; };
    const tabs = () => { const t = tablist(); return t ? [...t.querySelectorAll('[role=tab]')].filter(A.vis) : []; };
    const tabLabel = e => A.name(e).replace(/\\s*\\d[\\d,]*\\s*$/, '').trim();
    const find = (sel, rx) => { const m = main(); return m ? [...m.querySelectorAll(sel)].filter(A.vis).find(e => rx.test(A.name(e))) || null : null; };
    const sidebar = () => [...document.querySelectorAll('aside')].filter(A.vis).find(a => /^Agents$/i.test(A.name(a))) || null;
    const pane = () => [...document.querySelectorAll('aside')].filter(A.vis).find(a => /^Details$/i.test(A.name(a))) || null;
    const box = e => e ? A.box(e) : null;
    window.__tp = { page, h1, tablist, tabs, tabLabel, find, sidebar, pane, box };
    return true;
})()`;
const install = async ev => { await na.install(ev); return ev(SOURCE); };
const TABS = ['Goals', 'Messages', 'Tasks', 'Agents', 'Artifacts', 'Knowledge', 'Settings'];

// A team as the sidebar shows it (live agents of one board_project, the way team_header_open does) and the same board's goals and tasks on the real isolated server, made through the page's own fetch.
const post = (ev, url, body) => ev(`fetch(${JSON.stringify(url)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)}) }).then(r => r.json().catch(() => ({})))`);
async function seed(ev, board) {
    await ev(`(() => { localStorage.removeItem('coral_collapsed_groups'); window.__m.agents = {};
        for (const [i, n] of ['Orchestrator', 'Backend Dev'].entries()) window.__m.add(n, 'A', 1, { sleeping: false, session_id: 'sid-' + (i + 1), board_project: ${JSON.stringify(board)} });
        window.__LIVE = Object.values(window.__m.agents).map(x => window.__m.entry(x)); T.state.liveSessions = window.__LIVE; T.render.renderLiveSessions(window.__LIVE); return true; })()`);
    const B = `/api/board/${board}`;
    await post(ev, `${B}/subscribe`, { subscriber_id: 'Orchestrator', job_title: 'Orchestrator' });
    await post(ev, `${B}/subscribe`, { subscriber_id: 'Backend Dev', job_title: 'Developer' });
    const g1 = await post(ev, `${B}/goals`, { title: 'Explore goals with two teams', outcome: 'Try goals, task links and cross-team requests.', done_when: 'You have linked tasks and closed a goal.', state: 'active', subscriber_id: 'Orchestrator', created_by: 'Orchestrator' });
    const g2 = await post(ev, `${B}/goals`, { title: 'Plan the release notes', outcome: 'Release notes are drafted and reviewed.', done_when: 'The Orchestrator approved the draft.', state: 'active', subscriber_id: 'Orchestrator', created_by: 'Orchestrator' });
    const id = r => r && (r.id || (r.goal && r.goal.id));
    for (const [title, goal, priority] of [['Add the goal filter', id(g1), 'high'], ['Check the Settings dialog', id(g1), 'medium'], ['Review the filter', id(g1), 'high'], ['Write the release notes', id(g2), 'medium'], ['Fix the focus ring', null, 'high']]) {
        const body = { title, priority, created_by: 'Orchestrator' }; if (goal) body.goal_id = goal;
        await post(ev, `${B}/tasks`, body);
    }
    await post(ev, `${B}/messages`, { subscriber_id: 'Orchestrator', as: 'Orchestrator', content: 'A message for the team page suites.' });
    return { goals: ['Explore goals with two teams', 'Plan the release notes'], tasks: ['Add the goal filter', 'Check the Settings dialog', 'Review the filter', 'Write the release notes', 'Fix the focus ring'] };
}
// Open the team the way a person does: its name in the sidebar. Resolves when a main region with the team's h1 is there (or after the wait, so a failing build says what is missing).
async function openTeam(ev, waitFor, team) {
    await ev(`(() => { const side = window.__tp.sidebar() || document; const b = [...side.querySelectorAll('button, a, [role=button]')].filter(window.__na.vis).find(x => window.__na.name(x).replace(/^Open team\\s+/i, '').startsWith(${JSON.stringify(team)}) && !/^(Collapse|Expand)/i.test(window.__na.name(x))); if (!b) return false; b.click(); return true; })()`);
    await waitFor(`!!window.__tp.h1() && window.__tp.h1().textContent.includes(${JSON.stringify(team)})`, `the team page of ${team} (a main region with the team's h1)`, 6000);
}
const goTab = async (ev, settle, name) => { await ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === ${JSON.stringify(name)}); if (!t) return false; t.click(); return true; })()`); await settle(300); };
const rect = ev => ev(`(() => { const h = window.__tp.h1(), t = window.__tp.tablist(); return { h1: window.__tp.box(h), tabs: window.__tp.box(t) }; })()`);
module.exports = { SOURCE, install, TABS, seed, post, openTeam, goTab, rect, scenarios: na.scenarios };
