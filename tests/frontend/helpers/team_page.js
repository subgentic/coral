// What the team page (the one team page, #7453; UI/UX's doc 7aa984fe and mock 896e13f3, and the text spec for coral-hub) is looked up by in the team_page_* suites: roles and accessible names, never an id or a class.
// install(ev) puts window.__tp in the page: page() is the main region that holds the team's h1, tablist() its tablist named "Team", tabs() its tabs, find(sel, rx) a visible control in the page (not in the sidebar or the
// detail pane), sidebar() the aside named "Agents", pane() the aside named "Details". It builds on helpers/new_agent.js (its __na has name, text, vis, box).
const na = require('./new_agent');
const SOURCE = `(() => {
    const A = window.__na;
    const main = () => [...document.querySelectorAll('main, [role=main]')].filter(A.vis).find(m => [...m.querySelectorAll('h1')].some(A.vis)) || null;
    const page = () => main();
    const h1 = () => { const m = main(); return m ? [...m.querySelectorAll('h1')].find(A.vis) || null : null; };
    const tablist = () => { const m = main(); return m ? [...m.querySelectorAll('[role=tablist]')].find(t => /^Team$/i.test(A.name(t))) || null : null; };
    const tabs = () => { const t = tablist(); return t ? [...t.querySelectorAll('[role=tab]')].filter(A.vis) : []; };
    // every tab of the list, including the ones a phone puts behind its More menu (Artifacts, Knowledge, Settings: display none under 761 px)
    const allTabs = () => { const t = tablist(); return t ? [...t.querySelectorAll('[role=tab]')] : []; };
    const tabLabel = e => A.name(e).replace(/\\s*\\d[\\d,]*\\s*$/, '').trim();
    const find = (sel, rx) => { const m = main(); return m ? [...m.querySelectorAll(sel)].filter(A.vis).find(e => rx.test(A.name(e))) || null : null; };
    // On a phone the list the sidebar holds is the Agents screen (the bottom bar's Agents tab), not an aside.
    const sidebar = () => [...document.querySelectorAll('aside')].filter(A.vis).find(a => /^Agents$/i.test(A.name(a))) || [...document.querySelectorAll('#mobile-agent-list')].filter(A.vis)[0] || null;
    const pane = () => [...document.querySelectorAll('aside')].filter(A.vis).find(a => /^Details$/i.test(A.name(a))) || null;
    const box = e => e ? A.box(e) : null;
    // The visible table of the page body (a table, or a role=table/grid), its column headers and its body rows as screen-reader text.
    const table = () => { const m = main(); return m ? [...m.querySelectorAll('table, [role=table], [role=grid]')].find(A.vis) || null : null; };
    const headers = () => { const t = table(); return t ? [...t.querySelectorAll('th, [role=columnheader]')].filter(A.vis).map(h => A.text(h).replace(/\\s+/g, ' ').trim()) : null; };
    const rows = () => { const t = table(); return t ? [...t.querySelectorAll('tbody tr, [role=row]')].filter(r => A.vis(r) && !r.querySelector('th, [role=columnheader]')).map(r => A.text(r).replace(/\\s+/g, ' ').trim()) : null; };
    // A named group of filter chips (a role=group, toolbar or fieldset named for what it filters) and its buttons with their pressed state.
    const group = rx => { const m = main(); return m ? [...m.querySelectorAll('[role=group], [role=toolbar], fieldset')].filter(A.vis).find(g => rx.test(A.name(g))) || null : null; };
    // On a phone the toolbar's pills are one compact select with the same name (#7717): its options stand in for the chips, the chosen one pressed.
    const chips = rx => { const g = group(rx); if (g) return [...g.querySelectorAll('button, [role=button]')].filter(A.vis).map(b => ({ name: A.name(b).replace(/\\s+/g, ' ').trim(), pressed: b.getAttribute('aria-pressed') }));
        const m = main(); const s = m && [...m.querySelectorAll('select')].filter(A.vis).find(x => rx.test(A.name(x))); return s ? [...s.options].map(o => ({ name: o.textContent.replace(/\\s+/g, ' ').trim(), pressed: String(o.selected) })) : null; };
    // Every write the page makes after record(): method, path and body, so a suite can say "this click sent something".
    const record = () => { if (window.__writes) return true; window.__writes = []; const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const m = String((o && o.method) || 'GET').toUpperCase(); if (m !== 'GET') window.__writes.push({ m, p: new URL(String(u), location.origin).pathname, b: String((o && o.body) || '') }); return R(u, o); }; return true; };
    window.__tp = { page, h1, tablist, tabs, allTabs, tabLabel, find, sidebar, pane, box, table, headers, rows, group, chips, record };
    return true;
})()`;
const install = async ev => { await na.install(ev); return ev(SOURCE); };
const TABS = ['Goals', 'Board', 'Tasks', 'Agents', 'Artifacts', 'Knowledge', 'Settings'];

