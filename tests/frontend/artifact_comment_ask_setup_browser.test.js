// Send to agent is not offered on a file of a computer set up over SSH that the hub holds no Approve secret for (#13251, the Operator): the comments panel says why and has a button that opens that computer. The button closes the file's viewer
// first (UI Reviewer: Computers opened BEHIND the viewer) and, on a phone, waits for the viewer's own Back to land. The computer's row is then in view and takes focus. A computer that has its secret shows no note. At 1280 and 390 px.
// The comments, the board's status, the artifact and the server list are stood in at the page's fetch. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const HEX = 'd'.repeat(64);
const MD = ['# Plan', '', '## Steps', '', '1. Add the new columns behind a flag.', '2. Switch reads.', ''].join('\n');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const LIST = stamp => [{ id: 'local', label: 'studio-mac', local: true, status: 'online' }, { id: 'ssh-box', label: 'Build box', transport: 'ssh', ssh_target: 'rich@box.example.com:22', url: 'ssh://rich@box.example.com:22', status: 'online', owner_stamp: stamp }];
    const STUB = stamp => `(() => {
        const real = window.fetch; window.__list = ${JSON.stringify(LIST(stamp))};
        const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o) => {
            const url = String(u), method = (o && o.method) || 'GET';
            if (new URL(url, location.origin).pathname === '/api/servers' && method === 'GET') return json(window.__list);
            if (/\\/api\\/board\\/[^/]+\\/status/.test(url)) return json({ agents: [], summary: {}, unassigned_tasks: [], health_report: [], observed_at: new Date().toISOString() });
            if (url.includes('/api/artifacts/${HEX}/comments')) return json({ comments: [{ id: 1, parent_id: null, anchor: { quote: 'behind a flag.', prefix: 'columns', suffix: '2.' }, body: 'Why a flag?', author: { kind: 'owner', issuer: 'local', subject: 'Operator', name: 'You' }, created_at: new Date().toISOString(), deleted: false, mine: true, can: { reply: true, edit: false, delete: false, resolve: true } }], locked: false, you: { can_comment: true, can_lock: true }, limits: {} });
            if (url.includes('/api/artifacts/${HEX}')) return Promise.resolve(new Response(${JSON.stringify(MD)}, { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
            return real(u, o);
        };
        return true; })()`;
    const open = async stamp => {
        await ev(STUB(stamp));
        await ev(`import(${S} + 'state.js').then(m => { m.state.hub = true; m.state.servers = window.__list; return true; })`);
        await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'plan.md', server: 'ssh-box', board: 'team-a' }); return true; })()`);
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`, 'the document', 8000);
        await waitFor(`document.querySelectorAll('.ac-card').length >= 1`, 'the thread', 8000);
        await ev(`(() => { const t = document.querySelector('.ac-toggle'); if (t && t.getAttribute('aria-expanded') !== 'true') t.click(); return true; })()`);
        await sleep(300); // sleep-ok: the panel opens over a frame or two
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            // a computer that has its secret: no note
            await open(true);
            assert.equal(await ev(`!!document.querySelector('.ac-ask-setup')`), false, at + 'no note where the secret is held');
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            // one that has none: the note, and a button that takes the person to the computer, with the viewer closed
            await open(false);
            const note = await ev(`document.querySelector('.ac-ask-setup')?.textContent || ''`);
            assert.match(note, /Send to agent is not set up for this computer/, at + 'the note says so: ' + note);
            assert.match(note, /Set up approvals/, at + 'and says where it is set up: ' + note);
            const btn = `document.querySelector('.ac-ask-setup-open')`;
            assert.equal(await ev(`${btn}?.textContent`), 'Open the computer', at + 'the button');
            await ev(`${btn}.click(); true`);
            await waitFor(`document.getElementById('artifact-viewer')?.hidden === true`, at + 'the viewer closes first', 5000);
            await waitFor(`!!document.getElementById('server-row-ssh-box')`, at + "the computer's row is drawn on the Computers page", 10000);
            const seen = await ev(`(() => { const row = document.getElementById('server-row-ssh-box'); if (!row) return null; const r = row.getBoundingClientRect(); const top = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.left + 4)), Math.min(innerHeight - 1, Math.max(0, r.top + 4)));
                return { visible: row.checkVisibility(), inView: r.bottom > 0 && r.top < innerHeight, onTop: !!top && row.contains(top), viewerOpen: !!document.querySelector('#artifact-viewer:not([hidden])') }; })()`);
            assert.ok(seen, at + 'the computer\'s row is on the page');
            assert.equal(seen.viewerOpen, false, at + 'the viewer is not open over it');
            assert.ok(seen.visible && seen.inView, at + 'the row is visible and in view: ' + JSON.stringify(seen));
            assert.ok(seen.onTop, at + 'nothing covers the row (the viewer used to): ' + JSON.stringify(seen));
            console.log(`   ✓ ${w} px`);
        }
        console.log('PASS the comments panel says why Send to agent is missing and opens the computer with the viewer closed');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
