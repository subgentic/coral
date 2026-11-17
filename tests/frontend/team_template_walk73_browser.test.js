// Team templates, beta walk 73 (#17509): (1) More > Save this team as a template > Save confirms with a notice and closes the menu; (2) a template's Auto mode comes back as Auto, and "Everyone runs as" shows the model
// the members share (Mixed when they differ), not "Default model"; (3) the name field is selected when the dialog opens, so typing replaces the team's name instead of adding to it; (4) the next New team opens on the template
// the person saved last. Drives Chrome over CDP against the isolated dev server; the saved template is put back (settings guard).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const S = `(window.__coralStatic || '/static/')`;
    const NAME = 'walk73-template';
    const vis = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true }); })()`;
    const openTeam = async () => {
        await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('team'); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step', 10000);
        await waitFor(`document.querySelectorAll('#team-agents-list .team-agent-row').length >= 3`, 'the default members', 10000);
    };
    const members = () => ev(`[...document.querySelectorAll('#team-agents-list .team-agent-row')].map(r => { const c = window.getAgentConfig(r.dataset.acfId); return { role: r.querySelector('.team-agent-role-name').textContent, model: c.model, mode: c.permissionMode, line: r.querySelector('.team-agent-summary').textContent }; })`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        await openTeam();

        console.log('2. members: Lead on Auto, both workers on Haiku');
        await ev(`(() => { const set = (role, mode, model) => { const r = [...document.querySelectorAll('#team-agents-list .team-agent-row')].find(x => x.querySelector('.team-agent-role-name').textContent === role); const box = document.getElementById(r.dataset.acfId);
            if (mode) { const m = box.querySelector('.acf-permission-mode'); m.value = mode; m.dataset.pickedByPerson = '1'; m.dispatchEvent(new Event('change', { bubbles: true })); }
            if (model) { const s = box.querySelector('.acf-model-select'); s.value = model; s.dispatchEvent(new Event('change', { bubbles: true })); } };
            set('Lead', 'auto', ''); return true; })()`);
        const findHaiku = `(() => { const s = document.getElementById(document.querySelector('#team-agents-list .team-agent-row').dataset.acfId).querySelector('.acf-model-select'); const o = s && [...s.options].find(x => /haiku/i.test(x.textContent) && x.value); return o ? o.value : ''; })()`;
        await waitFor(findHaiku, 'the model list offers Haiku', 10000);
        await waitFor(`[...document.querySelectorAll('#team-agents-list .team-agent-row')].every(r => [...(document.getElementById(r.dataset.acfId).querySelector('.acf-model-select')?.options || [])].some(o => /haiku/i.test(o.textContent) && o.value))`, 'every member\'s model list offers Haiku', 10000);
        const haiku = await ev(`(() => { const s = document.getElementById(document.querySelector('#team-agents-list .team-agent-row').dataset.acfId).querySelector('.acf-model-select'); const o = [...s.options].find(x => /haiku/i.test(x.textContent) && x.value); return o ? o.value : ''; })()`);
        assert.ok(haiku, 'a Haiku model is offered');
        await ev(`(() => { for (const r of document.querySelectorAll('#team-agents-list .team-agent-row')) { if (/Lead|Reviewer/.test(r.querySelector('.team-agent-role-name').textContent)) { const s = document.getElementById(r.dataset.acfId).querySelector('.acf-model-select'); s.value = ${JSON.stringify(haiku)}; s.dispatchEvent(new Event('change', { bubbles: true })); } } return true; })()`);
        await ev(`(() => { const n = document.getElementById('team-board-name'); n.value = 'walk73a'; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

        console.log('1+3. More > Save this team as a template: the name is selected, Save confirms and closes the menu');
        await ev(`document.getElementById('team-template-more')?.click(); document.querySelector('[data-on-click="m-save-team-template"]').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('save-template-modal')).display !== 'none'`, 'the save dialog', 6000);
        assert.deepEqual(await ev(`(() => { const i = document.getElementById('save-template-name'); return { active: document.activeElement === i, from: i.selectionStart, to: i.selectionEnd, len: i.value.length }; })()`), { active: true, from: 0, to: 'walk73a'.length, len: 'walk73a'.length }, 'the name field is focused with its text selected');
        await Input.insertText({ text: NAME });
        assert.equal(await ev(`document.getElementById('save-template-name').value`), NAME, 'typing replaces the team name: no "walk73awalk73-template"');
        await ev(`document.querySelector('#save-template-modal [data-on-click="m-confirm-save-template"]').click(); true`);
        await waitFor(`!!document.querySelector('.toast, #toast-container .toast, [role=status].toast')`, 'a notice', 6000);
        assert.match(await ev(`document.querySelector('.toast, #toast-container .toast').textContent`), /Saved template "walk73-template"/, 'the notice says what was saved');
        assert.equal(await ev(vis('#team-template-menu')), false, 'the More menu is closed after saving');
        assert.equal(await ev(`getComputedStyle(document.getElementById('save-template-modal')).display`), 'none', 'and the dialog');

        console.log('2. the template back: Auto stays Auto, Everyone runs as shows the shared model');
        await ev(`(async () => { const m = await import(${S} + 'team_dialogs.js'); m._pickTeamTemplate(''); m._pickTeamTemplate(${JSON.stringify(NAME)}); return true; })()`);
        await waitFor(`document.querySelectorAll('#team-agents-list .team-agent-row').length === 3`, 'the three members back', 6000);
        await waitFor(`[...document.querySelectorAll('#team-agents-list .team-agent-row')].filter(r => /Lead|Reviewer/.test(r.querySelector('.team-agent-role-name').textContent)).every(r => !/default model/.test(r.querySelector('.team-agent-summary').textContent))`, 'the model pickers applied the template models', 8000);
        const back = await members();
        const lead = back.find(m => m.role === 'Lead');
        assert.equal(lead.mode, 'auto', 'Lead comes back on Auto: ' + JSON.stringify(back));
        assert.match(lead.line, /Auto mode/, 'and its line says Auto mode, not default mode: ' + lead.line);
        assert.equal(lead.model, haiku, 'on Haiku');
        const everyone = () => ev(`(() => { const s = document.getElementById('team-set-all-model'); return { text: s.selectedOptions[0]?.textContent, value: s.value }; })()`);
        assert.equal((await everyone()).value, haiku, 'both workers are on Haiku: Everyone runs as shows Haiku, not Default model: ' + JSON.stringify(await everyone()));
        await ev(`(async () => { const r = [...document.querySelectorAll('#team-agents-list .team-agent-row')].find(x => x.querySelector('.team-agent-role-name').textContent === 'Reviewer'); const s = document.getElementById(r.dataset.acfId).querySelector('.acf-model-select'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); (await import(${S} + 'team_dialogs.js'))._fillEveryone(); return true; })()`);
        assert.equal((await everyone()).text, 'Mixed', 'one worker on Haiku and one on the default: Mixed: ' + JSON.stringify(await everyone()));

        console.log('4. the next New team opens on the template saved last');
        await ev(`(async () => { const m = await import(${S} + 'team_dialogs.js'); await m._initTeamForm(); return true; })()`);
        await waitFor(`document.getElementById('team-template-select').value === ${JSON.stringify(NAME)}`, 'the saved template is the choice', 8000);
        console.log('\nPASS Save as template confirms, the name is selected, Auto and the shared model come back, and the saved template is the next choice');
    } finally { await guard.restore().catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
