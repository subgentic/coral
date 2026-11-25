// The agent form says what the chosen CLI enforces (#4545, Security's #4550): Codex keeps only a sandbox and an
// approval mode and Antigravity only a mode, so for them new Deny entries can't be added (an existing one can be
// removed) and shell patterns are marked as not enforced; Claude's line says Allow restricts nothing in Bypass
// Permissions mode; the line follows the agent type, the permission mode and the chips, and the Launch dialog
// shows it under the persona too.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;

(async () => {
    const c = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const ev = async expression => {
        const r = await c.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
        return r.result.value;
    };
    const { coralReady } = require('./helpers/wait').bind(ev);
    const shot = async name => {
        if (!process.env.CORAL_SCREENSHOT_DIR) return;
        fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
        const { data } = await c.Page.captureScreenshot({ format: 'png' });
        fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from(data, 'base64'));
    };
    const line = () => ev(`(() => { const l = document.querySelector('#fixture .acf-perms-enforced'); return l.hidden ? null : l.textContent; })()`);
    const deny = () => ev(`[...document.querySelectorAll('#fixture [data-type="deny"]')].map(b => ({ cap: b.dataset.cap, disabled: b.disabled, active: b.classList.contains('active') }))`);
    const setType = t => ev(`(() => { const s = document.querySelector('#fixture .acf-agent-type'); s.value = ${JSON.stringify(t)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const setMode = m => ev(`(() => { const s = document.querySelector('#fixture .acf-permission-mode'); s.value = ${JSON.stringify(m)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const chip = (type, cap) => ev(`document.querySelector('#fixture [data-type="${type}"][data-cap="${cap}"]').click(); true`);
    try {
        await c.Page.enable();
        await c.Emulation.setDeviceMetricsOverride({ width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
        await c.Page.navigate({ url: BASE + '/' }); await c.Page.loadEventFired();
        await coralReady();
        await ev(`(async () => { await (await import((window.__coralStatic || '/static/') + 'lazy_panels.js')).loadModals();
            const p = document.createElement('div'); p.id = 'fixture'; p.className = 'modal-content';
            p.style.cssText = 'position:fixed;top:20px;left:20px;width:620px;height:860px;overflow:auto;z-index:99999;background:var(--bg-primary);padding:16px';
            document.body.append(p);
            const { AGENT_PRESETS } = await import((window.__coralStatic || '/static/') + 'agent_presets.js');
            window.__presets = Object.fromEntries(AGENT_PRESETS.map(x => [x.name, x.roleLimits || x.capabilities]));
            window.renderAgentConfigForm('fixture', { showPreset: false, showName: false, value: { agentType: 'codex', capabilities: window.__presets['Frontend Dev'] } });
            document.querySelector('#fixture .permissions-toggle-btn').click(); return true; })()`);

        console.log('Codex, explicitly applied Frontend Dev limits: a sandbox and an approval mode only; Deny and patterns marked');
        let t = await line();
        assert.match(t, /^Codex keeps only a sandbox and an approval mode: a sandbox that can change files in its folder, with no network, and it asks only when the model requests it/);
        assert.match(t, /web search on.*Deny entries and shell patterns are not enforced/);
        assert.match(t, /Shell: Codex runs these without asking; the list does not stop other commands\. Pick Accept edits or Plan to be asked\.$/, 'a Shell list on Default says it is not an approval gate (#21358)');
        assert.equal(await ev(`!!document.querySelector('#fixture .acf-perms-enforced button')`), false, 'on-request has no network to turn off: no Learn more');
        assert.ok((await deny()).every(d => d.disabled), 'no new Deny entry for Codex');
        await chip('deny', 'shell');
        assert.ok((await deny()).every(d => !d.active), 'a disabled Deny chip does nothing');
        assert.equal(await ev(`document.querySelector('#fixture .perms-patterns-note').textContent`), 'Not enforced by this agent');
        assert.equal(await ev(`document.querySelector('#fixture .perms-deny-note').textContent`), 'Not enforced by this agent');
        await shot('acf-enforcement-codex');

        console.log('Claude: Allow pre-approves; in Bypass Permissions mode it restricts nothing');
        await setType('claude'); await setMode('default');
        assert.match(await line(), /^Claude: Allow pre-approves these tools and others still run after it asks; Deny blocks\.$/);
        assert.ok((await deny()).every(d => !d.disabled), 'Claude enforces Deny');
        assert.equal(await ev(`document.querySelector('#fixture .perms-patterns-note').textContent`), '');
        await setMode('bypassPermissions');
        assert.match(await line(), /Bypass Permissions mode: nothing asks, so Allow restricts nothing; only Deny blocks/);

        console.log('Antigravity: a mode only, and the line follows the chips');
        await setType('agy');
        assert.match(await line(), /^Antigravity keeps only a mode: edits are approved without asking \(--mode accept-edits\)\./);
        await chip('allow', 'shell');
        assert.match(await line(), /^Antigravity keeps only a mode: nothing asks \(--dangerously-skip-permissions\)\./, 'Shell with Write Files: skip-permissions');

        console.log('An existing Deny entry on Codex can be removed, not added to');
        await ev(`window.__coral.setAgentConfig('fixture', { agentType: 'codex', capabilities: { allow: ['file_read', 'shell'], deny: ['git_write'] } }); true`);
        let d = await deny();
        assert.deepEqual(d.filter(x => !x.disabled).map(x => x.cap), ['git_write'], 'only the active entry stays clickable');
        assert.match(await line(), /a sandbox that can change files in its folder, with no network, and it asks only when the model requests it/, 'a Deny entry changes the mode');
        await chip('deny', 'git_write');
        d = await deny();
        assert.ok(d.every(x => x.disabled && !x.active), 'removed, and now none can be added');
        assert.match(await line(), /and it never asks/, 'without the Deny entry: never asks');

        console.log('Lead Developer on Codex: a workspace-write sandbox that never asks (no sandbox is an explicit mode only); Terminal: no line');
        await ev(`window.__coral.setAgentConfig('fixture', { agentType: 'codex', capabilities: window.__presets['Lead Developer'] }); true`);
        assert.match(await line(), /a sandbox that can change files in its folder and use the network, and it never asks/);
        assert.doesNotMatch(await line(), /without a sandbox/);
        const more = await ev(`(() => { const p = document.querySelector('#fixture .acf-perms-enforced'), b = p.querySelector('button'), t = b && document.getElementById(b.getAttribute('aria-controls')); return b ? { label: b.getAttribute('aria-label'), expanded: b.getAttribute('aria-expanded'), hidden: t.hidden, code: t.querySelector('code')?.textContent } : null; })()`);
        assert.deepEqual(more, { label: 'Learn more about the network', expanded: 'false', hidden: true, code: '-c sandbox_workspace_write.network_access=false' }, 'the flag instruction is behind Learn more, in a code span');
        await ev(`document.querySelector('#fixture .acf-perms-enforced button').click(); true`);
        assert.deepEqual(await ev(`(() => { const b = document.querySelector('#fixture .acf-perms-enforced button'); return [b.getAttribute('aria-expanded'), document.getElementById(b.getAttribute('aria-controls')).hidden]; })()`), ['true', false], 'Learn more opens it');
        // Codex offers the modes it has (#10381): Default, Plan, Accept edits (#21335: it asks, Default no longer does), Auto and Bypass permissions; no Don't ask (Auto's launch), and a mode it lacks falls to Default
        assert.deepEqual(await ev(`[...document.querySelectorAll('#fixture .acf-permission-mode option')].filter(o => !o.hidden).map(o => o.textContent)`), ['Default', 'Plan', 'Accept edits', 'Auto', 'Bypass permissions'], 'Codex offers Default, Plan, Accept edits, Auto and Bypass permissions');
        assert.equal(await ev(`(() => { const sel = document.querySelector('#fixture .acf-permission-mode'); sel.value = 'acceptEdits'; sel.dispatchEvent(new Event('change', { bubbles: true })); return sel.value; })()`), 'acceptEdits', 'Accept edits stays picked on Codex: it must not fall to Default, which is Auto (#21335)');
        for (const mode of ['dontAsk']) assert.equal(await ev(`(() => { const sel = document.querySelector('#fixture .acf-permission-mode'); sel.value = '${mode}'; sel.dispatchEvent(new Event('change', { bubbles: true })); return sel.value; })()`), 'default', `${mode} is not a Codex mode: the pick falls to Default`);
        for (const [mode, words] of [['auto', 'Workspace sandbox, with the network on so it can reach Coral.'], ['default', 'Workspace sandbox, with the network on so it can reach Coral.']]) { // Default is Auto for Codex (#21335): the same words
            assert.equal(await ev(`(() => { const sel = document.querySelector('#fixture .acf-permission-mode'); if (!sel) return 'no select'; sel.value = '${mode}'; sel.dispatchEvent(new Event('change', { bubbles: true })); return document.querySelector('#fixture .perm-mode-desc').textContent; })()`), words, `${mode}: Codex says what that mode does`);
        }
        assert.match(await ev(`document.querySelector('#fixture [data-type="allow"][data-cap="git_write"]').title`), /Codex: Git Write does not change its sandbox/);
        await setType('terminal');
        assert.equal(await line(), null);

        console.log('The Launch dialog says it on Permissions only, not again under the persona (#6012)');
        await ev(`window.renderAgentConfigForm('launch-agent-acf', { showPreset: false, showName: false, value: { agentType: 'codex', capabilities: window.__presets['Security Reviewer'] } }); true`);
        assert.equal(await ev(`!!document.querySelector('[data-acf-enforced-for]')`), false, 'no second copy under the persona');
        assert.match(await ev(`document.querySelector('#launch-agent-acf .acf-perms-enforced').textContent`), /a read-only sandbox/);
        console.log('Codex on Default: a template, Getting started or role fills no chip (#21363); stored and hand-set chips stay');
        const lit = () => ev(`[...document.querySelectorAll('#fixture [data-type="allow"].active')].map(b => b.dataset.cap)`);
        const saved = () => ev(`window.getAgentConfig('fixture').capabilities`);
        const fill = (caps, areDefaults, type = 'codex') => ev(`window.__coral.setAgentConfig('fixture', { agentType: ${JSON.stringify(type)}, flags: '', capabilities: ${JSON.stringify(caps)}, capabilitiesAreDefaults: ${areDefaults} }); true`);
        const tools = { allow: ['file_read', 'file_write', 'shell', 'web_access'], deny: [] };
        await fill(tools, true); await setMode('default');
        assert.deepEqual(await lit(), [], 'Codex Default from a template: no chip lit');
        assert.equal(await saved(), null, 'and nothing saved');
        assert.equal(await ev(`document.querySelector('#fixture .acf-perms-summary').textContent`), '(default)', 'the count says so');
        assert.equal(await ev(`document.querySelector('#fixture .perms-shell-input').value`), '');
        await setMode('acceptEdits');
        assert.deepEqual(await lit(), ['file_read', 'file_write', 'shell', 'web_access'], 'Accept edits keeps the tools');
        assert.equal(await ev(`document.querySelector('#fixture .acf-perms-summary').textContent`), '(4 allow)');
        await setMode('default');
        assert.deepEqual(await lit(), [], 'back on Default: none again');
        await setType('claude');
        assert.deepEqual(await lit(), ['file_read', 'file_write', 'shell', 'web_access'], 'Claude is unchanged');
        await setType('codex'); await setMode('default');
        assert.deepEqual(await lit(), []);
        await chip('allow', 'file_read');
        assert.deepEqual(await lit(), ['file_read'], 'a chip turned on by hand');
        await setMode('acceptEdits'); await setMode('default');
        assert.deepEqual(await saved(), { allow: ['file_read'] }, 'is kept and saved as before');
        const note = /A role's limits are not applied on Default: Codex runs Auto\. Pick Plan, or turn the chips on, to keep them\.$/;
        await fill({ allow: ['file_read', 'shell:coral-board *'], deny: [] }, true); await setMode('default');
        assert.match(await line(), note, 'a limiting role on Codex Default says its limits are not applied (#21373)');
        await setMode('plan');
        assert.doesNotMatch(await line(), /not applied/, 'Plan keeps them: no note');
        await setMode('default'); await setType('claude');
        assert.doesNotMatch(await line(), /not applied/, 'Claude: no note');
        await fill({ allow: ['file_read', 'file_write', 'shell', 'web_access', 'agent_spawn'], deny: [] }, true); await setMode('default');
        assert.doesNotMatch(await line(), /not applied/, 'the shipped tools are not a limit: no note');
        await fill({ allow: ['file_read', 'shell:coral-board *'], deny: [] }, true); await setMode('default'); await chip('allow', 'shell');
        assert.doesNotMatch(await line(), /not applied/, 'a chip turned on by hand: the limits are kept, no note');
        await fill(tools, false); await setMode('default');
        assert.deepEqual(await lit(), ['file_read', 'file_write', 'shell', 'web_access'], 'a stored Codex agent keeps what it has');
        assert.deepEqual((await saved()).allow, ['file_read', 'file_write', 'shell', 'web_access']);
        console.log('The team dialog: a Codex member from a built-in template or a role has no chip lit and saves no capabilities (#21363, QA2)');
        const member = (name, caps, defaults) => ev(`(async () => {
            const { _addTeamAgent } = await import((window.__coralStatic || '/static/') + 'team_dialogs.js');
            const { SHIPPED_CAPABILITIES } = await import((window.__coralStatic || '/static/') + 'agent_presets.js');
            const row = _addTeamAgent(${JSON.stringify(name)}, 'p', ${caps ? "{ allow: [...SHIPPED_CAPABILITIES], deny: [] }" : 'null'}, 'codex', '', '', { capsAreDefaults: ${defaults} });
            const id = row.dataset.acfId, f = document.getElementById(id);
            return { mode: f.querySelector('.acf-permission-mode').value, lit: [...f.querySelectorAll('[data-type="allow"].active')].map(b => b.dataset.cap), caps: window.getAgentConfig(id).capabilities }; })()`);
        for (const [name, caps, defaults] of [['Orchestrator', true, true], ['Security Reviewer', false, false]]) {
            const m = await member(name, caps, defaults);
            assert.equal(m.mode, 'default', name + ': Default');
            assert.deepEqual(m.lit, [], name + ': no chip lit');
            assert.equal(m.caps, null, name + ': nothing saved');
        }
        console.log('acf_enforcement: ok');
        await c.close(); process.exit(0);
    } catch (e) {
        console.error('FAIL', e && e.stack || e);
        try { await c.close(); } catch { /* closing */ }
        process.exit(1);
    }
})();
