// #15121: repeat bulk-provider choice keeps worker models; earlier fixes stay intact.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const { install: installNT, T, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`, failures = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNT(ev); await stubModels(ev);
            await openNewTeam(ev, waitFor); await T(ev, waitFor).to(2, { template: /Coding/ });
            await ev(`(async () => { const m = await import(${S} + 'agent_config_form.js'); window.__configs = m;
                const rows = [...document.querySelectorAll('#team-agents-list .team-agent-row')];
                for (const row of rows) m.setAgentConfig(row.dataset.acfId, { ...m.getAgentConfig(row.dataset.acfId), agentType: 'claude', model: 'claude-small', thinking: 'high' }); return true; })()`);
            await ev(framesJs(4));
            const configs = () => ev(`[...document.querySelectorAll('#team-agents-list .team-agent-row')].map(r => window.__configs.getAgentConfig(r.dataset.acfId)).map(c => ({ type: c.agentType, model: c.model, thinking: c.thinking }))`);
            const before = await configs();
            await ev(`(() => { const s = document.getElementById('team-set-all'); s.value = 'claude'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await ev(framesJs(6));
            if (JSON.stringify(await configs()) !== JSON.stringify(before)) failures.push(`${width}: choosing the same provider cleared model/thinking`);
            await ev(`(async () => { await window.showTeamAgentModal(document.querySelector('#team-agents-list .team-agent-row')); return true; })()`);
            const nested = await ev(`/Step [12] of 2/.test(document.getElementById('launch-modal').innerText)`);
            if (nested) failures.push(`${width}: nested member step count`);
            await ev(`window.hideLaunchModal(); true`);
            await ev(`(() => { const s = document.getElementById('team-set-all'); s.value = 'codex'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await ev(framesJs(6));
            const changed = await ev(`[...document.querySelectorAll('#team-agents-list .team-agent-row')].map(r => ({ role: r.querySelector('.team-agent-role')?.value || r.dataset.role, config: window.__configs.getAgentConfig(r.dataset.acfId) }))`);
            // The existing members suite covers role exclusions; every changed
            // provider must drop the previous provider's model.
            if (!changed.some(r => r.config.agentType === 'codex') || changed.some(r => r.config.agentType === 'codex' && r.config.model === 'claude-small')) failures.push(`${width}: changed provider retained incompatible model`);
            // The shared artifact table already gives Name the free width. Guard the
            // reported short README name, including its icon and review badge.
            await ev(`(async () => { const { artifactTable } = await import(${S} + 'artifact_table.js');
                const host = document.createElement('main'); host.id = 'walk-artifacts'; host.style.cssText = 'width:100%;max-width:100%;';
                document.body.replaceChildren(host);
                host.append(artifactTable({ label: 'Walk artifacts', rows: [{ id: 'a'.repeat(64), name: 'README.md', size: 100, created_at: '2026-11-01T00:00:00Z' }], nameBadge: () => { const n = document.createElement('span'); n.className = 'team-artifact-badge'; n.textContent = 'For review'; return n; } }).el); return true; })()`);
            await ev(framesJs(8));
            const name = await ev(`(() => { const b = document.querySelector('#walk-artifacts .dt-primary'); return { text: b.textContent, width: b.clientWidth, full: b.scrollWidth }; })()`);
            if (name.text !== 'README.md' || name.full > name.width + 1) failures.push(`${width}: artifact name cut: ${JSON.stringify(name)}`);
        }
        assert.deepEqual(failures, []);
        console.log('walk3_small_fixes_browser: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
