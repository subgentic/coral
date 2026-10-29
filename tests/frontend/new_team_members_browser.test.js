// The members of a new team (the team launch redesign, #7407; UI/UX's final v4 doc ad146b3a), written failing-first by QA (#7415): the Orchestrator gate (Next is off until a member's role is exactly Orchestrator, case
// and spaces ignored; Add Orchestrator adds one at the top; renaming it away in Edit member brings the gate back on Save; Cancel keeps the name), "Set all workers to" (leaves the Orchestrator alone and resets the
// workers' model and thinking only), and the Edit member dialog (Persona, Agent, Permissions, Advanced; changes held until Save member; Cancel leftmost; same size as New team; a provider change resets that member's
// model and thinking only). Controls by role and name (helpers/new_team.js). 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNT, M, N, T, openNewTeam, scenarios, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios(); const t = T(ev, waitFor); const mem = M(ev, waitFor);
    const roles = () => ev(`window.__nt.roles(window.__nt.dlg(${N.team}))`);
    const rowText = role => ev(`(() => { const b = window.__nt.rows(window.__nt.dlg(${N.team})).find(x => window.__na.name(x) === ${JSON.stringify('Edit ' + role)}); return b ? window.__na.text(b.closest('.team-agent-row')) : null; })()`);
    const nextOff = () => ev(`(() => { const b = window.__nt.find(window.__nt.dlg(${N.team}), 'button', ${N.next}); return !!b && (b.disabled || b.getAttribute('aria-disabled') === 'true'); })()`);
    const pressNext = async () => { await t.click('button', N.next); await settle(150); return ev(`(() => { const r = document.getElementById('team-recap'); const a = document.activeElement; return { said: r.textContent.trim(), red: r.classList.contains('launch-recap-error'), focus: a && a.id, step: /Step 2 of 3/.test(window.__na.text(window.__nt.dlg(${N.team}))) }; })()`); };
    const why = () => ev(`(() => { const d = window.__nt.dlg(${N.team}); const b = window.__nt.find(d, 'button', ${N.next}); const dd = (b.getAttribute('aria-describedby') || '').split(/\\s+/).map(i => (document.getElementById(i) || {}).textContent || '').join(' ').trim(); const live = [...d.querySelectorAll('[aria-live=polite],[role=status]')].map(e => window.__na.text(e)).join(' | '); return dd + ' || ' + live; })()`);
    const openRow = async role => { await ev(`(() => { const b = window.__nt.rows(window.__nt.dlg(${N.team})).find(x => window.__na.name(x) === 'Edit ' + ${JSON.stringify(role)}); b.click(); return true; })()`); await waitFor(`!!window.__nt.dlg(${N.member})`, `the Edit member dialog for ${role}`, 5000); };
    const mtab = name => (name === 'Persona' ? mem.toPersona() : mem.section(name)); // Persona is the page before the settings (#7861)
    const setRole = v => mem.setRole(v);
    const setProvider = async name => { // a select or a radiogroup, as the build draws it
        const ok = await ev(`(() => { const d = window.__nt.dlg(${N.member}); const s = window.__nt.find(d, 'select', /^Provider$/i); if (s) { const o = [...s.options].find(o => o.textContent.trim() === ${JSON.stringify(name)}); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; } const g = [...d.querySelectorAll('[role=radiogroup]')].find(e => /^Provider$/i.test(window.__na.name(e))); if (!g) return false; const r = window.__na.radios(g).find(x => window.__na.radioName(x) === ${JSON.stringify(name)}); if (!r) return false; r.click(); return true; })()`);
        assert.ok(ok, `a Provider control with ${name} in Edit member`); await settle(500);
    };
    const setThinking = async name => { assert.ok(await ev(`(() => { const d = window.__nt.dlg(${N.member}); const g = [...d.querySelectorAll('[role=radiogroup]')].find(e => /^Thinking/i.test(window.__na.name(e))); if (g) { const r = window.__na.radios(g).find(x => window.__na.radioName(x) === ${JSON.stringify(name)}); if (!r) return false; r.click(); return true; } const s = window.__nt.find(d, 'select', /^Thinking/i); if (!s) return false; const o = [...s.options].find(o => o.textContent.trim() === ${JSON.stringify(name)}); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`), `a Thinking control with ${name}`); await settle(200); };
    const setModel = async rx => { assert.ok(await ev(`(() => { const s = window.__nt.find(window.__nt.dlg(${N.member}), 'select', /^Model$/i); if (!s) return false; const o = [...s.options].find(o => ${rx}.test(o.value + ' ' + o.textContent)); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`), `a Model option ${rx}`); await settle(200); };
    const save = async () => { await mem.save(); await settle(200); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNT(ev); await stubModels(ev);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
        await openNewTeam(ev, waitFor);
        await t.to(2, { template: /^Blank/ });

        await S.run('a blank team cannot go on: Next is on and says nothing until pressed, then one red line and the focus on Add Orchestrator; a line says "Add an Orchestrator..." with an Add Orchestrator button, and the footer reason "Add an Orchestrator to continue" is said', async () => {
            assert.deepEqual(await roles(), [], 'a blank team has no members');
            assert.ok(!(await nextOff()), 'Next is on (#8476: it is never drawn off)'); assert.doesNotMatch(await why(), /Add an Orchestrator to continue/, 'nothing is said before the first press');
            const p = await pressNext(); assert.equal(p.step, true, 'pressing Next stays on Members'); assert.equal(p.focus, 'team-add-orchestrator', 'the Add Orchestrator button takes the focus'); assert.equal(p.said, 'Add an Orchestrator to continue', 'one line says what is missing'); assert.equal(p.red, true, 'in the red of step 1');
            assert.match(await ev(`window.__na.text(window.__nt.dlg(${N.team}))`), /Add an Orchestrator\.\s*It plans tasks, runs reviews and receives other teams' requests\. A member counts as the Orchestrator only when its role is exactly/, 'the line says why in words');
            assert.ok(await t.has('button', N.addOrch), 'an Add Orchestrator button');
            assert.ok(!(await t.has('select', N.bulk)), 'no "Set all workers to" while there are no workers');
        });
        await S.run('Add Orchestrator adds one at the top that "Gets the first task", the line and the reason go, and Next turns on', async () => {
            await t.click('button', N.addOrch); await settle(300);
            assert.deepEqual(await roles(), ['Orchestrator']);
            assert.match(await rowText('Orchestrator'), /Gets the first task/);
            assert.ok(!(await t.has('button', N.addOrch)), 'the Add Orchestrator button is gone'); assert.ok(!(await nextOff()), 'Next is on');
            assert.ok(!(await t.has('select', N.bulk)), 'still no "Set all workers to": the Orchestrator is the only member');
        });
        await S.run('Add Orchestrator again after a worker is there still adds it at the top (a team that has workers but no Orchestrator)', async () => {
            await t.click('button', N.addMember); await waitFor(`!!window.__nt.dlg(${N.member})`, 'the Add member dialog', 5000);
            assert.match(await ev(`window.__na.name(window.__nt.dlg(${N.member}))`), /^Add member/, 'the dialog is named Add member');
            await setRole('Nobody'); await mem.cancel(); assert.equal((await roles()).length, 1, 'nothing is added until Save member: a cancelled Add member adds nothing');
            await t.click('button', N.addMember); await waitFor(`!!window.__nt.dlg(${N.member})`, 'the Add member dialog again', 5000);
            await setRole('Backend Dev'); await save(); await settle(300);
            assert.equal((await roles()).length, 2, 'Save member adds the member at the end'); assert.equal((await roles())[1], 'Backend Dev', 'with the role typed');
            const worker = (await roles())[1];
            // rename the first away so the team has workers only
            await openRow('Orchestrator'); await setRole('Lead'); await save();
            assert.ok(!(await nextOff()), 'Next stays on with no Orchestrator'); assert.ok(await t.has('button', N.addOrch), 'Add Orchestrator is back');
            await t.click('button', N.addOrch); await settle(300);
            const r = await roles(); assert.equal(r[0], 'Orchestrator', 'the new Orchestrator is at the top'); assert.equal(r.length, 3);
            assert.match(await rowText('Orchestrator'), /Gets the first task/);
            assert.ok(!(await nextOff()), 'Next is on again'); assert.ok(worker);
        });
        await S.run('renaming the only Orchestrator away in Edit member and pressing Save member brings the line, the reason and the off Next back; the rename does it live, not on Next', async () => {
            await openRow('Orchestrator'); await setRole('Planner'); assert.ok(!(await nextOff()), 'nothing changes in the list while the dialog is open (held until Save)');
            await save();
            assert.ok(!(await nextOff()), 'Next stays on after Save'); assert.ok(await t.has('button', N.addOrch), 'the Add Orchestrator line is back');
            const p = await pressNext(); assert.equal(p.said, 'Add an Orchestrator to continue', 'pressing Next says why'); assert.equal(p.focus, 'team-add-orchestrator');
            assert.ok(!(await roles()).includes('Orchestrator'), 'no member is called Orchestrator');
        });
        await S.run('" orchestrator " in any case and with spaces counts as the Orchestrator (the server reads it the same way)', async () => {
            await openRow('Planner'); await setRole('  orchestrator '); await save();
            assert.ok(!(await nextOff()), 'Next is on'); assert.ok(!(await t.has('button', N.addOrch)), 'no Add Orchestrator line');
        });
        await S.run('Cancel in Edit member keeps the old name: a rename that is cancelled changes nothing, and the gate stays as it was', async () => {
            const before = await roles();
            await openRow(before[0].trim() === '' ? before[0] : before[0]); await setRole('Renamed'); await mem.cancel(); await settle(200);
            assert.deepEqual(await roles(), before, 'the roles are as before'); assert.ok(!(await nextOff()), 'the gate is as it was');
        });

        // a team with a template: Orchestrator and workers
        await S.run('Set all workers to: a provider choice sets every non-Orchestrator member\'s provider, resets their model and thinking, and leaves the Orchestrator, modes, roles and prompts alone', async () => {
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`); await settle(200); await openNewTeam(ev, waitFor);
            await t.to(2, { template: /Coding|\(\d+ members\)/ });
            const r0 = await roles(); assert.ok(r0.length >= 3 && r0[0] === 'Orchestrator', `a template with an Orchestrator and workers (${JSON.stringify(r0)})`);
            // the Orchestrator gets a model, the first worker a model, a thinking level and a mode
            await openRow('Orchestrator'); await mtab('Agent'); await setModel(/claude-small/); await save();
            await openRow(r0[1]); await mtab('Agent'); await setModel(/claude-small/); await setThinking('High'); await mtab('Permissions');
            await ev(`(() => { const d = window.__nt.dlg(${N.member}); const g = [...d.querySelectorAll('[role=radiogroup]')].find(e => /mode$/i.test(window.__na.name(e))); const r = window.__na.radios(g).find(x => /^Plan/i.test(window.__na.radioName(x))); r.click(); return true; })()`); await settle(200); await save();
            const orchBefore = await rowText('Orchestrator'), w1Before = await rowText(r0[1]);
            assert.match(w1Before, /small|High/i, 'the worker shows its model and thinking before'); assert.match(w1Before, /Plan/i, 'and its mode');
            assert.match(await ev(`window.__na.text(window.__nt.dlg(${N.team}))`), /Skips the Orchestrator\.\s*Resets each worker's model\./, 'the line says who it leaves out');
            const ok = await ev(`(() => { const s = window.__nt.find(window.__nt.dlg(${N.team}), 'select', ${N.bulk}); if (!s) return false; const o = [...s.options].find(o => /Codex/.test(o.textContent)); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            assert.ok(ok, 'a Set all workers to select with Codex'); await settle(500);
            assert.equal(await rowText('Orchestrator'), orchBefore, 'the Orchestrator keeps its own provider, model and thinking');
            for (const w of r0.slice(1)) { const txt = await rowText(w); assert.match(txt, /Codex/, `${w}: provider is Codex now`); assert.ok(!/small/.test(txt) && !/High/.test(txt), `${w}: model and thinking are back to their defaults (${txt})`); }
            assert.match(await rowText(r0[1]), /Plan/i, 'the worker\'s mode is left alone');
            assert.deepEqual(await roles(), r0, 'roles are left alone');
        });
        await S.run('Edit member is a dialog named "Edit member": it opens on the member\'s settings (the sections Agent, Permissions, Advanced), the persona page (Role) is one Back away; Cancel is leftmost and Save member the rightmost; it is the same size as New team', async () => {
            const roles0 = await roles(); const tt = await t.rect(); await openRow(roles0[1]);
            assert.match(await ev(`window.__na.name(window.__nt.dlg(${N.member}))`), /^Edit member/, 'the dialog is named Edit member');
            assert.ok(!(await mem.onPersona()), 'it opens on the settings page');
            const tabs = await ev(`(() => { const d = window.__nt.dlg(${N.member}); const tl = window.__nt.tablist(d); const t = tl ? [...tl.querySelectorAll('[role=tab]')].filter(window.__na.vis).map(x => window.__na.name(x)) : []; return t.length ? t : [...window.__nt.find(d, 'select', ${N.section}).options].map(o => o.textContent.trim()); })()`);
            assert.deepEqual(tabs, N.memberTabs);
            const b = await ev(`window.__nt.buttons(window.__nt.dlg(${N.member}))`); const cancel = b.find(x => N.cancel.test(x.name)), saveB = b.find(x => N.save.test(x.name));
            assert.ok(cancel && saveB, 'Cancel and Save member'); assert.ok(cancel.x < saveB.x, 'Cancel is left of Save member'); assert.ok(Math.abs(cancel.y - saveB.y) < 4, 'one row');
            const m = await ev(`window.__na.box(window.__nt.panel(window.__nt.dlg(${N.member})))`);
            assert.ok(Math.abs(m.w - tt.w) <= 1 && Math.abs(m.h - tt.h) <= 1, `Edit member is ${m.w}x${m.h}, New team ${tt.w}x${tt.h}`);
            await mem.toPersona(); assert.equal(await ev(`window.__nt.find(window.__nt.dlg(${N.member}), 'input', /^Role$/i).value`), roles0[1], 'the persona page holds the member\'s role');
            await mem.cancel();
        });
        await S.run('Edit member: changes are held until Save member (a cancelled edit changes nothing), a provider change resets that member\'s Model and Thinking only, and a thinking level leaves the model alone', async () => {
            const r = await roles(); const w = r[2]; const before = await rowText(w);
            await openRow(w); await mtab('Agent');
            await setModel(/-small/); await setThinking('Medium');
            const modelNow = await ev(`window.__nt.find(window.__nt.dlg(${N.member}), 'select', /^Model$/i).value`); await setThinking('High');
            assert.equal(await ev(`window.__nt.find(window.__nt.dlg(${N.member}), 'select', /^Model$/i).value`), modelNow, 'a thinking level leaves the model alone');
            await setProvider('Pi'); const after = await ev(`window.__nt.find(window.__nt.dlg(${N.member}), 'select', /^Model$/i).value`);
            assert.notEqual(after, modelNow, 'a provider change resets the model');
            await mtab('Persona'); assert.equal(await ev(`window.__nt.find(window.__nt.dlg(${N.member}), 'input', /^Role$/i).value`), w, 'the role is untouched by the provider change');
            await mem.cancel(); assert.equal(await rowText(w), before, 'a cancelled edit leaves the row as it was');
            await openRow(w); await mtab('Agent'); await setProvider('Pi');
            await save(); assert.match(await rowText(w), /Pi/, 'after Save member the row shows the new provider');
            const others = await roles(); assert.deepEqual(others, r, 'no member moved or renamed');
        });
        S.finish();
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
