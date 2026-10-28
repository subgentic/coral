// #10366 (Beta pass #10358, share a team): a saved team template can be exported and imported as one named file, and the words around it say what it is.
//  1. The template More menu: Import a template (.json) and Export this template (.json); the export is for one of the person's own saved templates (disabled until one is picked, and says so), and downloads the file
//     Import takes: {"version": 1, "type": "coral-team-templates", "templates": [one]} with its members, roles, instructions, models and flags.
//  2. A bad file says what is wrong: not a template file, a personas file, no list, no name, no members, a member with no name; a mixed file imports the good ones and says what it skipped.
//  3. Save this team as a template says what is kept (the members, their roles, instructions, models and flags) and what is not (the goal, tasks, notes and chats).
//  4. The team's Export reads "Export the board's messages": it exports the messages, not the team.
// Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        const vis = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true }); })()`;

        console.log('4. the team\'s Export says what it exports');
        assert.equal(await ev(`document.getElementById('mb-export-btn').textContent.trim()`), "Export the board's messages", 'the team More menu item is about the board\'s messages');

        console.log('1. the template menu');
        await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('team'); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step');
        await ev(`{ const n = document.getElementById('team-board-name'); n.value = 'share-crew'; n.dispatchEvent(new Event('input', { bubbles: true })); const d = document.getElementById('launch-team-dir'); d.value = '/work/x'; d.dispatchEvent(new Event('input', { bubbles: true })); } document.getElementById('launch-team-next').click(); true`);
        await waitFor(vis('#team-template-select'), 'the template picker');
        // a saved template of the person's own, and the download captured
        await ev(`(async () => {
            const ps = await import(${S} + 'persona_store.js');
            await ps._upsertSavedTeamTemplates([{ name: 'Share crew', flags: '--verbose', agents: [{ name: 'Boss', prompt: 'You lead the crew.', agentType: 'claude', model: 'opus', flags: '--permission-mode plan' }, { name: 'Dev', prompt: 'You build.', agentType: 'claude' }] }]);
            const td = await import(${S} + 'team_templates_ui.js'); td._renderTeamTemplateSelector();
            window.__dl = null;
            URL.createObjectURL = blob => { window.__blob = blob; return 'blob:test'; };
            const click = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl = this.download; return; } return click.call(this); };
            return true;
        })()`);
        const items = () => ev(`(() => { const q = id => document.querySelector(id); const i = q('[data-on-click="m-import-team-templates"]'), x = q('#team-template-export'); return { imp: i && i.textContent.trim(), impTitle: i && i.title, exp: x && x.textContent.trim(), expDisabled: x && x.disabled, expTitle: x && x.title }; })()`);
        await ev(`document.getElementById('team-template-more').click(); true`);
        await waitFor(vis('#team-template-menu'), 'the template menu');
        let m = await items();
        assert.equal(m.imp, 'Import a template (.json)', 'Import names its format');
        assert.match(m.impTitle, /Coral team template: a \.json file/, 'and says what the file is');
        assert.equal(m.exp, 'Export this template (.json)');
        assert.equal(m.expDisabled, true, 'nothing of the person\'s own is picked: no export');
        assert.match(m.expTitle, /saved templates/, 'and it says why');
        await ev(`document.getElementById('team-template-more').click(); true`); // closes
        await ev(`(() => { const s = document.getElementById('team-template-select'); s.value = 'Share crew'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await ev(`document.getElementById('team-template-more').click(); true`);
        await waitFor(vis('#team-template-menu'), 'the menu again');
        m = await items();
        assert.equal(m.expDisabled, false, 'a saved template is picked: Export is on');
        await ev(`document.getElementById('team-template-export').click(); true`);
        await waitFor(`window.__dl !== null && !!window.__blob`, 'the download');
        assert.equal(await ev(`window.__dl`), 'coral-team-template-Share_crew.json');
        const file = JSON.parse(await ev(`window.__blob.text()`));
        assert.equal(file.type, 'coral-team-templates'); assert.equal(file.version, 1);
        assert.equal(file.templates.length, 1, 'one template');
        assert.deepEqual(file.templates[0].agents.map(a => [a.name, a.prompt, a.model, a.flags]), [['Boss', 'You lead the crew.', 'opus', '--permission-mode plan'], ['Dev', 'You build.', undefined, undefined]], 'its members, roles, instructions, models and flags');
        assert.equal(file.templates[0].flags, '--verbose');
        const back = await ev(`import(${S} + 'persona_io.js').then(m => m.readTeamTemplateFile(${JSON.stringify(file)}))`);
        assert.equal(back.entries.length, 1, 'Import takes the file Export made'); assert.deepEqual(back.problems, []);

        console.log('2. a bad file says what is wrong');
        const read = data => ev(`import(${S} + 'persona_io.js').then(m => m.readTeamTemplateFile(${JSON.stringify(data)}))`);
        const first = async data => (await read(data)).problems[0];
        assert.match(await first('hello'), /not a Coral team template: a \.json file made by Export this template/);
        assert.match(await first({ type: 'coral-personas', personas: [] }), /a personas file, not a Coral team template/);
        assert.match(await first({ type: 'something-else' }), /a "something-else" file, not a Coral team template/);
        assert.match(await first({ version: 1 }), /has no "templates" list/);
        assert.match(await first({ type: 'coral-team-templates', templates: [] }), /holds no templates/);
        assert.equal(await first({ templates: [{ agents: [{ name: 'a' }] }] }), 'Template 1 has no name.');
        assert.equal(await first({ templates: [{ name: 'Empty' }] }), '"Empty" has no members.');
        assert.equal(await first({ templates: [{ name: 'Odd', agents: [{ prompt: 'x' }] }] }), 'A member of "Odd" has no name.');
        const mixed = await read({ templates: [{ name: 'Good', agents: [{ name: 'a' }] }, { name: 'Bad' }, {}] });
        assert.equal(mixed.entries.length, 1, 'the good template is kept'); assert.deepEqual(mixed.problems, ['"Bad" has no members.', 'Template 3 has no name.'], 'and each bad one is named');

        console.log('3. Save this team as a template says what is kept');
        await ev(`document.getElementById('team-template-more').click(); true`); // closes
        await ev(`window._saveTeamTemplate(); true`);
        await waitFor(`getComputedStyle(document.getElementById('save-template-modal')).display !== 'none'`, 'the save dialog');
        const kept = await ev(`document.getElementById('save-template-kept').textContent.trim()`);
        assert.match(kept, /^Kept: the members, their roles, instructions, models and flags\./);
        assert.match(kept, /Not kept: the goal, tasks, notes and chats\.$/);
        await ev(`window._hideSaveTemplateModal(); window.hideLaunchModal(); true`);
        console.log('\nAll team-template sharing checks passed');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
