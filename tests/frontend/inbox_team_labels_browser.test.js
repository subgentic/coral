// Two teams called alpha on two computers (#8774, Hub audit #8762): in hub mode with a remote, the Inbox's Goals and Tasks folders and Needs you tell them apart by their computer ("alpha · This computer",
// "alpha · Box Two"), in the Team column and in the Team filter's choices and chips; Tasks has the Team filter. The goals, the tasks and the waiting agents are stood in (this computer's and the remote's
// at /api/remote/box-2/...). 1280 and 390. Drives Chrome over CDP against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const fs = require('node:fs');
const path = require('node:path');

const GOALS = { local: [{ id: 1, board_id: 'alpha', title: 'Local goal', outcome: 'Ship the local importer', state: 'active', driver: 'Orchestrator', updated_at: '2026-10-26T10:00:00Z', rollup: { done: 0, active: 1, blocked: 0, queued: 0 } }],
    'box-2': [{ id: 1, board_id: 'alpha', title: 'Remote goal', outcome: 'Ship the remote importer', state: 'active', driver: 'Orchestrator', updated_at: '2026-10-25T10:00:00Z', rollup: { done: 0, active: 1, blocked: 0, queued: 0 } }] };
const ARTS = { local: [{ id: '1'.repeat(64), name: 'local-report.md', media_type: 'text/markdown', size: 1000, created_at: '2026-10-26T10:00:00Z', task_id: 7, task_title: 'Local finished task with files', source: 'task', uri: 'coral://artifacts/' + '1'.repeat(64), available: true, inline: false, reference_count: 1, board_id: 'alpha', team: 'alpha', goal_id: 3, goal_title: 'Local goal for the importer' }],
    'box-2': [{ id: '2'.repeat(64), name: 'remote-report.md', media_type: 'text/markdown', size: 2000, created_at: '2026-10-25T10:00:00Z', task_id: 7, task_title: 'Remote finished task with files', source: 'task', uri: 'coral://artifacts/' + '2'.repeat(64), available: true, inline: false, reference_count: 1, board_id: 'alpha', team: 'alpha', goal_id: 3, goal_title: 'Remote goal for the importer' }] };
const SAVED = { local: [{ id: 1, kind: 'board', ref: 'alpha', key: '1001', title: 'alpha board', snippet: 'Local note', saved_at: '2026-10-26T10:00:00Z', team: 'alpha' }],
    'box-2': [{ id: 1, kind: 'board', ref: 'alpha', key: '1001', title: 'alpha board', snippet: 'Remote note', saved_at: '2026-10-25T10:00:00Z', team: 'alpha' }] };
