// The sectioned dialogs (#4950): Restart, New Agent, Agent Team and the team's agent dialog are the Settings dialog's shell: a section list with icons on the left, the open section's heading and
// one-line description over its fields, a fixed footer with the primary action; on a phone the list is a selector at the top. Every field is reachable by clicking through the sections, the values stay
// when the person moves between sections, the arrow keys move in the list, a problem found on Launch opens its section and marks it, and nothing scrolls sideways. Drives Chrome over CDP through
// agent_view_harness.js against the isolated dev server; every request is answered by the test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    // (a capture on the emulated phone scrolled the pane by itself mid-shot, which cut a heading in the evidence: nothing is focused and the panes cannot scroll while it is taken)
    const shot = async (name, { keepFocus = false } = {}) => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await ev(`${keepFocus ? '' : 'document.activeElement && document.activeElement.blur();'} document.querySelectorAll('.settings-panes').forEach(b => { b.style.overflow = 'hidden'; }); true`); await new Promise(r => setTimeout(r, 350)); /* sleep-ok: the list's highlight is a transition: a shot taken at once shows the old and the new section both lit */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); await ev(`document.querySelectorAll('.settings-panes').forEach(b => { b.style.overflow = ''; }); true`); };
    const key = async (k, code, vk) => { const b = { key: k, code, windowsVirtualKeyCode: vk }; await Input.dispatchKeyEvent({ type: 'keyDown', ...b }); await Input.dispatchKeyEvent({ type: 'keyUp', ...b }); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const open = async (w, mobile) => {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`(async () => {
                window.__reqs = [];
                const real = window.fetch; const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href), m = o.method || 'GET';
                    if (m === 'POST' && /^\\/api\\/sessions\\/(launch|launch-team|live\\/[^/]+\\/restart)$/.test(p.pathname)) { window.__reqs.push({ path: p.pathname, body: JSON.parse(o.body) }); return json({ session_name: 'x', session_id: 'sid', agents: [{ name: 'A', session_id: 's' }] }); }
                    if (p.pathname === '/api/board/projects') return json([{ project: 'taken' }]);
                    if (p.pathname === '/api/filesystem/is-git') return json({ is_git: true });
                    return real(u, o); };
                await window.showLaunchModal(); window.hideLaunchModal(); return true; })()`);
        };
        const vis = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && e.getClientRects().length > 0; })()`;
        // The state of a sectioned dialog: its list (names, icons, the open one), the open pane's heading and description, the footer.
        const view = root => ev(`(() => { const m = document.querySelector(${JSON.stringify(root)}); const tabs = [...m.querySelectorAll('.settings-tabs [role=tab]')];
            const pane = [...m.querySelectorAll('.settings-pane[data-section]')].find(p => !p.hidden);
            const sel = m.querySelector('.settings-group-pick select'); const shown = e => !!e && e.getClientRects().length > 0;
            const foot = m.querySelector('.modal-footer, .modal-actions'); const content = m.closest('.modal-content') || m.querySelector('.modal-content');
            return { tabs: tabs.map(t => ({ name: t.querySelector('.settings-tab-name').textContent, icon: t.querySelector('.material-icons').textContent, on: t.getAttribute('aria-selected') === 'true', err: t.dataset.error === '1' })),
                listShown: shown(m.querySelector('.settings-tabs')), pickShown: shown(sel), pick: sel && sel.value, open: pane && pane.dataset.section, title: pane && pane.querySelector('.settings-pane-title').textContent, desc: pane && pane.querySelector('.settings-pane-sub').textContent,
                panesVisible: [...m.querySelectorAll('.settings-pane[data-section]')].filter(p => shown(p)).length, footBottom: foot && Math.round(foot.getBoundingClientRect().bottom), contentBottom: Math.round(content.getBoundingClientRect().bottom), footShown: shown(foot),
                overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
        // The pane's highest scroll over the next second: a card scrolled into view animates (smooth), so one look right after opening sees nothing.
        const topStays = async root => { let max = 0; for (let i = 0; i < 20; i++) { max = Math.max(max, await ev(`document.querySelector('${root} .settings-panes').scrollTop`)); await new Promise(r => setTimeout(r, 50)); } return max; }; // sleep-ok: watching an animation that has no completion event
        const go = (root, id) => ev(`(() => { const m = document.querySelector(${JSON.stringify(root)}); const t = [...m.querySelectorAll('.settings-tabs [role=tab]')].find(x => x.dataset.section === ${JSON.stringify(id)}); if (getComputedStyle(m.querySelector('.settings-tabs')).display !== 'none') t.click(); else { const s = m.querySelector('.settings-group-pick select'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
        const session = { name: 'ag', display_name: 'QA Engineer', session_id: 'sid-r', type: 'live', agent_type: 'claude', model: 'claude-opus-4', prompt: 'Be kind.\nAlways.', capabilities: { allow: ['file_read'] }, tmux_session: 'ag' };

        console.log('Restart: two steps (the persona, then the agent), the fixed footer, and every field reached');
        const stage = () => ev(`(() => { const w = document.getElementById('restart-wizard'); const vis = id => { const e = document.getElementById(id); return !!e && !e.hidden && getComputedStyle(e).display !== 'none'; }; return { stage: w.dataset.stage, sub: document.getElementById('restart-stage-sub').textContent, back: vis('restart-back'), next: vis('restart-next'), go: vis('restart-go') }; })()`);
        const step = arg => ev(`document.getElementById(${JSON.stringify(arg === 'next' ? 'restart-next' : 'restart-back')}).click(); true`);
        await open(1440, false);
        await ev(`T.state.currentSession = ${JSON.stringify(session)}; window.restartSession(); true`);
        await waitFor(`${vis('#restart-acf .acf-prompt')} && !!document.querySelector('#restart-acf .acf-agent-type')`, 'the restart dialog');
        let st = await stage();
        assert.deepEqual(st, { stage: 'persona', sub: 'Step 1 of 2: Persona', back: false, next: true, go: false }, 'it opens on the persona: Next, and no Restart until the person has clicked it (#7779)');
        assert.equal(await ev(vis('#restart-modal .settings-tabs')), false, 'the list of sections is for step 2');
        assert.equal(await ev(`document.getElementById('restart-stage-sub').textContent`), 'Step 1 of 2: Persona', 'one line under the title, as New Agent has: the step and its name');
        assert.equal(await ev(`document.querySelector('#restart-acf .acf-restart-name').textContent`), 'QA Engineer');
        assert.equal(await ev(`document.querySelector('#restart-acf .acf-prompt').value`), 'Be kind.\nAlways.', 'the prompt is there to read and edit');
        assert.ok(await ev(`document.querySelector('#restart-acf .acf-prompt').getBoundingClientRect().height > 200`), 'with room');
        await shot('restart-persona-desktop');
        await ev(`{ const p = document.querySelector('#restart-acf .acf-prompt'); p.value = 'Edited prompt'; p.dispatchEvent(new Event('input', { bubbles: true })); } true`);
        await step('next');
        st = await stage();
        assert.deepEqual(st, { stage: 'agent', sub: 'Step 2 of 2: Settings', back: true, next: false, go: true });
        let v = await view('#restart-modal');
        assert.deepEqual(v.tabs.map(t => [t.name, t.icon]), [['Model', 'smart_toy'], ['Permissions', 'lock'], ['Advanced', 'tune']], 'the agent is fixed: no Agent step, the tabs are Model, Permissions, Advanced');
        assert.equal(v.open, 'agent'); assert.equal(v.panesVisible, 1, 'one section at a time'); assert.equal(v.title, 'Model'); assert.equal(v.desc, '', 'no pane sub-title (#6012)');
        assert.ok(v.listShown && !v.pickShown, 'a wide dialog has the list, not the selector');
        assert.equal(v.footShown && v.footBottom <= v.contentBottom, true, 'the footer is inside the dialog, at its bottom');
        // the provider is New Agent's own picker (#8973): the four radios, the agent's own checked, the select behind it enabled; picking another provider is a switch the restart carries
        const pick = await ev(`(() => { const g = document.querySelector('#restart-acf .acf-agent-pick'); return g ? { shown: !g.hidden, role: g.getAttribute('role'), radios: [...g.querySelectorAll('input')].map(i => [i.value, i.checked]), disabled: document.querySelector('#restart-acf .acf-agent-type').disabled, fixedLine: !!document.querySelector('#restart-acf .acf-provider-fixed') } : null; })()`);
        assert.ok(pick && pick.shown && pick.role === 'radiogroup', 'the provider picker is there: ' + JSON.stringify(pick));
        assert.deepEqual(pick.radios, [['claude', true], ['codex', false], ['agy', false], ['pi', false]], 'the four providers, the agent\'s own chosen');
        assert.equal(pick.disabled, false, 'the provider can be changed'); assert.equal(pick.fixedLine, false, 'no "launch a new agent" line');
        await ev(`document.querySelector('#restart-acf .acf-agent-pick input[value="codex"]').click(); true`);
        assert.equal(await ev(`window.getAgentConfig('restart-acf').agentType`), 'codex', 'the restart carries the new provider');
        await ev(`document.querySelector('#restart-acf .acf-agent-pick input[value="claude"]').click(); true`);
        await shot('restart-agent-desktop');
        await go('#restart-modal', 'permissions'); await shot('restart-permissions-desktop');
        // Claude in Bypass Permissions mode never asks, so Allow pre-approves nothing and its row is not shown (UI audit #5589); any other mode shows it.
        if (await ev(`document.querySelector('#restart-acf .acf-permission-mode').value === 'bypassPermissions'`)) {
            assert.equal(await ev(vis('#restart-acf [data-type="allow"][data-cap="shell"]')), false, 'Bypass Permissions: no Allow row');
            await ev(`{ const m = document.querySelector('#restart-acf .acf-permission-mode'); m.value = 'default'; m.dispatchEvent(new Event('change', { bubbles: true })); } true`);
        }
        assert.ok(await ev(vis('#restart-acf .seg-modes')), 'the mode is shown as cards');
        assert.equal(await ev(`document.querySelector('#restart-acf .acf-tools-details').open`), false, 'the tool chips are in a closed disclosure');
        assert.match(await ev(`document.querySelector('#restart-acf .acf-perms-summary').textContent`), /^\d+ allowed, \d+ denied$/, 'whose summary counts them');
        await ev(`document.querySelector('#restart-acf .acf-tools-details').open = true; true`);
        assert.ok(await ev(vis('#restart-acf [data-type="allow"][data-cap="shell"]')) && await ev(vis('#restart-acf [data-type="deny"][data-cap="web_access"]')), 'open, allow and deny are shown');
        await ev(`document.querySelector('#restart-acf [data-type="allow"][data-cap="shell"]').click(); true`);
        assert.ok(await ev(vis('#restart-acf .perms-shell-input')), 'the shell patterns box appears with Shell');
        await go('#restart-modal', 'advanced'); assert.ok(await ev(vis('#restart-acf .acf-flags')));
        await ev(`{ const f = document.querySelector('#restart-acf .acf-flags'); f.value = '--verbose'; f.dispatchEvent(new Event('input', { bubbles: true })); } true`);
        await go('#restart-modal', 'agent');
        await step('back');
        assert.equal((await stage()).stage, 'persona');
        assert.equal(await ev(`document.querySelector('#restart-acf .acf-prompt').value`), 'Edited prompt', 'values stay when the steps change');
        await step('next');
        assert.equal(await ev(`document.querySelector('#restart-acf .acf-flags').value`), '--verbose');
        assert.equal(await ev(`document.querySelector('#restart-acf [data-type="allow"][data-cap="shell"]').classList.contains('active')`), true);

        console.log('Restart: keys in the list');
        await ev(`document.getElementById(document.querySelector('#restart-modal .settings-tabs [aria-selected=true]').id).focus(); true`);
        await key('ArrowDown', 'ArrowDown', 40);
        assert.equal((await view('#restart-modal')).open, 'permissions', 'ArrowDown opens the next section');
        await key('End', 'End', 35); assert.equal((await view('#restart-modal')).open, 'advanced');
        await key('ArrowDown', 'ArrowDown', 40); assert.equal((await view('#restart-modal')).open, 'agent', 'it wraps');
        await key('ArrowUp', 'ArrowUp', 38); assert.equal((await view('#restart-modal')).open, 'advanced');
        await key('Home', 'Home', 36); assert.equal((await view('#restart-modal')).open, 'agent');
        assert.equal(await ev(`document.activeElement.getAttribute('role')`), 'tab', 'the keyboard stays in the list');
        assert.equal(await ev(`[...document.querySelectorAll('#restart-modal .settings-tabs [role=tab]')].map(t => t.tabIndex).join()`), '0,-1,-1', 'only the open section is a tab stop');
        const tp = await ev(`(() => { const t = document.querySelector('#restart-modal .settings-tabs [aria-selected=true]'); const p = document.getElementById(t.getAttribute('aria-controls')); return [p.getAttribute('role'), p.getAttribute('aria-labelledby') === t.id]; })()`);
        assert.deepEqual(tp, ['tabpanel', true], 'the pane is a tab panel named by its tab');
        await key('Escape', 'Escape', 27);
        await waitFor(`getComputedStyle(document.getElementById('restart-modal')).display === 'none'`, 'Escape closes the dialog');

        console.log('Restart on a phone: the selector at the top, 44 px, nothing sideways');
        await open(390, true);
        await ev(`T.state.currentSession = ${JSON.stringify(session)}; window.restartSession(); true`);
        await waitFor(`!!document.querySelector('#restart-acf .acf-agent-type') && ${vis('#restart-acf .acf-prompt')}`, 'the phone restart dialog');
        v = await view('#restart-modal');
        assert.equal(v.overflow, 0); assert.equal(v.footShown && v.footBottom <= v.contentBottom, true, 'the footer stays in view');
        assert.deepEqual(await ev(`(() => { const e = document.getElementById('restart-stage-sub'); const cs = getComputedStyle(e); return [e.getClientRects().length > 0, cs.fontSize, cs.fontWeight]; })()`), [true, '12px', '400'], 'Restart on a phone: the step line is under the title, 12/400 (#7912)');
        await shot('restart-persona-phone');
        await step('next');
        v = await view('#restart-modal');
        assert.ok(v.pickShown && !v.listShown, 'the selector, not the list'); assert.equal(v.overflow, 0);
        assert.equal(await ev(`[...document.querySelectorAll('#restart-acf .acf-agent-pick .launch-agent-opt')].every(l => l.getBoundingClientRect().height >= 44)`), true, 'the provider choices are touch targets');
        await shot('restart-agent-phone');
        assert.equal(await ev(`[...document.querySelectorAll('#restart-modal .settings-group-pick select, #restart-modal .modal-footer .btn')].filter(e => e.getBoundingClientRect().width).every(e => e.getBoundingClientRect().height >= 44)`), true, 'targets of 44 px');
        await go('#restart-modal', 'permissions'); v = await view('#restart-modal'); assert.equal(v.open, 'permissions'); assert.equal(v.pick, 'permissions');
        assert.equal(v.footShown && v.footBottom <= v.contentBottom, true, 'the footer stays in view');
        await shot('restart-permissions-phone');
        assert.equal((await view('#restart-modal')).overflow, 0, 'nothing sideways on the phone');

        const names = root => view(root).then(v => v.tabs.map(t => [t.name, t.icon]));
        const dot = async (root, name) => (await view(root)).tabs.find(t => t.name === name).err;
        const openAgent = async () => {
            await ev(`window.showLaunchModal(); window._selectLaunchType('agent'); true`);
            await waitFor(`${vis('#launch-step-agent')} && !!document.querySelector('#launch-agent-acf .acf-agent-type') && document.getElementById('launch-board-select').options.length > 2`, 'the New Agent dialog');
        };
        const click = sel => ev(`document.querySelector(${JSON.stringify(sel)}).click(); true`);
        const fillId = (id, v) => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

        // New Agent's steps, tabs, keys and independence are new_agent_steps, new_agent_dialog_size, new_agent_keyboard and new_agent_independence (#7391, #7392); what stays here is Restart's tabs and the Agent Team dialogs.
        // New team's three steps, its keys and its size are new_team_steps, new_team_keyboard and new_team_dialog_size (#7407, #7415); what stays here is the member dialog's sections.
        await open(1440, false);
        console.log('The team agent dialog');
        await ev(`window.showLaunchModal(); window._selectLaunchType('team'); window.showTeamAgentModal(); true`);
        await waitFor(`${vis('#launch-agent-name-input')} && !!document.querySelector('#launch-agent-acf .acf-agent-type')`, 'the member dialog on its role');
        const TA = '#launch-step-agent'; // the member is the agent step of the Launch dialog in a second mode (#7861): the role and prompt are its persona step, the tabs are Agent, Permissions, Advanced
        assert.deepEqual(await names(TA), [['Agent', 'smart_toy'], ['Permissions', 'lock'], ['Advanced', 'tune']]);
        assert.equal(await ev(`document.getElementById('launch-step-agent').dataset.stage`), 'persona', 'a new member opens on its role');
        await ev(`window._launchStage('agent'); true`);
        // The agent form fills in after it opens (the models arrive and it is drawn again), which can replace the name field the problem was marked on: Save is pressed again until the empty name has the focus.
        await waitFor(`(() => { if (document.activeElement.id === 'launch-agent-name-input') return true; document.getElementById('launch-agent-save').click(); return false; })()`, 'the empty name focused');
        assert.equal(await ev(`document.getElementById('launch-step-agent').dataset.stage`), 'persona', 'Save without a name opens the role');
        await shot('team-agent-role-desktop');
        await ev(`window.cancelTeamMember(); window.hideLaunchModal(); true`);
        // Add member and Edit member at both sizes (UI/UX, #7861): the title, the steps, Back, Next and Save member, the member's own values
        for (const [w, mobile, tag] of [[1440, false, 'desktop'], [390, true, 'phone']]) {
            await open(w, mobile);
            await ev(`window.showLaunchModal(); window._selectLaunchType('team'); window._addTeamAgent('Scribe', 'Write the notes.'); window.showTeamAgentModal(); true`);
            await waitFor(`${vis('#launch-agent-name-input')} && !!document.querySelector('#launch-agent-acf .acf-agent-type')`, `${tag}: Add member`);
            const foot = () => ev(`(() => { const v = id => { const e = document.getElementById(id); return !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; }; return { title: document.getElementById('launch-agent-title-text').textContent, sub: document.getElementById('launch-stage-sub').textContent.replace(/\\s+/g, ' ').trim(), back: v('launch-agent-back'), next: v('launch-agent-next'), save: v('launch-agent-save'), go: v('launch-agent-go') }; })()`);
            assert.deepEqual(await foot(), { title: 'Add member', sub: 'Step 1 of 2: Persona', back: false, next: true, save: false, go: false }, `${tag}: Add member opens on the role, with Next and no Save`);
            assert.deepEqual(await ev(`(() => { const e = document.getElementById('launch-stage-sub'); const cs = getComputedStyle(e); return [e.getClientRects().length > 0, cs.fontSize, cs.fontWeight]; })()`), mobile ? [true, '12px', '400'] : [true, '13px', '400'], `${tag}: the step line is under the title, 12/400 on a phone (#7912)`);
            assert.deepEqual(await ev(`[document.querySelector('label[for="launch-agent-name-input"]').textContent, document.getElementById('launch-agent-name-input').getAttribute('aria-required')]`), ['Role', 'true'], `${tag}: the member's field is its Role and it is required, not optional`);
            await shot(`add-member-persona-${tag}`);
            await ev(`window._launchStage('agent'); true`); await waitFor(`document.getElementById('launch-step-agent').dataset.stage === 'agent'`, `${tag}: the settings`);
            assert.deepEqual(await foot(), { title: 'Add member', sub: 'Step 2 of 2: The agent', back: true, next: false, save: true, go: false }, `${tag}: Save member on the settings only, no Launch`);
            await shot(`add-member-agent-${tag}`);
            await ev(`window.cancelTeamMember(); window.showTeamAgentModal([...document.querySelectorAll('#team-agents-list .team-agent-row')].find(r => r.querySelector('.team-agent-role-name').textContent === 'Scribe')); true`);
            await waitFor(`document.getElementById('launch-agent-title-text').textContent === 'Edit member' && document.getElementById('launch-step-agent').dataset.stage === 'agent'`, `${tag}: Edit member`);
            assert.equal(await ev(`document.getElementById('launch-agent-name-input').value`), 'Scribe', `${tag}: the member's own role`);
            assert.deepEqual(await foot(), { title: 'Edit member', sub: 'Step 2 of 2: The agent', back: true, next: false, save: true, go: false }, `${tag}: Edit member opens on the settings with Save member`);
            await shot(`edit-member-agent-${tag}`);
            await ev(`window._launchStage('persona'); true`); await waitFor(`document.getElementById('launch-step-agent').dataset.stage === 'persona'`, `${tag}: back to the role`);
            assert.equal(await ev(`document.querySelector('#launch-agent-acf .acf-prompt').value`), 'Write the notes.', `${tag}: the member's prompt is loaded`);
            await shot(`edit-member-persona-${tag}`);
            await ev(`window.cancelTeamMember(); window.hideLaunchModal(); true`);
        }
        console.log('PASS dialog sections: Restart, the team member dialog');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
