// Touch census on a tablet's first load (walk 80 item 10, #17694): at 820 x 1180 with a coarse pointer, the artifact viewer's comment actions (Edit, Delete, Reply, Resolve, Send) and the version arrows were 22 and 32 px tall, because the 44 px rules were for a phone (max-width 767px) only. Every visible button, link or field in the viewer is 44 px, measured right after the first paint and again after it settles.
// Drives Chrome over CDP through agent_view_harness.js.
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const assert = require('node:assert/strict');
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
        window.__agents = [
            { name: 'QA', role: 'QA Engineer', agent_type: 'claude', availability: 'available' },
            { name: 'Backend', role: 'Backend Dev', agent_type: 'codex', availability: 'busy' },
            { name: 'Sleepy', role: 'UI Dev', agent_type: 'claude', availability: 'sleeping' },
            { name: 'Gone', role: 'Docs Writer', agent_type: 'claude', availability: 'offline' },
            { name: 'Rev', role: 'Reviewer', agent_type: 'claude', availability: 'available' },
            { name: 'shell', role: 'Shell', agent_type: 'terminal', availability: 'unavailable' },
        ];
        window.__send = { status: 200, body: null }; window.__you = { can_comment: true, can_lock: true };
        const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o) => {
            const url = String(u), method = (o && o.method) || 'GET';
            if (/\\/api\\/board\\/[^/]+\\/status/.test(url)) return json({ agents: window.__agents, summary: {}, unassigned_tasks: [], health_report: [], observed_at: new Date().toISOString() });
            if (url.includes('/api/artifacts/${HEX}/comments')) {
                const sub = url.split('/comments')[1].split('?')[0];
                if (method === 'POST' && /^\\/\\d+\\/send$/.test(sub)) {
                    const b = JSON.parse(o.body); window.__sends.push({ id: Number(sub.split('/')[1]), agents: b.agents, now: b.now === true });
                    if (window.__send.body) return json(window.__send.body, window.__send.status);
                    return json({ ok: true, results: b.agents.map((a, i) => ({ agent: a, state: a === 'Backend Dev' ? 'already_asked' : 'sent', ask_id: i + 1 })) });
                }
                const can = c => ({ reply: c.parent_id == null, edit: false, delete: false, resolve: c.parent_id == null });
                return json({ comments: window.__cs.map(c => ({ ...c, deleted: false, mine: c.author.kind === 'owner', can: can(c) })), locked: false, you: window.__you, limits: {} });
            }
            if (url.includes('/api/artifacts/${HEX}')) return Promise.resolve(new Response(${JSON.stringify(MD)}, { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
            return real(u, o);
        };
        return true; })()`;
    const open = async (board, you, noAsks) => {
        await ev(STUB);
        if (noAsks) await ev(`window.__cs[0].asks = []; true`);
        if (you) await ev(`window.__you = ${JSON.stringify(you)}; true`);
        await ev(`import(${S} + 'state.js').then(m => { m.state.liveSessions = [{ session_id: 'sess-qa', name: 'qa-agent', agent_type: 'claude', board_subscriber_id: 'QA Engineer', board_project: ${JSON.stringify(board || '')} }]; window.__opened = null; window.selectLiveSession = (...a) => { window.__opened = a; }; return true; })`); // QA Engineer is running; Reviewer and Docs Writer are not (#12168)
        await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'plan.md', ${board ? `board: '${board}'` : ''} }); return true; })()`);
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`, 'the document', 8000);
        await waitFor(`document.querySelectorAll('.ac-card').length >= 1`, 'the threads', 8000);
        await ev(`(() => { const t = document.querySelector('.ac-toggle'); if (t && t.getAttribute('aria-expanded') !== 'true') t.click(); return true; })()`);
        await sleep(300); // sleep-ok: the panel opens over a frame or two
    };
const UNDERSIZED = `(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, a[href], [role=button], input:not([type=hidden]), select, summary, [onclick], [data-on-click]')) {
        // A checkbox or radio inside its label is tapped through the label.
        const hit = el.matches('input[type=checkbox], input[type=radio]') && el.closest('label') ? el.closest('label') : el;
        const r = hit.getBoundingClientRect(); const cs = getComputedStyle(el);
        if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none') continue;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        // A dense glyph button (.btn-xs) keeps a 24 px box and is a 44 px target through its transparent ::after (#9332).
        // It counts only when it is invisible (no fill, no border) and centred on the control: an inset of -10px on a 24 px box, not any absolute pseudo-element.
        const after = getComputedStyle(el, '::after'); let w = r.width, h = r.height;
        const left = parseFloat(after.left), top = parseFloat(after.top), aw = parseFloat(after.width), ah = parseFloat(after.height);
        const invisible = after.backgroundColor === 'rgba(0, 0, 0, 0)' && parseFloat(after.borderTopWidth) === 0 && after.backgroundImage === 'none';
        const centred = Math.abs((left + aw / 2) - r.width / 2) <= 1 && Math.abs((top + ah / 2) - r.height / 2) <= 1;
        if (after.content !== 'none' && after.position === 'absolute' && invisible && centred) { w = Math.max(w, aw || 0); h = Math.max(h, ah || 0); }
        if (w >= 44 && h >= 44) continue;
        out.push(Math.round(r.width) + 'x' + Math.round(r.height) + ' ' + (el.id ? '#' + el.id : el.className) + ' [' + (el.getAttribute('aria-label') || el.title || el.textContent.trim()).slice(0, 30) + ']');
    }
    return out;
})()`;

    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 820, height: 1180, deviceScaleFactor: 2, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`try { localStorage.removeItem('coral-artifact-comments-open'); } catch {} true`);
        await open('ask-team');
        await waitFor(`document.querySelectorAll('.ac-card').length >= 1`, 'the threads', 8000);
        const sizes = await ev(UNDERSIZED);
        assert.deepEqual(sizes, [], 'controls under 44 px in the viewer at 820x1180 touch:\n  ' + sizes.join('\n  '));
        console.log('PASS the viewer and its comments are 44 px at 820x1180 touch');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
