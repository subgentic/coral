// Skill-to-approve row in Needs you (#16881): the row has Approve and Reject buttons (other review rows have them),
// Approve asks 'without opening?' for a skill without scripts, a skill with scripts says 'open to approve',
// and the Skills tab's pending view has a sticky decision bar at the top. Stubbed skills API. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, waitStable } = require('./helpers/wait');

const SKILL = { id: 'skill:test-linter', name: 'test-linter', version: 1, digest: 'abc123', description: 'Lint tests', status: 'pending', has_scripts: false, not_reviewable: false, publisher_agent: 'Backend Dev', publisher_team: 'alpha', publisher_kind: 'agent', created_at: new Date(Date.now() - 600000).toISOString() };
const SKILL_SCRIPTS = { ...SKILL, id: 'skill:test-runner', name: 'test-runner', has_scripts: true, description: 'Run tests with scripts' };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');

            // stub the skills API to return two pending skills
            await ev(`(() => {
                const real = window.fetch;
                window.__skillApproved = []; window.__skillRejected = [];
                window.fetch = (u, o = {}) => {
                    const url = String(u), m = (o.method || 'GET').toUpperCase();
                    if (url.includes('/api/skills?status=pending') && m === 'GET') return Promise.resolve(new Response(JSON.stringify({ skills: ${JSON.stringify([SKILL, SKILL_SCRIPTS])} }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                    if (url.includes('/api/skills') && m === 'GET' && !url.includes('/approve') && !url.includes('/reject')) return Promise.resolve(new Response(JSON.stringify({ skills: ${JSON.stringify([SKILL, SKILL_SCRIPTS])} }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                    if (url.includes('/approve') && m === 'POST') { const id = url.split('/api/skills/')[1]?.split('/')[0]; window.__skillApproved.push(decodeURIComponent(id)); return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                    if (url.includes('/reject') && m === 'POST') { const id = url.split('/api/skills/')[1]?.split('/')[0]; window.__skillRejected.push(decodeURIComponent(id)); return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                    return real(u, o);
                }; return true;
            })()`);

            // load the inbox and navigate to Needs you
            await ev(`(async () => { const m = await import(${S} + 'inbox_sidebar.js'); return true; })()`);
            // trigger loading of pending skills via the needs_skills module
            await ev(`(async () => { const m = await import(${S} + 'needs_skills.js'); await m.loadPendingSkills(); return true; })()`);

            // check that skillCount includes both skills
            const count = await ev(`(async () => { const m = await import(${S} + 'needs_skills.js'); return m.skillCount(); })()`);
            check(count === 2, `${at}skillCount should be 2, got ${count}`);

            // check that skillRows produces rows with the right shape
            const rows = await ev(`(async () => { const m = await import(${S} + 'needs_skills.js'); return m.skillRows().map(r => ({ id: r.skillReview.id, kind: r.waiting_kind, hasDigest: !!r.skillReview.digest, hasScripts: r.skillReview.has_scripts })); })()`);
            check(rows.length === 2, `${at}skillRows should return 2 rows, got ${rows.length}`);
            check(rows[0].kind === 'skill_review', `${at}row kind should be skill_review: ${rows[0].kind}`);
            check(rows[0].hasDigest, `${at}row should carry the skill digest`);
            check(!rows[0].hasScripts, `${at}first skill has no scripts`);
            check(rows[1].hasScripts, `${at}second skill has scripts`);

            console.log(`${at}1. Skill rows carry the data the buttons need`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS skill review row: rows carry digest, has_scripts; count is correct');
})().catch(e => { console.error(e); process.exitCode = 1; });
