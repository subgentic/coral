// #13687 end to end (QA Reviewer 2's SHOULD): a file on a REMOTE computer of the Hub, its team's agents listed by that computer with no role on the team. The picker asks THAT computer (/api/remote/<id>/api/board/<team>/status, the
// key '@<computer>/<team>'), never this one (which has no such team and would answer an empty list), and an empty picker says which computer was asked and how many agents it listed. The route's answers are stood in at the page's fetch.
// Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const HEX = 'd'.repeat(64);
const TEAM = 'b-remote1xyz';
const MD = ['# Plan', '', 'Backfill in batches of 500 rows.', ''].join('\n');
(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const STUB = `(() => {
        const real = window.fetch; window.__statusAsked = [];
        const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o) => {
            const url = String(u), method = (o && o.method) || 'GET';
            if (/\\/api\\/board\\/[^/]+\\/status/.test(url)) {
                window.__statusAsked.push(url);
                if (url.startsWith('/api/remote/m1/')) return json({ agents: [{ name: 'worker-1', agent_type: 'claude', availability: 'available' }, { name: 'worker-2', agent_type: 'codex', availability: 'busy' }], summary: {}, unassigned_tasks: [], health_report: [], observed_at: new Date().toISOString() });
                return json({ agents: [], summary: {}, unassigned_tasks: [], health_report: [], observed_at: new Date().toISOString() }); // this computer has no such team
            }
            if (url.includes('/api/artifacts/${HEX}/comments')) return json({ comments: [{ id: 1, parent_id: null, anchor: null, body: 'Is this slower?', author: { kind: 'owner', issuer: 'local', subject: 'Operator', name: 'You' }, created_at: new Date(Date.now() - 60000).toISOString(), deleted: false, mine: true, can: { reply: true, edit: false, delete: false, resolve: true } }], locked: false, you: { can_comment: true, can_lock: true }, limits: {} });
            if (url.includes('/api/artifacts/${HEX}')) return Promise.resolve(new Response(${JSON.stringify(MD)}, { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
            return real(u, o);
        };
        return true; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`try { localStorage.removeItem('coral-artifact-comments-open'); } catch {} true`);
            await ev(STUB);
            await ev(`import(${S} + 'state.js').then(m => { m.state.servers = [{ id: 'm1', name: 'build-box', owner_stamp: true }]; }); true`);
            await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'plan.md', server: 'm1', board: '${TEAM}' }); return true; })()`);
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`, 'the document', 8000);
            await waitFor(`document.querySelectorAll('.ac-card').length >= 1`, 'the threads', 8000);
            await ev(`(() => { const t = document.querySelector('.ac-toggle'); if (t && t.getAttribute('aria-expanded') !== 'true') t.click(); return true; })()`);
            await sleep(300); // sleep-ok: the panel opens over a frame or two
            await waitFor(`!!document.querySelector('.ac-card[data-id="1"] .ac-ask-open')`, 'Send to agent on a remote computer', 8000);
            await ev(`document.querySelector('.ac-card[data-id="1"] .ac-ask-open').click(); true`);
            await waitFor(`!!document.querySelector('.ac-ask') && !/Looking for the agents/.test(document.querySelector('.ac-ask').textContent)`, 'the picker answered', 8000);
            const asked = await ev('window.__statusAsked');
            check(`${tag}: the team's agents are asked of the remote computer, once, and not of this one: ${JSON.stringify(asked)}`, asked.length >= 1 && asked.every(u => u.startsWith(`/api/remote/m1/api/board/${TEAM}/status`)));
            const text = await ev(`document.querySelector('.ac-ask').textContent.replace(/\\s+/g, ' ').trim()`);
            check(`${tag}: the empty picker says which computer and how many agents it listed: ${text}`, /the computer build-box lists 2 agents, 2 without a role on the team or a terminal/.test(text));
            check(`${tag}: it offers no agent to pick`, (await ev(`document.querySelectorAll('.ac-ask input[type="checkbox"]').length`)) === 0);
            await ev(`document.querySelector('#artifact-viewer [data-dialog-close], #artifact-viewer .artifact-viewer-close')?.click(); true`);
            await sleep(300); // sleep-ok: the viewer closes over a frame
        }
        const failed = results.filter(r => !r).length;
        console.log(`${results.length - failed} of ${results.length} checks passed`);
        await client.close(); process.exit(failed ? 1 : 0);
    } catch (e) { console.error('FAIL', e && e.stack || e); await client.close().catch(() => {}); process.exit(1); }
})();
