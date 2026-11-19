// The Send to agent picker leads with the agent that made the artifact (ticked) and the Orchestrator, and folds every other agent under 'More agents' (#19807, the Operator: 40+ agents, most asleep, made the list a wall).
// The maker is the Orchestrator: shown once. Neither on the list: every agent is shown, as before. A ticked agent in the fold keeps it open. At 1280 and 390 px. Isolated dev server.
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
            { name: 'Orch', role: 'Orchestrator', agent_type: 'claude', availability: 'available' },
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
    const openPicker = async () => { await ev(`document.querySelector('.ac-card[data-id="1"] .ac-ask-open').click(); true`); await waitFor(`!!document.querySelector('.ac-ask input[type="checkbox"]')`, 'the picker', 8000); await sleep(300); }; // sleep-ok: the uploader's lookup and the redraw
    const closeViewer = async () => { await ev(`document.querySelector('#artifact-viewer [data-dialog-close], #artifact-viewer .artifact-viewer-close')?.click(); true`); await sleep(300); }; // sleep-ok: the viewer closes over a frame
    const ticked = () => ev(`[...document.querySelectorAll('.ac-ask input[type="checkbox"]')].filter(i => i.checked).map(i => i.value)`);
    const rows = () => ev(`(() => { const b = document.querySelector('.ac-ask'); const d = b.querySelector('.ac-ask-rest'); const vis = li => li.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true });
        return { shown: [...b.querySelectorAll('.ac-ask-agent')].filter(vis).map(li => li.querySelector('input').value), all: b.querySelectorAll('.ac-ask-agent').length, more: d ? d.querySelector('summary').textContent : null, open: d ? d.open : null,
            fits: b.getBoundingClientRect().right <= innerWidth + 1 && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 }; })()`);
    const J = JSON.stringify;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`try { localStorage.removeItem('coral-artifact-comments-open'); } catch {} true`);
            const hint = role => ({ role, hex: HEX, server: 'local', board: 'ask-team' });
            // 1) the maker is QA Engineer: it and the Orchestrator are shown, the other five are behind More agents
            await open('ask-team', undefined, true, hint('QA Engineer')); await openPicker();
            let r = await rows();
            check(`${tag}: the maker and the Orchestrator are shown, nobody else`, J(r.shown) === J(['QA Engineer', 'Orchestrator']), J(r.shown));
            check(`${tag}: the maker is ticked, the Orchestrator is not`, J(await ticked()) === J(['QA Engineer']), J(await ticked()));
            check(`${tag}: More agents holds the other 4 and is shut`, r.more === 'More agents (4)' && r.open === false && r.all === 6, J(r));
            check(`${tag}: Deliver now sits on one row with its box, beside its words`, await ev(`(() => { const l = document.querySelector('.ac-ask-now'), b = l.querySelector('input').getBoundingClientRect(), t = l.querySelector('span').getBoundingClientRect(); return b.right <= t.left + 1 && b.top < t.top + t.height / 2 && b.bottom > t.top; })()`));
            const gap = await ev(`(() => { const l = document.querySelector('.ac-ask-now'), b = l.querySelector('input').getBoundingClientRect(), t = l.querySelector('span').getBoundingClientRect(); return { gap: Math.round((t.left - b.right) * 10) / 10, box: Math.round(b.width), label: Math.round(l.getBoundingClientRect().width), h: Math.round(l.getBoundingClientRect().height) }; })()`);
            check(`${tag}: Deliver now box is right next to its words (gap under 12 px): ${JSON.stringify(gap)}`, gap.gap >= 0 && gap.gap < 12 && gap.box <= 24 && (!/390/.test(tag) || gap.h >= 44));
            await shot(`ask-front-${w}`);
            await ev(`document.querySelector('.ac-ask-rest summary').click(); true`); await sleep(200); // sleep-ok: the fold opens over a frame
            r = await rows();
            check(`${tag}: opening it shows every agent, with its asleep label`, r.shown.length === 6 && /Asleep: wake it first/.test(await ev(`document.querySelector('.ac-ask-rest').textContent`)), J(r.shown));
            check(`${tag}: it fits the width`, r.fits, J(r));
            await shot(`ask-more-${w}`);
            await ev(`[...document.querySelectorAll('.ac-ask input[type="checkbox"]')].find(i => i.value === 'Backend Dev').click(); true`);
            r = await rows();
            check(`${tag}: a tick inside the fold keeps it open`, r.open === true && J((await ticked()).sort()) === J(['Backend Dev', 'QA Engineer']), J([r.open, await ticked()]));
            await closeViewer();
            // 2) the maker is the Orchestrator: once
            await open('ask-team', undefined, true, hint('Orchestrator')); await openPicker();
            r = await rows();
            check(`${tag}: the Orchestrator as maker is shown once, ticked`, J(r.shown) === J(['Orchestrator']) && J(await ticked()) === J(['Orchestrator']) && r.more === 'More agents (5)', J([r.shown, await ticked(), r.more]));
            await closeViewer();
            // 3) the maker is asleep: still shown first, labelled, unticked
            await open('ask-team', undefined, true, hint('UI Dev')); await openPicker();
            r = await rows();
            check(`${tag}: an asleep maker is shown with its label and unticked`, r.shown[0] === 'UI Dev' && (await ticked()).length === 0 && /Asleep/.test(await ev(`document.querySelector('.ac-ask-agent').textContent`)), J([r.shown, await ticked()]));
            await closeViewer();
            // 4) the maker is not on the list: the Orchestrator leads
            await open('ask-team', undefined, true, hint('Ghost Writer')); await openPicker();
            r = await rows();
            check(`${tag}: a maker not on the board leaves the Orchestrator in front`, J(r.shown) === J(['Orchestrator']), J(r.shown));
            await closeViewer();
            // 5) no Orchestrator on the board and no maker: the whole list, no fold
            await open('ask-team', undefined, true, hint('Ghost Writer')); await ev(`window.__agents = window.__agents.filter(a => a.role !== 'Orchestrator'); true`);
            await closeViewer(); await open('ask-team', undefined, true, hint('Ghost Writer')); await ev(`window.__agents = window.__agents.filter(a => a.role !== 'Orchestrator'); true`); await openPicker();
            r = await rows();
            check(`${tag}: with neither on the list every agent is shown and there is no fold`, r.more === null && r.shown.length === 5, J(r));
            await closeViewer();
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Send to agent front-list checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
