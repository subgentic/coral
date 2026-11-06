// Send to agent starts with the uploader of the version being viewed ticked (#13995, the Operator: "the one that uploaded the doc should be the default"): only when that agent is in the list and can be asked now; the other agents stay
// listed and can be added, and the default unticked. Four cases: the uploader is awake (ticked), asleep (nothing), already asked into this thread (nothing), not on this board (nothing). At 1280 and 390 px. Isolated dev server.
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const HEX = 'e'.repeat(64);
const MD = ['# Migration plan', '', '## Steps', '', '1. Add the new columns behind a flag and backfill in batches of 500 rows.', '2. Switch reads to the new columns.', ''].join('\n');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const STUB = `(() => {
        const real = window.fetch; window.__sends = [];
        window.__cs = [
            { id: 1, asks: [{ agent: 'Reviewer', open: true, replies: 2, seen: true, nudged: true }, { agent: 'Docs Writer', open: false, replies: 0, seen: true, nudged: true }], parent_id: null, anchor: { quote: 'backfill in batches of 500 rows.', prefix: 'columns behind a flag and', suffix: '2. Switch' }, body: 'Batches of 500 is too small. Try 5,000.', author: { kind: 'owner', issuer: 'local', subject: 'Operator', name: 'You' }, created_at: new Date(Date.now() - 600000).toISOString() },
            { id: 2, parent_id: 1, anchor: null, body: 'Measured: 9 s per 5,000.', author: { kind: 'agent', issuer: 'local', subject: 'qa', name: 'QA Engineer' }, created_at: new Date(Date.now() - 60000).toISOString() },
            { id: 3, parent_id: null, anchor: { quote: 'Switch reads to the new columns.' }, body: 'Fine.', author: { kind: 'owner', issuer: 'local', subject: 'Operator', name: 'You' }, created_at: new Date(Date.now() - 86400000).toISOString(), resolved_at: new Date(Date.now() - 80000000).toISOString(), resolved_by: { subject: 'Operator' } },
        ];
        if (window.__oldThread) window.__cs[0].artifact_id = window.__oldThread; // a thread written on an earlier version
        window.__agents = [
            { name: 'QA', role: 'QA Engineer', agent_type: 'claude', availability: 'available' },
            { name: 'Backend', role: 'Backend Dev', agent_type: 'codex', availability: 'busy' },
            { name: 'Sleepy', role: 'UI Dev', agent_type: 'claude', availability: 'sleeping' },
            { name: 'Gone', role: 'Docs Writer', agent_type: 'claude', availability: 'offline' },
            { name: 'Rev', role: 'Reviewer', agent_type: 'claude', availability: 'available' },
            { name: 'shell', role: 'Shell', agent_type: 'terminal', availability: 'unavailable' },
        ];
        window.__versions = null; window.__rows = [{ id: '${HEX}', uri: 'coral://artifacts/${HEX}', name: 'plan.md', produced_by: 'QA Engineer' }]; window.__send = { status: 200, body: null }; window.__you = { can_comment: true, can_lock: true };
        const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o) => {
            const url = String(u), method = (o && o.method) || 'GET';
            if (/\\/api\\/board\\/[^/]+\\/status/.test(url)) return json({ agents: window.__agents, summary: {}, unassigned_tasks: [], health_report: [], observed_at: new Date().toISOString() });
            if (url.includes('/api/artifacts/${HEX}/comments')) {
                const sub = url.split('/comments')[1].split('?')[0];
                if (method === 'POST' && /^\\/\\d+\\/send$/.test(sub)) {
                    const b = JSON.parse(o.body); window.__sends.push({ id: Number(sub.split('/')[1]), agents: b.agents });
                    if (window.__send.body) return json(window.__send.body, window.__send.status);
                    return json({ ok: true, results: b.agents.map((a, i) => ({ agent: a, state: a === 'Backend Dev' ? 'already_asked' : 'sent', ask_id: i + 1 })) });
                }
                const can = c => ({ reply: c.parent_id == null, edit: false, delete: false, resolve: c.parent_id == null });
                return json({ comments: window.__cs.map(c => ({ ...c, deleted: false, mine: c.author.kind === 'owner', can: can(c) })), locked: false, you: window.__you, limits: {} });
            }
            if (/\\/api\\/board\\/ask-team\\/artifacts\\?/.test(url)) { window.__listReads = (window.__listReads || 0) + 1; return json({ artifacts: window.__rows, has_more: false }); } // the picker must never page the team's list
            if (/\\/api\\/artifacts\\/series\\/[0-9a-f]{32}\\/versions/.test(url)) { window.__seriesReads = (window.__seriesReads || 0) + 1; return window.__seriesRows ? json(window.__seriesRows) : json({ error: 'not found' }, 404); }
            if (url.includes('/api/artifacts/${HEX}/versions')) window.__versionReads = (window.__versionReads || 0) + 1;
            if (url.includes('/api/artifacts/${HEX}/versions')) return window.__versions ? json(window.__versions) : json({ error: 'not found' }, 404); // a file in no series has no list
            if (url.includes('/api/artifacts/${HEX}')) return Promise.resolve(new Response(${JSON.stringify(MD)}, { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
            return real(u, o);
        };
        return true; })()`;
    const open = async (board, you, noAsks, hint) => {
        await ev(STUB);
        if (noAsks) await ev(`window.__cs[0].asks = []; true`);
        if (you) await ev(`window.__you = ${JSON.stringify(you)}; true`);
        await ev(`import(${S} + 'state.js').then(m => { m.state.liveSessions = [{ session_id: 'sess-qa', name: 'qa-agent', agent_type: 'claude', board_subscriber_id: 'QA Engineer', board_project: ${JSON.stringify(board || '')} }]; window.__opened = null; window.selectLiveSession = (...a) => { window.__opened = a; }; return true; })`); // QA Engineer is running; Reviewer and Docs Writer are not (#12168)
        await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'plan.md', ${board ? `board: '${board}'` : ''}${hint ? `, uploader: ${JSON.stringify(hint)}` : ''} }); return true; })()`);
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`, 'the document', 8000);
        await waitFor(`document.querySelectorAll('.ac-card').length >= 1`, 'the threads', 8000);
        await ev(`(() => { const t = document.querySelector('.ac-toggle'); if (t && t.getAttribute('aria-expanded') !== 'true') t.click(); return true; })()`);
        await sleep(300); // sleep-ok: the panel opens over a frame or two
    };
    const sendBtn = id => `document.querySelector('.ac-card[data-id="${id}"] .ac-ask-open')`;
    const block = () => ev(`(() => { const b = document.querySelector('.ac-ask'); if (!b) return null;
        return { title: b.querySelector('.ac-ask-title').textContent, agents: [...b.querySelectorAll('.ac-ask-agent')].map(li => ({ role: li.querySelector('input').value, text: li.textContent.replace(/\\s+/g, ' ').trim(), disabled: li.querySelector('input').getAttribute('aria-disabled') === 'true' && !li.querySelector('input').disabled, checked: li.querySelector('input').checked, state: li.dataset.state || '' })),
            note: b.querySelector('.ac-ask-note').textContent, go: (b.querySelector('.ac-ask-go') || {}).textContent || '', goDisabled: !!b.querySelector('.ac-ask-go') && b.querySelector('.ac-ask-go').disabled, close: (b.querySelector('.ac-cancel') || {}).textContent, error: b.querySelector('.ac-error').hidden ? '' : b.querySelector('.ac-error').textContent,
            fits: b.getBoundingClientRect().right <= innerWidth + 1 && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 }; })()`);
    const ticked = () => ev(`[...document.querySelectorAll('.ac-ask input[type="checkbox"]')].filter(i => i.checked).map(i => i.value)`);
    const uploader = (role, setup) => ev(`window.__rows[0] && (window.__rows[0].produced_by = ${JSON.stringify(role)}); ${setup || ''} true`); // after open(): it installs the stub afresh
    const openPicker = async () => { await ev(`document.querySelector('.ac-card[data-id="1"] .ac-ask-open').click(); true`); await waitFor(`!!document.querySelector('.ac-ask input[type="checkbox"]')`, 'the picker', 8000); await sleep(300); }; // sleep-ok: the uploader's lookup and the redraw
    const closeViewer = async () => { await ev(`document.querySelector('#artifact-viewer [data-dialog-close], #artifact-viewer .artifact-viewer-close')?.click(); true`); await sleep(300); }; // sleep-ok: the viewer closes over a frame
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`try { localStorage.removeItem('coral-artifact-comments-open'); } catch {} true`);
            const hint = role => ({ role, hex: HEX, server: 'local', board: 'ask-team' }); // what the Inbox review row and the Team Artifacts row pass: the record they already hold
            // 1) the opener knows the uploader and it is awake and on the board: ticked, the others listed and unticked; it can be unticked, and another added
            await open('ask-team', undefined, true, hint('QA Engineer'));
            await openPicker();
            check(`${tag}: the uploader (QA Engineer) is ticked when the picker opens`, JSON.stringify(await ticked()) === JSON.stringify(['QA Engineer']), JSON.stringify(await ticked()));
            check(`${tag}: the other agents stay listed`, (await block()).agents.length >= 5, JSON.stringify((await block()).agents.map(a => a.role)));
            await shot(`ask-default-${w}`);
            await ev(`[...document.querySelectorAll('.ac-ask input[type="checkbox"]')].find(i => i.value === 'Backend Dev').click(); true`);
            check(`${tag}: another agent can be added`, JSON.stringify((await ticked()).sort()) === JSON.stringify(['Backend Dev', 'QA Engineer']), JSON.stringify(await ticked()));
            await ev(`[...document.querySelectorAll('.ac-ask input[type="checkbox"]')].find(i => i.value === 'QA Engineer').click(); true`);
            check(`${tag}: and the default can be unticked`, JSON.stringify(await ticked()) === JSON.stringify(['Backend Dev']), JSON.stringify(await ticked()));
            await closeViewer();
            // 2) the uploader is asleep: nothing is ticked
            await open('ask-team', undefined, true, hint('UI Dev')); await openPicker();
            check(`${tag}: an uploader that is asleep is not ticked`, (await ticked()).length === 0, JSON.stringify(await ticked()));
            await closeViewer();
            // 3) the uploader was already asked into this thread: nothing is ticked
            await open('ask-team', undefined, false, hint('Reviewer')); await openPicker();
            check(`${tag}: an uploader already asked into this thread is not ticked`, (await ticked()).length === 0, JSON.stringify(await ticked()));
            await closeViewer();
            // 4) the uploader is not on this board: nothing is ticked
            await open('ask-team', undefined, true, hint('Ghost Writer')); await openPicker();
            check(`${tag}: an uploader that is not on this board is not ticked`, (await ticked()).length === 0, JSON.stringify(await ticked()));
            await closeViewer();
            // 5) a hint captured for ANOTHER version, computer or team is never used for this one
            for (const [what, h] of [['another version', { ...hint('QA Engineer'), hex: 'd'.repeat(64) }], ['another computer', { ...hint('QA Engineer'), server: 'other' }], ['another team', { ...hint('QA Engineer'), board: 'other-team' }]]) {
                await open('ask-team', undefined, true, h); await openPicker();
                check(`${tag}: an uploader captured for ${what} is not used`, (await ticked()).length === 0, JSON.stringify(await ticked()));
                await closeViewer();
            }
            // 6) an OLD thread (written on v1) while viewing v2: the DISPLAYED version's uploader is the default, not the thread's own version's
            await ev(`window.__oldThread = '${'d'.repeat(64)}'; true`);
            await open('ask-team', undefined, true, hint('QA Engineer')); await openPicker();
            check(`${tag}: a thread written on v1 while viewing v2 defaults to the viewed version's uploader`, JSON.stringify(await ticked()) === JSON.stringify(['QA Engineer']), JSON.stringify(await ticked()));
            await closeViewer();
            await open('ask-team', undefined, true, { ...hint('Backend Dev'), hex: 'd'.repeat(64) }); await openPicker();
            check(`${tag}: the record of v1 is not used while v2 is displayed, whatever the thread's own version`, (await ticked()).length === 0, JSON.stringify(await ticked()));
            await closeViewer();
            await ev(`window.__oldThread = null; true`);
            // 6b) the viewer moved to another version of the same series (the record was captured for v1): the series route, with the series_id the row held, names that version's uploader
            const SID = 'a'.repeat(32), v1 = 'd'.repeat(64);
            const series = (r1, r2) => `window.__seriesRows = [{ digest: '${v1}', version: 1, versions: 2, is_latest: false, name: 'plan.md', at: '', uploader: 'x', role: ${JSON.stringify(r1)} }, { digest: '${HEX}', version: 2, versions: 2, is_latest: true, name: 'plan.md', at: '', uploader: 'y', role: ${JSON.stringify(r2)} }]; window.__seriesReads = 0;`;
            await open('ask-team', undefined, true, { role: 'Backend Dev', hex: v1, server: 'local', board: 'ask-team', seriesId: SID }); await ev(series('Backend Dev', 'QA Engineer') + ' true'); await openPicker();
            check(`${tag}: viewing v2 with a record captured for v1 ticks v2's uploader from the series route (QA Engineer), not v1's (Backend Dev)`, JSON.stringify(await ticked()) === JSON.stringify(['QA Engineer']), JSON.stringify(await ticked()));
            check(`${tag}: through the series route, once`, (await ev(`window.__seriesReads`)) === 1, String(await ev(`window.__seriesReads`)));
            await closeViewer();
            await open('ask-team', undefined, true, { role: 'Backend Dev', hex: v1, server: 'local', board: 'ask-team', seriesId: SID }); await ev(series('Backend Dev', 'Docs Writer') + ' true'); await openPicker();
            check(`${tag}: a series row naming an agent that is not running ticks nobody`, (await ticked()).length === 0, JSON.stringify(await ticked()));
            await closeViewer();
            await open('ask-team', undefined, true, { role: 'Backend Dev', hex: v1, server: 'local', board: 'other-team', seriesId: SID }); await ev(series('Backend Dev', 'QA Engineer') + ' true'); await openPicker();
            check(`${tag}: a record captured for another team never reaches the series route`, (await ticked()).length === 0 && (await ev(`window.__seriesReads`)) === 0, JSON.stringify([await ticked(), await ev(`window.__seriesReads`)]));
            await closeViewer();
            await ev(`window.__seriesRows = null; true`);
            // 7) no opener record: nobody is ticked, whatever the team's list or the file's series say (they are never read for it: the versions list is the first series across teams, so two teams sharing bytes could name the other's uploader)
            await open('ask-team', undefined, true); await ev(`window.__versions = [{ digest: '${HEX}', version: 2, versions: 2, is_latest: true, name: 'plan.md', at: '', uploader: 'x', role: 'QA Engineer' }]; window.__versionReads = 0; window.__listReads = 0; true`); await openPicker();
            check(`${tag}: with no record nobody is ticked, though the versions list and the team's list name QA Engineer`, (await ticked()).length === 0, JSON.stringify(await ticked()));
            check(`${tag}: neither the team's artifact list nor the versions list is read when the picker opens`, (await ev(`window.__listReads || 0`)) === 0 && (await ev(`window.__versionReads || 0`)) === 0, JSON.stringify(await ev(`[window.__listReads, window.__versionReads]`)));
            await closeViewer();
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Send to agent default checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