const TASKS = { local: [{ id: 7, board_id: 'alpha', title: 'Local task', priority: 'high', status: 'queued', assigned_to: 'Operator', updated_at: '2026-10-26T10:00:00Z' }],
    'box-2': [{ id: 7, board_id: 'alpha', title: 'Remote task', priority: 'medium', status: 'queued', assigned_to: 'Operator', updated_at: '2026-10-25T10:00:00Z' }] };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async (name, theme) => { // the review shots, when a folder is given (CORAL_SCREENSHOT_DIR)
        const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out')); if (!dir) return;
        await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`); await settle(200);
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    };
    const column = title => ev(`(() => { const th = [...document.querySelectorAll('#group-table-view th')].findIndex(h => h.textContent.replace(/[\\u2191\\u2193\\u2195]/g, '').trim() === ${JSON.stringify(title)}); if (th < 0 || document.querySelector('#group-table-view tr.dt-mailed')) return null; // a phone's mail rows have no columns (#9545)
        return [...document.querySelectorAll('#group-table-view tbody tr')].filter(r => r.querySelector('.dt-primary, td')).map(r => (r.children[th] || {}).textContent.replace(/\\s+/g, ' ').trim()); })()`);
    const teamChoices = () => ev(`[...document.querySelectorAll('.inbox-folder-toolbar select[id$="-team"] option')].map(o => [o.value, o.textContent.trim()])`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`try { for (const k of Object.keys(localStorage)) if ((k.startsWith('coral-inbox-') || k.startsWith('coral-saved-filters'))) localStorage.removeItem(k); } catch {} true`);
            await ev(`(async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; st.hub = true; st.servers = [{ id: 'box-2', label: 'Box Two', status: 'online' }];
                const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o) => { const url = new URL(String(u && u.url || u), location.href), where = url.pathname.startsWith('/api/remote/box-2/') ? 'box-2' : 'local', path = url.pathname.replace(/^\\/api\\/remote\\/box-2/, '');
                    if (path === '/api/goals') return json({ goals: ${JSON.stringify(GOALS)}[where] });
                    if (path === '/api/board/tasks') return json({ tasks: ${JSON.stringify(TASKS)}[where] });
                    if (path === '/api/team-artifacts') return json({ artifacts: ${JSON.stringify(ARTS)}[where], limit: 100, offset: 0, has_more: false, truncated: false, total: 1, all: 1, teams: [{ board_id: 'alpha', team: 'alpha', all: 1 }] });
                    if (path === '/api/saved') return json({ items: ${JSON.stringify(SAVED)}[where], open: 1, done: 0 });
                    if (path === '/api/system/artifact-store/kept') return json({ kept: [] });
                    return R(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('.view-list-item').length > 3 || !!document.querySelector('.view-list select')`, 'the folders', 10000);
            const open = async key => {
                if (mobile) await ev(`(() => { const b = document.querySelector('.view-list-item[data-key=' + ${JSON.stringify(JSON.stringify(key))} + ']'); b.click(); return true; })()`);
                else await ev(`document.querySelector('.view-list-item[data-key="${key}"]').click(); true`);
                await settle(600);
            };
            const panel = async () => { if (!(await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').getAttribute('aria-expanded')`) === 'true')) { await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').click(); true`); await settle(250); } };

            // Goals
            await open('goals');
            await waitFor(`document.querySelectorAll('#group-table-view button.dt-primary').length >= 2`, `${label}: two goals`, 10000);
            const gteams = await column('Team');
            if (!mobile) check(`${label}: Goals' Team column tells the two alpha teams apart`, gteams && gteams.length === 2 && gteams[0] !== gteams[1] && gteams.some(t => /alpha.*This computer/.test(t)) && gteams.some(t => /alpha.*Box Two/.test(t)), JSON.stringify(gteams));
            await shot(`team-labels-goals-${label}`, mobile ? 'dark' : 'light');
            await panel();
            await ev(`(() => { const s = document.getElementById('inbox-goals-team'); s.size = s.options.length; return true; })()`); // the choices as a list, for the shot (a native popup is not in one)
            await shot(`team-labels-goals-team-filter-${label}`, mobile ? 'dark' : 'light');
            await ev(`document.getElementById('inbox-goals-team').size = 0; true`);
            const gchoices = await teamChoices();
            check(`${label}: Goals' Team filter offers both, by their computer`, gchoices.filter(([v]) => v).length === 2 && new Set(gchoices.map(c => c[1])).size === gchoices.length && gchoices.some(([v, t]) => v === '@box-2/alpha' && /Box Two/.test(t)), JSON.stringify(gchoices));
            await ev(`(() => { const s = document.getElementById('inbox-goals-team'); s.value = '@box-2/alpha'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(400);
            check(`${label}: choosing the remote one shows its goal, with a chip that names the computer`, JSON.stringify(await ev(`[...document.querySelectorAll('#group-table-view button.dt-primary')].map(b => (b.querySelector('.dt-mail-title') || b).textContent.trim())`)) === '["Remote goal"]' && (mobile || /Box Two/.test(await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .list-bar-chip-text')].map(e => e.textContent).join('|')`))));

            // Tasks: the Team column, and the Team filter this folder did not have
            await open('tasks');
            await waitFor(`document.querySelectorAll('#group-table-view tbody .dt-primary').length >= 2`, `${label}: two tasks`, 10000);
            const tteams = await column('Team');
            if (!mobile) check(`${label}: Tasks' Team column tells the two alpha teams apart`, tteams && tteams.length === 2 && tteams[0] !== tteams[1] && tteams.some(t => /alpha.*This computer/.test(t)) && tteams.some(t => /alpha.*Box Two/.test(t)), JSON.stringify(tteams));
            await shot(`team-labels-tasks-${label}`, mobile ? 'dark' : 'light');
            await panel();
            await ev(`(() => { const s = document.getElementById('inbox-tk-team'); s.size = s.options.length; return true; })()`);
            await shot(`team-labels-tasks-filters-${label}`, mobile ? 'dark' : 'light');
            await ev(`document.getElementById('inbox-tk-team').size = 0; true`);
            const tchoices = await ev(`[...document.querySelectorAll('#inbox-tk-team option')].map(o => [o.value, o.textContent.trim()])`);
            check(`${label}: Tasks has a Team filter with both teams, by their computer`, tchoices.filter(([v]) => v).length === 2 && tchoices.some(([v, t]) => v === '@box-2/alpha' && /Box Two/.test(t)) && tchoices.some(([v, t]) => v === 'alpha' && /This computer/.test(t)), JSON.stringify(tchoices));
            await ev(`(() => { const s = document.getElementById('inbox-tk-team'); s.value = '@box-2/alpha'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(500);
            check(`${label}: choosing the remote one shows its task, with a chip that names the computer`, JSON.stringify(await ev(`[...document.querySelectorAll('#group-table-view tbody .dt-primary')].map(b => ((b.querySelector('.dt-mail-title') || b).textContent).replace(/^#\\d+\\s*/, '').trim())`)) === '["Remote task"]' && (mobile || /Box Two/.test(await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .list-bar-chip-text')].map(e => e.textContent).join('|')`))), JSON.stringify(await ev(`[...document.querySelectorAll('#group-table-view tbody .dt-primary')].map(b => b.textContent.trim())`)));

            // Needs you: two agents waiting, one on each computer's alpha
            await ev(`(async () => { const S = window.__coralStatic || '/static/'; const ago = m => new Date(Date.now() - m * 60000).toISOString();
                window.__m.add('Local Dev', 'A', 4, { sleeping: false, board_project: 'alpha', session_id: 'ld-id' }); window.__m.add('Remote Dev', 'B', 4, { sleeping: false, board_project: 'alpha', session_id: 'rd-id', server: 'box-2' });
                window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, waiting_for_input: true, waiting_kind: 'permission', waiting_since: ago(5) }));
                (await import(S + 'inbox_tab.js')).updateInboxTab(); return true; })()`);
            await open('needs');
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 2`, `${label}: two waiting agents`, 10000);
            const nteams = await column('Team');
            // Saved: a bookmark of each computer's alpha
            await open('saved');
            await waitFor(`document.querySelectorAll('#group-table-view .dt-primary, #group-table-view .dt-person').length >= 2 || /Local note/.test(document.getElementById('group-table-view').textContent) && /Remote note/.test(document.getElementById('group-table-view').textContent)`, `${label}: two saved messages`, 10000); await settle(400);
            await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').getAttribute('aria-expanded') === 'true' || document.querySelector('.inbox-folder-toolbar .list-bar-toggle').click(); true`); await settle(250);
            await ev(`(() => { const s = document.getElementById('inbox-saved-team'); if (s) s.size = s.options.length; return true; })()`);
            await shot(`team-labels-saved-team-filter-${label}`, mobile ? 'dark' : 'light');
            await ev(`(() => { const s = document.getElementById('inbox-saved-team'); if (s) s.size = 0; return true; })()`);
            const schoices = await teamChoices();
            check(`${label}: Saved's Team filter lists the two alpha teams by their computer`, schoices.filter(([v]) => v).length === 2 && schoices.some(([v, t]) => v === '@box-2/alpha' && /alpha · Box Two/.test(t)) && schoices.some(([v, t]) => v === 'alpha' && /alpha · This computer/.test(t)), JSON.stringify(schoices));
            await ev(`(() => { const s = document.getElementById('inbox-saved-team'); s.value = '@box-2/alpha'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(500);
            const stext = await ev(`document.getElementById('group-table-view').textContent.replace(/\\s+/g, ' ')`);
            check(`${label}: choosing the remote one keeps only its bookmark, with a chip that names the computer`, /Remote note/.test(stext) && !/Local note/.test(stext) && /Box Two/.test(await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .list-bar-chip-text')].map(e => e.textContent).join('|')`)), stext);
            // Artifacts: the files of each computer's alpha
            await open('artifacts');
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 2`, `${label}: two files`, 10000); await settle(500);
            await shot(`team-labels-artifacts-${label}`, mobile ? 'dark' : 'light');
            const arows = await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
            check(`${label}: Artifacts' Team and Computer tell the two alpha teams apart (This computer's file and Box Two's), the computer in a column of its own where there is room (#9408)`, arows.some(t => /local-report/.test(t) && /alpha/.test(t) && /This computer/.test(t)) && arows.some(t => /remote-report/.test(t) && /alpha/.test(t) && /Box Two/.test(t)) && (await ev(`[...document.querySelectorAll('#group-table-view thead th')].some(h => h.textContent.trim().startsWith('Computer') && h.getClientRects().length > 0)`)) === !mobile, JSON.stringify(arows));
            // UI/UX's condition on #9050: when a narrow list drops its Team and Task columns, the row's hover and its preview still name the computer and still open the task
            const phone = await ev(`(async () => { const b = [...document.querySelectorAll('#group-table-view tbody .dt-primary')].find(x => /local-report/.test(x.textContent)); const hover = b ? b.title : ''; if (b) b.click(); for (let i = 0; i < 60 && !document.querySelector('.detail-facts'); i++) await new Promise(r => setTimeout(r, 100)); const facts = [...document.querySelectorAll('.detail-facts dt')].map(dt => [dt.textContent.trim(), dt.nextElementSibling.textContent.trim(), !!dt.nextElementSibling.querySelector('[data-task-link]')]); const tog = document.querySelector('.details-toggle:not([hidden])'), cnt = tog && tog.querySelector('.details-toggle-count:not([hidden])'); return { hover, facts, count: cnt ? cnt.textContent : '', named: tog ? tog.getAttribute('aria-label') || '' : '' }; })()`);
            check(`${label}: an artifact's hover (team · computer) and preview (Team, Computer) name the computer and a Task link, even where the columns are dropped`, /This computer/.test(phone.hover) && phone.facts.some(([k, v]) => k === 'Team' && v === 'alpha') && phone.facts.some(([k, v]) => k === 'Computer' && v === 'This computer') && phone.facts.some(([k, , link]) => k === 'Task' && link), JSON.stringify(phone));
            // UI/UX's condition (#9143): where the row dropped its Team and Task, the closed Details button counts the two facts it holds, and says so by name; where they are columns it says nothing
            check(`${label}: the preview's Details button ${mobile ? 'counts the 2 facts the row dropped' : 'has no count while the row shows Team and Task'}`, mobile ? phone.count === '2' && /2 facts/.test(phone.named) : phone.count === '' && phone.named === '', JSON.stringify([phone.count, phone.named]));
            await ev(`(document.querySelector('.detail-close') || document.body).click(); true`); await waitFor(`!document.querySelector('.detail-facts')`, `${label}: the preview closes`, 5000); await settle(300);
            const clipped = await ev(`(() => { const t = document.querySelector('#group-table-view table'); const heads = [...t.querySelectorAll('th')].map(h => h.textContent.trim()); const out = []; for (const name of ['Team', 'Computer']) { const i = heads.findIndex(h => h.startsWith(name)); if (i < 0) { out.push('no ' + name + ' column in ' + heads.join('/')); continue; } for (const r of t.querySelectorAll('tbody tr')) { const td = r.children[i]; if (td && td.getClientRects().length && [td, ...td.querySelectorAll('*')].some(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible')) out.push(name + ': ' + td.textContent.trim()); } } return out; })()`);
            const longTeam = await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(r => Math.round(r.getBoundingClientRect().height))`);
            check(`${label}: Artifacts rows are one line each: the Team and Computer cells do not wrap (the whole of both is the row's hover, #9408)`, longTeam.length >= 2 && longTeam.every(h => h <= (mobile ? 56 : 48)), JSON.stringify(longTeam));
            check(`${label}: Artifacts' Team and Computer cells are not cut at this width (alpha, This computer, Box Two stay whole); the Goal cell is the one line, cut with an ellipsis (#9274)`, clipped.length === 0, JSON.stringify(clipped));
            if (!mobile) {
                const cols = await ev(`(() => { const t = document.querySelector('#group-table-view table'), th = [...t.querySelectorAll('th')].find(h => /^Name/.test(h.textContent.trim())); return { name: Math.round(th.getBoundingClientRect().width), table: Math.round(t.getBoundingClientRect().width), heads: [...t.querySelectorAll('th')].map(h => h.textContent.replace(/[\\u2191\\u2193\\u2195]/g, '').trim()).filter(Boolean), cut: [...document.querySelectorAll('#group-table-view .dt-primary')].filter(b => b.scrollWidth > b.clientWidth + 1).map(b => b.textContent.trim()) }; })()`);
                check(`${label}: Artifacts' Name column has the room (at least 180 px, no file name cut) beside the team, its computer and the goal (#9408: the Computer column; the old Server column is not there)`, cols.name >= 180 && cols.cut.length === 0 && !cols.heads.includes('Server') && cols.heads.includes('Team') && cols.heads.includes('Computer'), JSON.stringify(cols));
            }
            await panel();
            const alabels = await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .list-bar-field-label')].filter(e => e.getClientRects().length).map(e => e.textContent.trim())`);
            check(`${label}: the Server filter stays in the Artifacts Filters panel while the Server column is hidden (UI/UX's condition on #8839)`, alabels.includes('Server'), JSON.stringify(alabels));
            const achoices = await teamChoices();
            check(`${label}: Artifacts' Team filter lists the two teams by their computer, each with its count`, achoices.filter(([v]) => v).length === 2 && achoices.some(([v, t]) => v === '@box-2/alpha' && /alpha · Box Two \(1\)/.test(t)) && achoices.some(([v, t]) => v === 'alpha' && /alpha · This computer \(1\)/.test(t)), JSON.stringify(achoices));
            if (!mobile) check(`${label}: Needs you's Team column tells the two alpha teams apart`, nteams && nteams.length === 2 && nteams[0] !== nteams[1] && nteams.some(t => /alpha.*This computer/.test(t)) && nteams.some(t => /alpha.*Box Two/.test(t)), JSON.stringify(nteams));
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Inbox team label checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
