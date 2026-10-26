// The team page's Agents tab (#7453, stage 2; UI/UX's doc 7aa984fe item 4, #7416's design as a tab): a group of status chips named "Show agents that are" with counts, a table of everyone on the board (Agent, Status,
// Doing, Provider, Remind) with a button "Remind <name>" on every row that opens the Remind dialog (Message prefilled, Repeat, Remind focused; UI/UX and the Orchestrator, board 09:16Z: it posts the @mention message now and, with a repeat, also sets the repeating reminder), a row opens the agent's own page (back link Agents, h2 with the name, Remind and Open chat in the bar);
// the health icon on the team's row opens this tab. Written failing-first by QA (#7499): by role and accessible name (helpers/team_page.js). Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, agentsUp, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const VIEWS = [['1280x800', 1280, 800, false], ['390x844', 390, 844, true]];
const TEAM = `qa-agents-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of VIEWS) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM); await agentsUp(ev);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM).catch(() => {});
            await S.run(`${label}: the Agents tab's name carries the count (2) and the tab opens a table with Agent, Status, Doing, Provider, Remind`, async () => {
                await goTab(ev, settle, 'Agents');
                const full = await ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === 'Agents'); return t ? window.__na.name(t) : ''; })()`);
                assert.ok(/Agents\s*[2-3]/.test(full), `the tab says Agents with its count (got ${JSON.stringify(full)})`);
                const hd = await ev(`window.__tp.headers()`); assert.ok(hd, 'the Agents tab has a table');
                if (!mobile) assert.deepEqual(hd.map(x => x.replace(/[↕↑↓]/g, '').trim()).slice(0, 5), ['Agent', 'Status', 'Doing', 'Provider', 'Remind'], 'the columns');
                const rows = await ev(`window.__tp.rows()`); assert.ok(rows.some(r => /Orchestrator/.test(r)) && rows.some(r => /Backend Dev/.test(r)), `both agents are rows (${JSON.stringify(rows.map(r => r.slice(0, 30)))})`);
            });
            await S.run(`${label}: no folder line and no Refresh button (the tab refreshes itself); the Orchestrator is the first row; Knowledge has no "0" badge`, async () => {
                const page = await ev(`window.__na.text(window.__tp.page())`);
                assert.equal(/ in \//.test(page) || /\b\d+ agents? (in|on) /.test(page), false, 'no "2 agents in /folder" line');
                assert.equal(await ev(`!!window.__tp.find('button', /^Refresh$/i)`), false, 'no Refresh button');
                const rows = await ev(`window.__tp.rows()`); assert.ok(await ev(`window.__tp.table().querySelector('.dt-primary').getAttribute('aria-label') === 'Orchestrator'`), `the Orchestrator is first (${JSON.stringify(rows.map(r => r.slice(0, 20)))})`);
                await goTab(ev, settle, 'Knowledge'); await settle(500);
                assert.equal(await ev(`(() => { const t = window.__tp.allTabs().find(x => window.__tp.tabLabel(x) === 'Knowledge'); return t ? window.__na.name(t) : null; })()`), 'Knowledge', 'the tab carries no 0');
                await goTab(ev, settle, 'Agents'); await settle(300);
            });
            await S.run(`${label}: a group named "Show agents that are" holds the status chips with counts, All pressed`, async () => {
                const c = await ev(`window.__tp.chips(/^Show agents that are$/i)`); assert.ok(c, 'a group named Show agents that are');
                assert.match(c[0].name, /^All\s*\d+$/, 'All with its count'); assert.equal(c[0].pressed, 'true', 'All is pressed');
                assert.ok(c.length >= 3, `at least All and two statuses (${JSON.stringify(c.map(x => x.name))})`); assert.ok(c.every(x => /\d+$/.test(x.name)), 'every chip has its count');
            });
            await S.run(`${label}: every row has a button named "Remind <name>", enabled, at least 44 px on a phone`, async () => {
                for (const n of ['Orchestrator', 'Backend Dev']) {
                    const b = await ev(`(() => { const e = [...window.__tp.table().querySelectorAll('button')].find(x => window.__na.name(x) === ${JSON.stringify('Remind ' + n)}); if (!e) return null; const r = e.getBoundingClientRect(); return { disabled: e.disabled || e.getAttribute('aria-disabled') === 'true', h: Math.round(r.height) }; })()`);
                    assert.ok(b, `a button named Remind ${n}`); assert.equal(b.disabled, false, `Remind ${n} is enabled`); if (mobile) assert.ok(b.h >= 44, `Remind ${n} is ${b.h} px high`);
                }
            });
            const dlg = n => `(() => { const d = [...document.querySelectorAll('[role=dialog]')].filter(window.__na.vis).find(x => window.__na.name(x).startsWith(${JSON.stringify('Remind ' + n)})); return d; })()`;
            const inDlg = (n, sel, rx) => `(() => { const d = ${dlg(n)}; return d ? [...d.querySelectorAll(${JSON.stringify(sel)})].filter(window.__na.vis).find(e => ${rx}.test(window.__na.name(e))) : null; })()`;
            const status = () => ev(`(() => { const e = [...document.querySelectorAll('[role=status]')].filter(window.__na.vis).map(x => window.__na.text(x).trim()).find(t => /^Reminded /.test(t)); return e || ''; })()`);
            await S.run(`${label}: Remind <name> opens a dialog named "Remind <name>" with the Message prefilled, Repeat on "Don't repeat" (30 minutes, hour, 4 hours, day), and "Remind" focused`, async () => {
                await ev(`(() => { const e = [...window.__tp.table().querySelectorAll('button')].find(x => window.__na.name(x) === 'Remind Backend Dev'); if (e) e.click(); return true; })()`); await settle(500);
                assert.ok(await ev(`!!${dlg('Backend Dev')}`), 'a dialog named Remind Backend Dev opens');
                const m = await ev(`(() => { const t = ${inDlg('Backend Dev', 'textarea', '/^Message$/i')}; return t ? t.value : null; })()`);
                assert.equal(m, 'Check your tasks and the board, then carry on.', 'the Message is prefilled');
                const rep = await ev(`(() => { const s = ${inDlg('Backend Dev', 'select', '/^Repeat$/i')}; return s ? { selected: s.options[s.selectedIndex].textContent.trim(), all: [...s.options].map(o => o.textContent.trim()) } : null; })()`);
                assert.ok(rep, 'a select named Repeat'); assert.match(rep.selected, /^Don.t repeat/i, `Repeat starts on Don't repeat (got ${rep.selected})`);
                for (const rx of [/30 min/i, /^(every )?(1 )?hour|every hour/i, /4 h/i, /day/i]) assert.ok(rep.all.some(x => rx.test(x)), `an option ${rx} in ${JSON.stringify(rep.all)}`);
                assert.ok(await ev(`(() => { const b = ${inDlg('Backend Dev', 'button', '/^Remind$/i')}; return !!b && document.activeElement === b; })()`), 'the Remind button has the focus, so Enter sends');
                assert.ok(await ev(`!!${inDlg('Backend Dev', 'button', '/^Cancel$/i')}`), 'a Cancel button');
            });
            await S.run(`${label}: Remind sends the message now as an @mention board message, the dialog closes and the status says "Reminded <name>." (no reminder is set)`, async () => {
                await ev(`window.__tp.record(); ${inDlg('Backend Dev', 'button', '/^Remind$/i')}.click(); true`); await settle(900);
                const sent = await ev(`window.__writes`);
                assert.ok(sent.some(x => x.m === 'POST' && /^\/api\/board\/[^/]+\/messages$/.test(x.p) && /@Backend Dev/.test(x.b) && /Check your tasks and the board/.test(x.b)), `a board message that @mentions Backend Dev (${JSON.stringify(sent.map(x => x.m + ' ' + x.p))})`);
                assert.ok(!sent.some(x => /\/reminder$/.test(x.p)), 'no repeating reminder is set when Repeat is Don\'t repeat');
                assert.equal(await ev(`!!${dlg('Backend Dev')}`), false, 'the dialog closed');
                assert.equal(await status(), 'Reminded Backend Dev.', 'a polite status says Reminded Backend Dev.');
            });
            await S.run(`${label}: with Repeat on every hour it also sets the repeating reminder (POST /api/board/<project>/reminder) and the status adds "and every hour"`, async () => {
                await ev(`(() => { const e = [...window.__tp.table().querySelectorAll('button')].find(x => window.__na.name(x) === 'Remind Orchestrator'); if (e) e.click(); return true; })()`); await settle(500);
                await ev(`(() => { const s = ${inDlg('Orchestrator', 'select', '/^Repeat$/i')}; const o = [...s.options].find(o => /^(every )?(1 )?hour|every hour/i.test(o.textContent.trim())); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                // the isolated server's agents have no running session, so it would refuse a repeating reminder: this scenario answers the reminder write itself
                await ev(`(() => { const R = window.fetch.bind(window); window.fetch = (u, o = {}) => (String((o && o.method) || 'GET').toUpperCase() === 'POST' && /\\/reminder$/.test(new URL(String(u), location.origin).pathname)) ? (window.__writes.push({ m: 'POST', p: new URL(String(u), location.origin).pathname, b: String(o.body || '') }), Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))) : R(u, o); return true; })()`);
                await ev(`window.__writes.length = 0; ${inDlg('Orchestrator', 'button', '/^Remind$/i')}.click(); true`); await settle(900);
                const sent = await ev(`window.__writes`);
                assert.ok(sent.some(x => x.m === 'POST' && /^\/api\/board\/[^/]+\/messages$/.test(x.p) && /@Orchestrator/.test(x.b)), `the board message (${JSON.stringify(sent.map(x => x.m + ' ' + x.p))})`);
                const rem = sent.find(x => /^\/api\/board\/[^/]+\/reminder$/.test(x.p)); assert.ok(rem, 'the repeating reminder is set'); assert.ok(/3600/.test(rem.b), `with an hour's interval (${rem.b})`);
                assert.equal(await status(), 'Reminded Orchestrator and every hour.', 'the status says and every hour');
            });
            await S.run(`${label}: Cancel in the Remind dialog sends nothing`, async () => {
                await ev(`window.__writes.length = 0; (() => { const e = [...window.__tp.table().querySelectorAll('button')].find(x => window.__na.name(x) === 'Remind Backend Dev'); if (e) e.click(); return true; })()`); await settle(500);
                await ev(`${inDlg('Backend Dev', 'button', '/^Cancel$/i')}.click(); true`); await settle(400);
                assert.equal((await ev(`window.__writes`)).length, 0, 'nothing was sent'); assert.equal(await ev(`!!${dlg('Backend Dev')}`), false, 'the dialog closed');
            });
            await S.run(`${label}: an agent's row opens its page: back link Agents, h2 with the name, buttons Remind and Open chat; Back puts the focus on the row`, async () => {
                await ev(`(() => { const b = [...window.__tp.table().querySelectorAll('button, a')].find(x => window.__na.name(x) === 'Backend Dev'); if (b) b.click(); return true; })()`); await settle(400);
                assert.ok(await ev(`(() => { const e = [...window.__tp.page().querySelectorAll('h2')].find(window.__na.vis); return !!e && /Backend Dev/.test(window.__na.text(e)); })()`), 'the agent page h2 names the agent');
                for (const rx of ['/^(\\u2190\\s*)?Agents$/', '/^Remind/', '/^Open chat$/']) assert.ok(await ev(`!!window.__tp.find('button, a', ${rx})`), `a control named ${rx}`);
                assert.equal(await ev(`window.__tp.pane() === null`), true, 'no Details pane for an agent');
                await ev(`(() => { const b = window.__tp.find('button, a', /^(\\u2190\\s*)?Agents$/); if (b) b.click(); return true; })()`); await settle(300);
                assert.ok(await ev(`document.activeElement && /Backend Dev/.test(window.__na.text(document.activeElement))`), 'the focus is on the agent row');
            });
            await S.run(`${label}: the health icon on the team's row opens this tab (a button named "Team health: ...")`, async () => {
                await goTab(ev, settle, 'Goals');
                assert.ok(await ev(`(() => { const s = window.__tp.sidebar() || document; const b = [...s.querySelectorAll('button, [role=button]')].filter(window.__na.vis).find(x => /^Team health/i.test(window.__na.name(x))); if (!b) return false; b.click(); return true; })()`), 'no button named Team health');
                await settle(400); assert.equal(await ev(`(() => { const t = window.__tp.tabs().find(x => x.getAttribute('aria-selected') === 'true'); return t ? window.__tp.tabLabel(t) : ''; })()`), 'Agents', 'the Agents tab is selected');
            });
        }
        await removeBoards(ev, [TEAM]); S.finish(); // finish() exits the process, so the board goes first
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
