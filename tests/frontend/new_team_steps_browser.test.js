// New team is three steps (the team launch redesign, #7407; UI/UX's final v4 doc ad146b3a, mockup 25717f66), written failing-first by QA (#7415): 1 Name and where it launches (Team name and Folder required in words and
// aria-required, Recent: chips, Machine only with several machines with "Another computer's address..." as its last entry revealing the address, the git worktree with its base branch only for a git folder), 2 Members
// (Start from a template with its More menu, quiet read-only member rows named "Edit <role>: <provider>, <model>", "Gets the first task" on the first, an actions menu per row, Add member, Undo after Remove), 3 Start and
// team settings (a tablist Start, Workflow, Health check, Messaging; recap; Launch team). Cancel leftmost and the primary rightmost; Next says why it is off. Controls by role and name (helpers/new_team.js). 1280 px.
const assert = require('node:assert/strict');
const { execFileSync } = require('./helpers/child_process.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { install: installNT, N, T, stepLine, openNewTeam, scenarios, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios(); const t = T(ev, waitFor);
    const gitDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'qa-team-git-')); execFileSync('git', ['init', '-q', gitDir]);
    const names = (sel, within = N.team) => ev(`(() => { const d = window.__nt.dlg(${within}); return d ? [...d.querySelectorAll(${JSON.stringify(sel)})].filter(window.__na.vis).map(e => window.__na.name(e)) : []; })()`);
    const footer = async (primary, label) => {
        const b = await ev(`window.__nt.buttons(window.__nt.dlg(${N.team}))`);
        const cancel = b.find(x => N.cancel.test(x.name)), prim = b.find(x => primary.test(x.name));
        assert.ok(cancel && prim, `${label}: Cancel and ${primary} are in the footer`);
        for (const x of b.filter(y => /^(Back|Next|Launch team)$/i.test(y.name))) assert.ok(cancel.x < x.x, `${label}: Cancel (x ${cancel.x}) is left of ${x.name} (x ${x.x})`);
        for (const x of b.filter(y => /^(Cancel|Back)$/i.test(y.name))) assert.ok(prim.x >= x.x, `${label}: ${prim.name} is the rightmost`);
        assert.ok(Math.abs(cancel.y - prim.y) < 4, `${label}: one row`);
    };
    const reopen = async () => { await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`); await settle(200); await openNewTeam(ev, waitFor); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNT(ev); await stubModels(ev);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app', '/work/website', '/work/docs'])); true`);
        await openNewTeam(ev, waitFor);

        await S.run('the dialog is a role=dialog named exactly "New team" and opens on "Step 1 of 3: Name and where it launches"', async () => {
            assert.ok(await ev(`!!window.__nt.dlg(${N.team})`), 'no role=dialog named "New team"');
            assert.match(await stepLine(ev), /^Step 1 of 3: Name and where it launches/);
        });
        await S.run('step 1: Team name and Folder say Required in words and aria-required, Browse, Cancel and Next, no Back, no tabs, no Machine with one machine, no Launch', async () => {
            for (const [sel, rx, what] of [['input', N.teamName, 'Team name'], ['input', N.folder, 'Folder']]) {
                assert.ok(await t.has(sel, rx), `${what} field`);
                assert.ok(await ev(`(() => { const i = window.__nt.find(window.__nt.dlg(${N.team}), ${JSON.stringify(sel)}, ${rx}); return i.required || i.getAttribute('aria-required') === 'true' || /required/i.test(window.__na.name(i)); })()`), `${what} is marked required (aria-required, required, or in its name)`);
            }
            assert.match(await ev(`window.__na.text(window.__nt.dlg(${N.team}))`), /Required/, 'the word Required is on the page');
            assert.ok(await t.has('button', /^Browse/i), 'Browse');
            for (const rx of [N.cancel, N.next]) assert.ok(await t.has('button', rx), `${rx}`);
            for (const rx of [N.back, N.launch]) assert.ok(!(await t.has('button', rx)), `no ${rx} on step 1`);
            assert.ok(!(await t.has('select', N.machine)), 'no Machine select with one machine');
            assert.ok(!(await ev(`!![...window.__nt.dlg(${N.team}).querySelectorAll('[role=tablist]')].filter(window.__na.vis).length`)), 'no tabs on step 1');
        });
        await S.run('step 1: the three recent folders are a group named "Recent folders" that starts with "Recent:", and pressing one fills the folder', async () => {
            const g = await ev(`(() => { const d = window.__nt.dlg(${N.team}); const g = [...d.querySelectorAll('[role=group]')].filter(window.__na.vis).find(e => ${N.recents}.test(window.__na.name(e))); return g ? { text: window.__na.text(g), b: [...g.querySelectorAll('button')].map(x => window.__na.text(x)) } : null; })()`);
            assert.ok(g, 'a role=group named "Recent folders"'); assert.match(g.text, /^Recent:/); assert.deepEqual(g.b, ['payments-app', 'website', 'docs']);
            await t.click('button', /^payments-app$/);
            assert.equal(await ev(`window.__nt.find(window.__nt.dlg(${N.team}), 'input', ${N.folder}).value`), '/work/payments-app');
        });
        await S.run('step 1: Next is always on; pressing it with something missing says the first thing wrong on one red line (and under the field), nothing before the first press', async () => {
            await reopen();
            const state = () => ev(`(() => { const d = window.__nt.dlg(${N.team}); const b = window.__nt.find(d, 'button', ${N.next}); const live = window.__na.text(document.getElementById('team-recap')); const first = document.getElementById('team-board-name'); return { off: b.disabled || b.getAttribute('aria-disabled') === 'true', live, errors: [...d.querySelectorAll('.sv-error')].filter(e => !e.hidden).map(e => e.textContent), focus: document.activeElement === first }; })()`);
            await t.type('input', N.teamName, ''); await t.type('input', N.folder, '');
            let s = await state(); assert.ok(!s.off, 'Next is on'); assert.equal(s.live, '', 'nothing is said before the first press'); assert.deepEqual(s.errors, []);
            await t.click('button', N.next); s = await state();
            assert.ok(!s.off && s.focus, 'Next stays on and the name takes the focus'); assert.match(s.live, /Team name is required/, 'one line names the first thing wrong'); assert.deepEqual(s.errors, ['Team name is required', 'Choose a folder for the team']);
            await t.type('input', N.teamName, 'alpha'); s = await state(); assert.match(s.live, /Choose a folder for the team/);
            await t.type('input', N.teamName, ''); await t.type('input', N.folder, '/work/payments-app'); s = await state(); assert.match(s.live, /Team name is required/);
            await t.click('button', N.next); assert.match(await stepLine(ev), /^Step 1 of 3/, 'Next does not advance');
        });
        await S.run('step 1: a machine select named "Machine" with several machines, "Another computer\'s address..." as its last entry, and choosing it reveals the address field', async () => {
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); T.state.hub = true; T.state.cloud = false; T.state.serversKnown = true; T.state.servers = [{ id: 'm1', label: 'build-server', status: 'online', version: '1.4.6', last_seen: new Date().toISOString() }]; true`);
            await openNewTeam(ev, waitFor);
            assert.ok(await t.has('select', N.machine), 'a select named exactly Machine');
            const opts = await ev(`[...window.__nt.find(window.__nt.dlg(${N.team}), 'select', ${N.machine}).options].map(o => o.textContent.trim())`);
            assert.match(opts[opts.length - 1], /^Another computer's address/, `the last entry is Another computer's address... (${JSON.stringify(opts)})`);
            assert.ok(!(await t.has('input', N.address)), 'the address field is not shown until chosen');
            await t.pick(N.machine, /^Another computer/); await settle(200);
            assert.ok(await t.has('input', N.address), 'the address field after choosing it');
            await ev(`window.hideLaunchModal(); T.state.servers = []; T.state.hub = false; T.state.cloud = false; true`);
            await openNewTeam(ev, waitFor); assert.ok(!(await t.has('select', N.machine)), 'no Machine select with this computer alone');
        });
        await S.run('step 1: "Launch in a git worktree" with a Base branch appears only for a git folder', async () => {
            await reopen();
            await t.type('input', N.folder, '/tmp/qa-not-a-repo'); await settle(600);
            assert.ok(!(await t.has('input', /worktree/i)), 'no worktree option for a folder that is not a git repository');
            await t.type('input', N.folder, gitDir);
            await waitFor(`!!window.__nt.find(window.__nt.dlg(${N.team}), 'input', /worktree/i)`, 'the worktree option for a git folder', 6000);
            await ev(`window.__nt.find(window.__nt.dlg(${N.team}), 'input', /worktree/i).click(); true`); await settle(200);
            assert.ok(await t.has('input', /base branch/i), 'Base branch appears when the worktree is ticked');
        });
        await S.run('step 1 footer: Cancel leftmost, Next rightmost, one row', async () => { await reopen(); await t.type('input', N.teamName, 'alpha'); await t.type('input', N.folder, '/work/payments-app'); await footer(N.next, 'step 1'); });

        await S.run('step 2 is "Step 2 of 3: Members": a template select ("Blank team" first, templates with their member counts), a More menu, Add member, Back, Cancel, Next, no tabs', async () => {
            await reopen(); await t.to(2);
            assert.match(await stepLine(ev), /^Step 2 of 3: Members/);
            const o = await ev(`[...window.__nt.find(window.__nt.dlg(${N.team}), 'select', ${N.template}).options].map(o => o.textContent.trim())`);
            assert.match(o[0], /^Blank team/); assert.ok(o.slice(1).some(x => /\(\d+ members?\)/.test(x)), `templates show their member counts (${JSON.stringify(o)})`);
            assert.ok(await t.has('button', /^More/i), 'a More menu button');
            for (const rx of [N.addMember, N.back, N.cancel, N.next]) assert.ok(await t.has('button', rx), `${rx}`);
            await footer(N.next, 'step 2');
        });
        await S.run('step 2: the More menu holds Generate with AI, Import a template, Import from a folder, Save this team as a template', async () => {
            await t.click('button', /^More/i); await settle(200);
            const items = await names('[role=menuitem]');
            for (const want of [/Generate with AI/i, /Import a template/i, /Import from a folder/i, /Save this team as a template/i]) assert.ok(items.some(x => want.test(x)), `${want} in ${JSON.stringify(items)}`);
            await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`); await settle(150);
        });
        await S.run('step 2: a template fills the members as quiet read-only rows named "Edit <role>: <provider>, <model>", "Gets the first task" on the first only', async () => {
            assert.ok(await t.pick(N.template, /Coding|\(\d+ members\)/), 'a template to choose');
            await waitFor(`window.__nt.rows(window.__nt.dlg(${N.team})).length >= 2`, 'the template fills the members', 5000);
            const rows = await ev(`window.__nt.rows(window.__nt.dlg(${N.team})).map(b => ({ name: window.__na.name(b), text: window.__na.text(b), inputs: b.querySelectorAll('input, select, textarea').length }))`);
            for (const r of rows) { assert.match(r.name, /^Edit .+: .+, .+/, `row name: ${r.name}`); assert.equal(r.inputs, 0, `${r.name}: nothing to type or choose in a row`); }
            assert.equal(rows.filter(r => /Gets the first task/.test(r.text)).length, 1, 'exactly one row says "Gets the first task"');
            assert.match(rows[0].text, /Gets the first task/, 'and it is the first');
            assert.match(rows[0].name, /^Edit Orchestrator: /, 'the template\'s first member is the Orchestrator');
        });
        await S.run('step 2: each row has an "Actions for <role>" menu button (aria-haspopup, aria-expanded) with Edit member, Move up, Move down, Remove; the first has no Move up, and the Orchestrator has no Remove', async () => {
            const roles = await ev(`window.__nt.roles(window.__nt.dlg(${N.team}))`);
            const open = async (role) => { await ev(`(() => { const d = window.__nt.dlg(${N.team}); const b = [...d.querySelectorAll('button')].find(x => window.__na.name(x) === ${JSON.stringify('Actions for ' + '')} + ${JSON.stringify(role)}); if (!b) return false; b.click(); return true; })()`); await settle(150); return names('[role=menuitem]'); };
            const btn = await ev(`(() => { const d = window.__nt.dlg(${N.team}); const b = [...d.querySelectorAll('button')].find(x => window.__na.name(x) === 'Actions for ' + ${JSON.stringify(roles[0])}); return b ? { popup: b.getAttribute('aria-haspopup'), expanded: b.getAttribute('aria-expanded') } : null; })()`);
            assert.ok(btn, 'an Actions for <role> button on the first row'); assert.ok(btn.popup, 'aria-haspopup'); assert.equal(btn.expanded, 'false');
            let items = await open(roles[0]);
            assert.ok(items.includes('Edit member') && items.includes('Move down'), `first row menu: ${JSON.stringify(items)}`);
            assert.ok(!items.includes('Move up'), 'the first member cannot move up'); assert.ok(!items.includes('Remove'), 'the Orchestrator cannot be removed');
            await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`); await settle(150);
            items = await open(roles[roles.length - 1]);
            for (const w of ['Edit member', 'Move up', 'Remove']) assert.ok(items.includes(w), `${w} in ${JSON.stringify(items)}`);
            await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`); await settle(150);
        });
        await S.run('step 2: Remove takes a member away and an Undo line brings it back (said in the polite status)', async () => {
            const before = await ev(`window.__nt.roles(window.__nt.dlg(${N.team}))`);
            const last = before[before.length - 1];
            await ev(`(() => { const d = window.__nt.dlg(${N.team}); [...d.querySelectorAll('button')].find(x => window.__na.name(x) === 'Actions for ' + ${JSON.stringify(last)}).click(); return true; })()`); await settle(150);
            await ev(`[...window.__nt.dlg(${N.team}).querySelectorAll('[role=menuitem]')].find(x => window.__na.name(x) === 'Remove').click(); true`); await settle(250);
            assert.equal((await ev(`window.__nt.roles(window.__nt.dlg(${N.team}))`)).length, before.length - 1, 'one member fewer');
            assert.ok(await t.has('button', /^Undo/i), 'an Undo button');
            assert.match(await ev(`[...window.__nt.dlg(${N.team}).querySelectorAll('[aria-live=polite],[role=status]')].map(e => window.__na.text(e)).join(' | ')`), new RegExp('Removed|Undo', 'i'), 'the polite status says it');
            await t.click('button', /^Undo/i); await settle(250);
            assert.deepEqual(await ev(`window.__nt.roles(window.__nt.dlg(${N.team}))`), before, 'Undo restores the member in its place');
        });
        await S.run('step 3 is "Step 3 of 3: Start and team settings": a vertical tablist Start, Workflow, Health check, Messaging (Start open), recap above Back, Cancel and Launch team, no Next', async () => {
            await t.click('button', N.next); await t.step(3);
            assert.match(await stepLine(ev), /^Step 3 of 3: Start and team settings/);
            const tabs = await ev(`(() => { const tl = window.__nt.tablist(window.__nt.dlg(${N.team})); return tl ? { o: tl.getAttribute('aria-orientation'), t: [...tl.querySelectorAll('[role=tab]')].filter(window.__na.vis).map(x => ({ n: window.__na.name(x), s: x.getAttribute('aria-selected') })) } : null; })()`);
            assert.ok(tabs, 'a role=tablist'); assert.deepEqual(tabs.t.map(x => x.n), N.tabs); assert.equal(tabs.t[0].s, 'true', 'Start is the open tab');
            for (const rx of [N.back, N.cancel, N.launch]) assert.ok(await t.has('button', rx), `${rx}`);
            assert.ok(!(await t.has('button', N.next)), 'no Next on step 3'); await footer(N.launch, 'step 3');
            assert.match(await ev(`window.__na.text(window.__nt.dlg(${N.team}))`), /alpha: \d+ members?, \/work\/payments-app/, 'the recap: "<team>: N members, <folder>"');
        });
        await S.run('step 3 Start: What should the team work on? and Additional instructions; no team-wide Mode or Provider anywhere in the dialog', async () => {
            for (const rx of [/^What should the team work on/i, /^Additional instructions/i]) assert.ok(await t.has('textarea', rx), `${rx}`);
            assert.ok(!(await ev(`!!window.__nt.find(window.__nt.dlg(${N.team}), 'select, [role=radiogroup]', /^(Mode|Permission mode|Provider)$/i)`)), 'no team-wide Mode or Provider (each member has its own)');
        });
        S.finish();
    } finally { try { fs.rmSync(gitDir, { recursive: true, force: true }); } catch { /* gone */ } await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