// A team as the sidebar shows it (live agents of one board_project, the way team_header_open does) and the same board's goals and tasks on the real isolated server, made through the page's own fetch.
const post = (ev, url, body) => ev(`fetch(${JSON.stringify(url)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)}) }).then(r => r.json().catch(() => ({})))`);
// The rows carry team_health_on, as the live list's do: the team's health icon is there.
async function seed(ev, board) {
    await ev(`(() => { localStorage.removeItem('coral_collapsed_groups'); window.__m.agents = {};
        for (const [i, n] of ['Orchestrator', 'Backend Dev'].entries()) window.__m.add(n, 'A', 1, { sleeping: false, session_id: 'sid-' + (i + 1), board_project: ${JSON.stringify(board)} });
        window.__LIVE = Object.values(window.__m.agents).map(x => ({ ...window.__m.entry(x), team_health_on: true })); T.state.liveSessions = window.__LIVE; T.render.renderLiveSessions(window.__LIVE); return true; })()`);
    const B = `/api/board/${board}`;
    await post(ev, `${B}/subscribe`, { subscriber_id: 'Orchestrator', job_title: 'Orchestrator' });
    await post(ev, `${B}/subscribe`, { subscriber_id: 'Backend Dev', job_title: 'Developer' });
    // The suites seed the same board once per screen size: goals and tasks made already are the ones the next size sees (a second seed would double the counts).
    const made = await ev(`fetch(${JSON.stringify(B + '/goals?state=proposed,active,blocked,done,dropped')}).then(r => r.ok ? r.json() : []).then(j => (Array.isArray(j) ? j : j.goals || []).length).catch(() => 0)`);
    const names = { goals: ['Explore goals with two teams', 'Plan the release notes'], tasks: ['Add the goal filter', 'Check the Settings dialog', 'Review the filter', 'Write the release notes', 'Fix the focus ring'] };
    if (made) return names;
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
const goTab = async (ev, settle, name) => { await ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === ${JSON.stringify(name)}); if (t) { t.click(); return true; } const li = [...document.querySelectorAll('#team-tabs-more-menu [role=menuitem]')].find(i => i.textContent.trim().startsWith(${JSON.stringify(name)})); if (!li) return false; li.click(); return true; })()`); await settle(300); }; // a phone's tabs behind More (Artifacts, Knowledge, Settings) are chosen from its menu: the suite taps its item
const rect = ev => ev(`(() => { const h = window.__tp.h1(), t = window.__tp.tablist(); return { h1: window.__tp.box(h), tabs: window.__tp.box(t) }; })()`);
// The seeded members have no terminal, so the board's status calls them Ended (offline, #8271) and the Agents tab draws no Remind for them. A suite about Remind's place on a row needs them up: the board's /status answer is read
// as it is, the first offline member made available and the others waiting for input (a team with someone to remind, two statuses and a health icon).
async function agentsUp(ev) {
    await ev(`(() => { const R = window.fetch.bind(window); window.fetch = async (u, o = {}) => { const url = new URL(String(u), location.origin); const r = await R(u, o);
        if (!/^\\/api\\/board\\/[^/]+\\/status$/.test(url.pathname) || !r.ok) return r;
        const d = await r.clone().json().catch(() => null); if (!d || !Array.isArray(d.agents)) return r;
        d.agents = d.agents.map((a, i) => (a.availability === 'offline' ? (i === 0 ? { ...a, availability: 'available', available: true, reason: 'Idle' } : { ...a, availability: 'needs_input', available: false, reason: 'Waiting for user input or approval' }) : a));
        return new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } }); }; return true; })()`);
}
module.exports = { SOURCE, install, TABS, seed, agentsUp, post, openTeam, goTab, rect, scenarios: na.scenarios };
