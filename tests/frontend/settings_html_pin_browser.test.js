// The markup of the team's Settings tab (showTeamSettingsPage) and of the agent config form (renderAgentConfigForm) is pinned as written, string for string (#8384): the two functions
// were split into named builders and this is the differential that proves the split draws the same page. The golden (settings_html_pin.golden.json) was written from the modules as they
// were before the split; UPDATE_GOLDEN=1 writes it again, and a change to either form's markup on purpose is a change to the golden, read in the diff.
// The Settings tab is drawn over a real board on the isolated dev server (removed again), one snapshot per group; the config form is drawn for the layouts the dialogs use.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const GOLDEN = path.join(__dirname, 'settings_html_pin.golden.json');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const TEAM = 'html-pin-team';
    const S = `(window.__coralStatic || '/static/')`;
    const got = {};
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        const sub = await ev(`fetch('/api/board/${TEAM}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-${TEAM}' }) }).then(r => r.status)`);
        assert.ok(sub < 300);

        console.log('1. The Settings tab, every group');
        await ev(`import(${S} + 'team_settings_page.js').then(m => m.showTeamSettingsPage(${JSON.stringify(TEAM)}, { page: (document.getElementById('pin-host') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'pin-host' }))) })).then(() => true)`);
        await waitFor(`!!document.querySelector('#team-settings-workspace .sv[data-ready]')`, 'the Team settings', 15000);
        // the prompt texts are the agent docs', not this page's markup: their bodies are blanked so the golden does not move with them
        const snap = () => ev(`(() => { const c = document.getElementById('team-settings-workspace').cloneNode(true); c.querySelectorAll('.prompt-inspection-card pre').forEach(p => { p.textContent = '(prompt text)'; }); return c.outerHTML.replace(/custom-[a-z0-9]+/g, 'custom-ID'); })()`); // a new preset's id is made per run
        got.settings_open = await snap();
        await ev(`document.querySelector('.preset-editor summary').click(); document.querySelector('.preset-new').click(); true`); // the presets editor with a new preset open
        await waitFor(`!!document.querySelector('.preset-editor input[name=preset_name]')`, 'the preset editor', 5000);
        await ev(`document.querySelector('#team-settings-workspace .settings-tab[data-section=prompts]').click(); true`); // the prompts group, once its inspection is in
        await waitFor(`!!document.querySelector('.prompt-inspection-role')`, 'the inspection', 15000);
        got.settings_presets_and_prompts = await snap();
        console.log('   ✓');

        console.log('2. The agent config form, every layout');
        const CASES = {
            plain: {},
            bare: { showPreset: false, showName: false, showAutoPermissions: false },
            valued: { value: { agentType: 'codex', model: 'gpt-x', name: 'Ada <b>', prompt: 'Be <i>brief</i>', flags: '--verbose', thinking: 'high', capabilities: { allow: ['Read', 'Bash'], deny: ['WebFetch'] } } },
            sections: { sections: true },
            wizard: { sections: true, wizard: true },
            restart: { sections: true, restart: true, restartName: 'Agent X', value: { agentType: 'claude' } },
            member: { sections: true, nameLabel: 'Member', value: { autoPermissions: 'plan' } },
        };
        await ev(`import(${S} + 'agent_config_form.js').then(m => { window.__acf = m; return true; })`);
        for (const [name, opts] of Object.entries(CASES)) {
            const id = 'acf-pin-' + name;
            await ev(`(() => { const d = document.createElement('div'); d.id = ${JSON.stringify(id)}; document.body.append(d); window.__acf.renderAgentConfigForm(${JSON.stringify(id)}, ${JSON.stringify(opts)}); return true; })()`);
            await waitFor(`document.getElementById(${JSON.stringify(id)}).dataset.acfModelClassifying !== 'true'`, `the ${name} form's model is classified`, 10000);
            // the form's model picker settles after its provider's models are read: the markup is taken once two reads 150 ms apart agree; the missing-CLI line is what a CLI check says (a check that may still be running), not the form's markup
            got['form_' + name] = await ev(`(async () => { const el = document.getElementById(${JSON.stringify(id)}); let last = ''; for (let i = 0; i < 40; i++) { const c = el.cloneNode(true); c.querySelectorAll('.acf-cli-warning').forEach(w => { w.replaceChildren(); w.removeAttribute('style'); w.removeAttribute('aria-live'); }); const now = c.outerHTML; if (now === last) return now; last = now; await new Promise(r => setTimeout(r, 150)); } return last; })()`); // sleep-ok: in-page settle, bounded
        }
        console.log('   ✓');

        if (process.env.UPDATE_GOLDEN) { fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 1) + '\n'); console.log('golden written: ' + Object.keys(got).length + ' snapshots'); }
        else {
            const want = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
            assert.deepEqual(Object.keys(got), Object.keys(want), 'the same snapshots');
            for (const k of Object.keys(want)) { if (got[k] !== want[k]) { let i = 0; while (i < got[k].length && got[k][i] === want[k][i]) i++; globalThis.__diag = ['DIAG', k, 'first diff at', i, 'of', got[k].length, want[k].length, '\n got:', JSON.stringify(got[k].slice(Math.max(0, i - 120), i + 160)), '\n want:', JSON.stringify(want[k].slice(Math.max(0, i - 120), i + 160))].join(' '); break; } }
            for (const k of Object.keys(want)) assert.equal(got[k], want[k], `${k}: the markup is the golden's, string for string`);
            console.log('PASS settings html pin: ' + Object.keys(want).length + ' snapshots equal');
        }
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); console.error(String(globalThis.__diag)); process.exitCode = 1; });
