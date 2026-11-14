// #16881: the skill-to-approve row in Needs you has Approve and Reject buttons (the parent has only Review),
// Approve asks 'without opening?' for a skill without scripts, 'Open to approve' for one with scripts,
// Reject asks 'Reject this skill?', the POSTs carry the digest and scripts_acked, and the Skills tab's
// pending view has a .skills-decision-bar above the Files section. Each assertion fails on the parent.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const D1 = 'b'.repeat(64), D2 = 'c'.repeat(64);
const SKILL = { id: '2'.repeat(32), name: 'test-linter', version: 1, digest: D1, description: 'Lint tests', status: 'pending', has_scripts: false, not_reviewable: false, publisher_agent: 'Backend Dev', publisher_team: 'alpha', publisher_kind: 'agent', created_at: '2026-11-02T09:00:00Z' };
const SKILL_SCRIPTS = { id: '3'.repeat(32), name: 'test-runner', version: 2, digest: D2, description: 'Run tests', status: 'pending', has_scripts: true, not_reviewable: false, publisher_agent: 'Dev', publisher_team: 'beta', publisher_kind: 'agent', created_at: '2026-11-02T08:00:00Z' };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');

        await ev(`(() => {
            const real = window.fetch; window.__calls = [];
            const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
            const skills = ${JSON.stringify([SKILL, SKILL_SCRIPTS])};
            const detail = { skill: skills[0], files: [{ path: 'SKILL.md', size: 90, kind: 'instructions', sha256: 'f'.repeat(64) }], contents: { 'SKILL.md': '# Lint tests' }, warnings: [], hosts: [] };
            const detail2 = { skill: skills[1], files: [{ path: 'SKILL.md', size: 90, kind: 'instructions', sha256: 'f'.repeat(64) }, { path: 'scripts/run.sh', size: 40, kind: 'script', sha256: 'e'.repeat(64) }], contents: { 'SKILL.md': '# Run tests', 'scripts/run.sh': '#!/bin/sh\\necho run' }, warnings: [], hosts: [] };
            window.fetch = (u, o = {}) => {
                const url = new URL(String(u && u.url || u), location.origin), m = (o.method || 'GET').toUpperCase(), p = url.pathname;
                if (p === '/api/skills' && url.searchParams.get('status') === 'pending') return json({ skills });
                if (p === '/api/skills' && m === 'GET') return json({ skills });
                if (p === '/api/skills/${SKILL.id}' && m === 'GET') return json(detail);
                if (p === '/api/skills/${SKILL_SCRIPTS.id}' && m === 'GET') return json(detail2);
                if (p.endsWith('/approve') && m === 'POST') { window.__calls.push(m + ' ' + p + ' ' + (o.body || '')); return json({ ok: true }); }
                if (p.endsWith('/reject') && m === 'POST') { window.__calls.push(m + ' ' + p + ' ' + (o.body || '')); return json({ ok: true }); }
                return real(u, o);
            }; return true;
        })()`);

        await ev(`window.switchNavTab('hub-inbox', { folder: 'needs' }); true`);
        await waitFor(`/test-linter/.test(document.getElementById('group-table-view')?.innerText || '')`, 'skill rows in Needs you', 10000);

        // 1. Approve and Reject buttons on the row (the parent has only Review)
        const btns = await ev(`(() => {
            const row = [...document.querySelectorAll('#group-table-view tr.dt-row')].find(r => /test-linter/.test(r.textContent));
            return row ? [...row.querySelectorAll('button')].map(b => ({ text: b.textContent.trim(), label: b.getAttribute('aria-label') || '' })) : null;
        })()`);
        assert.ok(btns, 'the test-linter row is in Needs you');
        assert.ok(btns.some(b => b.text === 'Approve'), 'Approve button on the row: ' + JSON.stringify(btns.map(b => b.text)));
        assert.ok(btns.some(b => b.text === 'Reject'), 'Reject button on the row');
        assert.ok(btns.some(b => b.label === 'Approve: test-linter'), 'Approve has the right aria-label');

        // 2. Approve on a skill without scripts → 'Approve without opening?'
        await ev(`document.querySelector('#group-table-view button[aria-label="Approve: test-linter"]').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display === 'flex'`, 'the confirm modal for Approve', 4000);
        assert.equal(await ev(`document.getElementById('confirm-modal-title').textContent`), 'Approve without opening?');
        await ev(`document.getElementById('confirm-modal-yes').click(); true`);
        await waitFor(`window.__calls.some(c => c.includes('/approve'))`, 'the approve POST', 6000);
        const ac = await ev(`window.__calls.find(c => c.includes('/approve'))`);
        assert.ok(ac.includes(SKILL.id), 'approve targets the right skill');
        const ab = JSON.parse(ac.slice(ac.indexOf('{')));
        assert.deepEqual(ab, { digest: D1, scripts_acked: false }, 'approve payload: digest + scripts_acked false');

        // 3. Approve on a skill with scripts → 'Open to approve'
        await ev(`window.__calls = []; true`);
        await waitFor(`document.querySelector('#group-table-view button[aria-label="Approve: test-runner"]')`, 'test-runner Approve button', 6000);
        await ev(`document.querySelector('#group-table-view button[aria-label="Approve: test-runner"]').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display === 'flex'`, 'the scripts confirm modal', 4000);
        assert.equal(await ev(`document.getElementById('confirm-modal-title').textContent`), 'Open to approve');
        await ev(`document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)').click(); true`);

        // 4. Reject → 'Reject this skill?'
        await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'flex'`, 'modal dismissed', 2000);
        await ev(`document.querySelector('#group-table-view button[aria-label="Reject: test-runner"]').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display === 'flex'`, 'the reject confirm modal', 4000);
        assert.equal(await ev(`document.getElementById('confirm-modal-title').textContent`), 'Reject this skill?');
        await ev(`document.getElementById('confirm-modal-yes').click(); true`);
        await waitFor(`window.__calls.some(c => c.includes('/reject'))`, 'the reject POST', 6000);
        assert.ok((await ev(`window.__calls.find(c => c.includes('/reject'))`)).includes(SKILL_SCRIPTS.id), 'reject targets the right skill');

        // 5. Skills tab: .skills-decision-bar above the Files section (the parent has none)
        await ev(`window.switchNavTab('skills', { skillId: '${SKILL.id}' }); true`);
        await waitFor(`document.querySelector('#skills-view .skills-banner')`, 'the pending skill view', 8000);
        assert.ok(await ev(`!!document.querySelector('#skills-view .skills-decision-bar')`), '.skills-decision-bar exists');
        const pos = await ev(`(() => {
            const bar = document.querySelector('#skills-view .skills-decision-bar');
            const files = [...document.querySelectorAll('#skills-view .skills-section h3')].find(h => /Files/.test(h.textContent));
            return bar && files ? { b: bar.getBoundingClientRect().top, f: files.getBoundingClientRect().top } : null;
        })()`);
        assert.ok(pos, 'both the decision bar and the Files heading exist');
        assert.ok(pos.b < pos.f, '.skills-decision-bar is above the Files section');

        console.log('PASS skill review row: Approve/Reject buttons, confirm modals, POSTs, decision bar');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
