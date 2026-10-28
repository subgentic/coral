// "Describe your team" is a visible choice beside the templates, in plain words (#10314, Beta #10305: Generate with AI hid behind an unlabelled More, asked two boxes of which the second was silently required, said
// "team JSON" and had a Test button nobody could explain). New team > Members: the button is beside the template choice and not in More; its dialog has one box; an empty one says what to write; a draft with no
// members says what to try; Test says what it does. The generate request is stood in at POST /api/teams/generate. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        const vis = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.checkVisibility({ checkVisibilityCSS: true }); })()`;
        await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('team'); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step', 8000);
        await ev(`{ const n = document.getElementById('team-board-name'); n.value = 'describe-x'; n.dispatchEvent(new Event('input', { bubbles: true })); const d = document.getElementById('launch-team-dir'); d.value = '/work/x'; d.dispatchEvent(new Event('input', { bubbles: true })); } document.getElementById('launch-team-next').click(); true`);
        await waitFor(vis('#team-template-select'), 'the Members step', 8000);
        const choice = await ev(`(() => { const b = [...document.querySelectorAll('#team-panel-members .team-template-row button')].find(x => /^Describe your team$/.test(x.textContent.trim())); const menu = document.getElementById('team-template-menu');
            return { shown: !!b && b.checkVisibility({ checkVisibilityCSS: true }), inMore: !!b && !!b.closest('#team-template-menu'), moreItems: [...menu.querySelectorAll('button')].map(x => x.textContent.trim()) }; })()`);
        assert.ok(choice.shown && !choice.inMore, 'a visible "Describe your team" beside the templates: ' + JSON.stringify(choice));
        assert.ok(!choice.moreItems.some(t => /generate with ai/i.test(t)), 'More no longer hides it: ' + JSON.stringify(choice.moreItems));
        await ev(`[...document.querySelectorAll('#team-panel-members .team-template-row button')].find(x => /^Describe your team$/.test(x.textContent.trim())).click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('team-wizard-modal')).display !== 'none'`, 'the dialog', 4000);
        const dlg = await ev(`(() => { const m = document.getElementById('team-wizard-modal'); return { boxes: m.querySelectorAll('textarea').length, labels: [...m.querySelectorAll('label')].map(l => l.firstChild ? l.firstChild.textContent.trim() : l.textContent.trim()), text: m.textContent.replace(/\\s+/g, ' '), test: (() => { const t = document.getElementById('team-wizard-test-btn'); return { text: t.textContent.trim(), title: t.title }; })() }; })()`);
        assert.equal(dlg.boxes, 1, 'one box: ' + JSON.stringify(dlg.labels));
        assert.deepEqual(dlg.labels, ['Describe your team'], 'its one label');
        assert.doesNotMatch(dlg.text, /JSON|Team Composition|Directive/, 'no insider words: ' + dlg.text.slice(0, 300));
        assert.equal(dlg.test.text, 'Try a sample', 'Test says what it is');
        assert.match(dlg.test.title, /sample team/i, 'and what it does: ' + dlg.test.title);
        assert.match(dlg.test.title, /nothing is generated/i);
        // empty: what to write
        await ev(`document.getElementById('team-wizard-generate-btn').click(); true`);
        await settle(200);
        const empty = await ev(`document.getElementById('team-wizard-error').textContent`);
        assert.match(empty, /^Describe your team first/, 'an empty box says what to write: ' + empty);
        assert.match(empty, /for example/i, 'with an example: ' + empty);
        // a request with only the one box; a draft without members says what to try
        await ev(`(() => { window.__req = null; const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { if (String(u).includes('/api/teams/generate')) { window.__req = JSON.parse(o.body); return Promise.resolve(new Response(JSON.stringify({ error: 'Generated team has no agents' }), { status: 500, headers: { 'content-type': 'application/json' } })); } return R(u, o); }; const t = document.getElementById('team-wizard-directive'); t.value = 'a small team that reviews pull requests'; return true; })()`);
        await ev(`document.getElementById('team-wizard-generate-btn').click(); true`);
        await waitFor(`/members|try/i.test(document.getElementById('team-wizard-error').textContent) && !!window.__req`, 'the error', 4000);
        assert.deepEqual(await ev(`window.__req`), { directive: 'a small team that reviews pull requests', composition: '' }, 'one box is the whole request');
        const err = await ev(`document.getElementById('team-wizard-error').textContent`);
        assert.match(err, /^The draft had no members\. Try again/, 'no members says what to try: ' + err);
        assert.match(err, /orchestrator|roles/i, 'and an example of what to ask for: ' + err);
        console.log('PASS Describe your team is visible, one box, in plain words');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
