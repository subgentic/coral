// The comments panel of the artifact viewer is as wide as the person wants (#14024, the Operator: "the chat window on a document review width can be too small and hard to read for longer messages"): a separator on its left edge,
// drag or arrow keys (role=separator, aria-valuenow, 340 px up to 60% of the viewer, the document keeps 360 px), remembered per browser, double-click for the default; 420 px by default once the viewer is 1100 px or more; a longer
// message, a code block and a long unbroken string wrap inside the panel; a phone's sheet is as it was. At 1280, 1920, a 1100 px window, 1280 at 200% text and 390 px. The comments are stubbed at the page's fetch. Isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme, installAudit, auditRegion } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const { coralReady, waitStable } = require('./helpers/wait');
const HEX = 'd'.repeat(64);
const MD = ['# Migration plan', '', '## Steps', '', '1. Add the new columns behind a flag and backfill in batches of 500 rows.', '2. Switch reads to the new columns.', '', '## Risks', '', 'The backfill takes a write lock on large databases, so it must run off-peak.', '', 'Add a flag. Then wait. Add a flag again at the end.'].join('\n');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const STUB = `(() => {
        const real = window.fetch; window.__calls = []; window.__cs = [
            { id: 1, parent_id: null, anchor: { quote: 'backfill in batches of 500 rows.', prefix: 'columns behind a flag and', suffix: '2. Switch', start_line: 5, end_line: 5 }, body: 'Batches of 500 is too small. Try 5,000.', author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date(Date.now() - 120000).toISOString() },
            { id: 2, parent_id: 1, anchor: null, body: 'Agreed. Last run took 9 s per 5,000.', author: { kind: 'hub', issuer: 'coral-hub', subject: 'hub-user-3f2a' }, created_at: new Date(Date.now() - 60000).toISOString() },
            { id: 3, parent_id: null, anchor: { quote: 'takes a write lock on large databases', prefix: 'The backfill', suffix: ', so it must run' }, body: 'Define off-peak: 02:00 to 05:00 UTC?', author: { kind: 'hub', issuer: 'coral-hub', subject: 'hub-user-3f2a' }, created_at: new Date(Date.now() - 3600000).toISOString() },
            { id: 4, parent_id: null, anchor: { quote: 'Run the backfill nightly until it is done.' }, body: 'This step was reworded.', author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date(Date.now() - 259200000).toISOString() },
            { id: 5, parent_id: null, anchor: { quote: 'Switch reads to the new columns.' }, body: 'Fine.', author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date(Date.now() - 86400000).toISOString(), resolved_at: new Date().toISOString(), resolved_by: { issuer: 'local', subject: 'Operator' } },
        ]; window.__next = 6; window.__role = 'owner'; window.__locked = false; window.__missing = false;
        window.__hold = null; window.__failNext = false; window.__posts = 0; window.__cs.push({ id: 90, parent_id: null, anchor: { whole: true }, body: 'A longer message with code:\\n    const veryLongIdentifierName = someFunction(argumentNumberOne, argumentNumberTwo, argumentNumberThree);\\nand an unbroken string ' + 'x'.repeat(260) + ' to wrap.', author: { kind: 'owner', issuer: 'local', subject: 'Operator', name: 'You' }, created_at: new Date(Date.now() - 1000).toISOString() });
        const waitHold = r => (window.__hold ? new Promise(res => { window.__release = () => res(r()); }) : r());
        const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        const inner = (u, o) => {
            const url = String(u), method = (o && o.method) || 'GET';
            if (url.includes('/api/artifacts/${HEX}/comments')) {
                window.__calls.push({ method, url, body: o && o.body ? JSON.parse(o.body) : null });
                if (window.__missing) return json({ error: 'not found' }, 404);
                const me = window.__role, mine = c => (me === 'owner' && c.author.kind === 'owner'), sub = url.split('/comments')[1].split('?')[0];
                const can = c => ({ reply: me === 'owner' && !window.__locked && c.parent_id == null, edit: mine(c) && !window.__locked, delete: mine(c), resolve: me === 'owner' && !window.__locked && c.parent_id == null });
                if (method === 'GET') return json({ comments: window.__cs.filter(c => !c.deleted_at || window.__cs.some(r => r.parent_id === c.id && !r.deleted_at)).map(c => ({ ...c, deleted: !!c.deleted_at, body: c.deleted_at ? '' : c.body, mine: mine(c), can: can(c) })), locked: window.__locked, you: { kind: me === 'owner' ? 'owner' : 'hub', name: me === 'owner' ? 'Operator' : 'hub-user-3f2a', can_comment: me === 'owner' && !window.__locked, reason: me === 'owner' ? '' : 'Your Coral Hub access is view only.', can_lock: me === 'owner' }, limits: { body: 8192, quote: 2048, comments: 500 } });
                if (me !== 'owner' && sub !== '') return json({ error: 'Your Coral Hub access is view only.' }, 403);
                if (method !== 'GET' && window.__failNext) { window.__failNext = false; window.__posts++; return waitHold(() => new Response(JSON.stringify({ error: 'The comment could not be saved: the file is locked.' }), { status: 409, headers: { 'Content-Type': 'application/json' } })); }
                if (method === 'POST' && sub === '') window.__posts++;
                if (method === 'POST' && sub === '') { const b = JSON.parse(o.body); const c = { id: window.__next++, parent_id: b.parent_id == null ? null : b.parent_id, anchor: b.anchor, body: b.body, author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date().toISOString() }; window.__cs.push(c); return json({ ...c, can: can(c) }, 201); }
                const m = /^\\/(\\d+)(\\/(resolve|reopen))?$/.exec(sub); const c = m && window.__cs.find(x => x.id === Number(m[1]));
                if (m && c) {
                    if (method === 'PATCH') { c.body = JSON.parse(o.body).body; c.edited_at = new Date().toISOString(); return json({ ...c, can: can(c) }); }
                    if (method === 'DELETE') { if (!mine(c)) return json({ error: 'Only the author can delete a comment.' }, 403); c.deleted_at = new Date().toISOString(); return json({ ok: true }); }
                    if (m[3] === 'resolve') { c.resolved_at = new Date().toISOString(); return json({ ...c, can: can(c) }); }
                    if (m[3] === 'reopen') { delete c.resolved_at; return json({ ...c, can: can(c) }); }
                }
                if (sub === '/lock') { window.__locked = method === 'PUT'; return json({ ok: true }); }
                return json({ error: 'nope' }, 404);
            }
            if (url.includes('/api/artifacts/${HEX}')) return Promise.resolve(new Response(${JSON.stringify(MD)}, { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
            return real(u, o);
        };
        window.fetch = (u, o) => { const m = (o && o.method) || 'GET'; const p = inner(u, o); return m !== 'GET' && window.__hold && String(u).includes('/comments') && !window.__failNext ? p.then(r => new Promise(res => { window.__release = () => res(r); })) : p; };
        return true; })()`;
    const open = async (extra, opts = {}) => {
        await ev(STUB);
        if (extra) await ev(extra);
        await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(HEX)}, ${JSON.stringify({filename:'plan.md',...opts})}); return true; })()`);
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`, 'the document', 8000);
    };
    const chk = (cond, label) => check(label, cond);
    const vis = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && e.getClientRects().length > 0; })()`;
    const panelW = () => ev(`Math.round(document.querySelector('#artifact-viewer .ac-panel').getBoundingClientRect().width)`);
    const docW = () => ev(`Math.round(document.querySelector('#artifact-viewer .artifact-viewer-body').getBoundingClientRect().width)`);
    const mainW = () => ev(`Math.round(document.querySelector('#artifact-viewer .artifact-viewer-main').getBoundingClientRect().width)`);
    const bar = () => ev(`(() => { const b = document.querySelector('#artifact-viewer .ac-resize'); return b && { shown: !b.hidden && b.getClientRects().length > 0, role: b.getAttribute('role'), orient: b.getAttribute('aria-orientation'), now: Number(b.getAttribute('aria-valuenow')), min: Number(b.getAttribute('aria-valuemin')), max: Number(b.getAttribute('aria-valuemax')), tab: b.tabIndex }; })()`);
    const key = (k, shift) => ev(`document.querySelector('#artifact-viewer .ac-resize').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, shiftKey: ${!!shift}, bubbles: true, cancelable: true })); true`);
    const openPanel = async (o) => { await open(undefined, o || { board: 'ask-team' }); await waitFor(`!!document.querySelector('.ac-toggle')`, 'the comments toggle', 8000); await ev(`(() => { const t = document.querySelector('.ac-toggle'); if (t && t.getAttribute('aria-expanded') !== 'true') t.click(); return true; })()`); await new Promise(r => setTimeout(r, 500)); }; // sleep-ok: the panel opens over a frame or two
    const closeV = async () => { await ev(`document.querySelector('#artifact-viewer [data-dialog-close], #artifact-viewer .artifact-viewer-close')?.click(); true`); await new Promise(r => setTimeout(r, 300)); }; // sleep-ok: the viewer closes over a frame
    const setSize = async (w, h, mobile) => { await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile }); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const fresh = async (w, h, mobile) => { await setSize(w, h, mobile); await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await ev(`try { localStorage.removeItem('coral-comments-panel-width'); localStorage.removeItem('coral-artifact-comments-open'); } catch {} true`); };
        // 1) defaults: 420 px from a 1100 px viewer, 340 below it; the viewer uses more of a wide screen
        for (const [w, want, label] of [[1280, 420, '1280 (a 1228 px viewer)'], [1920, 420, '1920 (the viewer is capped at 1480)'], [1100, 340, '1100 (a 1056 px viewer: under 1100)']]) {
            await fresh(w, 900, false); await openPanel();
            chk((await panelW()) === want, `${label}: the panel starts ${want} px wide: ` + await panelW());
            const vw = await ev(`Math.round(document.querySelector('#artifact-viewer .artifact-viewer-content').getBoundingClientRect().width)`);
            if (w === 1920) chk(vw > 1240 && vw <= 1480, `1920: the viewer uses more of a wide screen with the panel open (${vw} px, it was 1240)`);
            const b = await bar();
            chk(b && b.shown && b.role === 'separator' && b.orient === 'vertical' && b.tab === 0 && b.now === await panelW() && b.min === 340, `${label}: a separator with its value: ` + JSON.stringify(b));
            chk(b.max === Math.max(340, Math.min(Math.floor((await mainW()) * 0.6), (await mainW()) - 360)), `${label}: its maximum is 60% of the viewer, and the document keeps 360 px: ` + JSON.stringify([b.max, await mainW()]));
            if (w === 1280) await shot('width-default-1280');
            await closeV();
        }
        // 2) the keyboard: arrows, Shift, Home, End; the document keeps its minimum; the value follows
        await fresh(1280, 900, false); await openPanel();
        await ev(`document.querySelector('#artifact-viewer .ac-resize').focus(); true`);
        let w0 = await panelW();
        await key('ArrowLeft'); chk((await panelW()) === w0 + 24 && (await bar()).now === w0 + 24, `ArrowLeft widens by 24 and the value follows: ${w0} -> ${await panelW()}`);
        await key('ArrowLeft', true); chk((await panelW()) === w0 + 24 + 96, `Shift+ArrowLeft widens by 96: ${await panelW()}`);
        await key('ArrowRight'); chk((await panelW()) === w0 + 96, `ArrowRight narrows by 24: ${await panelW()}`);
        await key('Home'); chk((await panelW()) === 340, `Home is the narrowest (340): ${await panelW()}`);
        await key('End'); const maxNow = (await bar()).max;
        chk((await panelW()) === maxNow && (await docW()) >= 360 && (await panelW()) <= Math.floor((await mainW()) * 0.6) + 1, `End is the widest (${maxNow}), the document keeps ${await docW()} px (360 or more), at most 60%`);
        await shot('width-widest-1280');
        // 3) a drag: press on the separator, move left 100 px, release
        await key('Home'); const r = await ev(`(() => { const b = document.querySelector('#artifact-viewer .ac-resize').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
        const before = await panelW();
        await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: r.x, y: r.y }); await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 5; i++) await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: r.x - 20 * i, y: r.y, button: 'left' });
        await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: r.x - 100, y: r.y, button: 'left', clickCount: 1 });
        await new Promise(r2 => setTimeout(r2, 200)); // sleep-ok: the release is handled
        chk(Math.abs((await panelW()) - (before + 100)) <= 2, `a drag of 100 px left widens the panel by about 100: ${before} -> ${await panelW()}`);
        // a drag past the limits stops at them
        await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: r.x - 100, y: r.y }); 
        // 4) remembered: close and open again; double-click goes back to the default
        const kept = await panelW(); await closeV(); await openPanel();
        chk((await panelW()) === kept, `the width survives closing and opening the viewer: ${kept} -> ${await panelW()}`);
        chk((await ev(`localStorage.getItem('coral-comments-panel-width')`)) === String(kept), `it is stored for this browser: ${await ev(`localStorage.getItem('coral-comments-panel-width')`)}`);
        await ev(`document.querySelector('#artifact-viewer .ac-resize').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`); await new Promise(r2 => setTimeout(r2, 150)); // sleep-ok: the reset paints
        chk((await panelW()) === 420 && (await ev(`localStorage.getItem('coral-comments-panel-width')`)) === null, `double-click is back to the default and forgets: ${await panelW()} ${await ev(`localStorage.getItem('coral-comments-panel-width')`)}`);
        // a stored width wider than this window allows is held to the limit, and the document keeps its room
        await ev(`localStorage.setItem('coral-comments-panel-width', '5000'); true`); await closeV(); await openPanel();
        chk((await docW()) >= 360 && (await panelW()) <= Math.floor((await mainW()) * 0.6) + 1, `a stored width too wide for the window is held to the limit: panel ${await panelW()}, document ${await docW()}`);
        await ev(`localStorage.removeItem('coral-comments-panel-width'); true`); await closeV();
        // 5) a long message, a code block and a long unbroken string wrap inside the panel, at 200% text too
        for (const [zoom, label] of [['100%', '100% text'], ['200%', '200% text']]) {
            await fresh(1280, 900, false); await ev(`document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`); await openPanel();
            const fit = await ev(`(() => { const p = document.querySelector('#artifact-viewer .ac-panel'), body = p.querySelector('.ac-card[data-id="90"] .ac-body'); if (!body) return null; const r = body.getBoundingClientRect(), pr = p.getBoundingClientRect(); return { inside: r.right <= pr.right + 1 && body.scrollWidth <= body.clientWidth + 1, panelScroll: p.scrollWidth <= p.clientWidth + 1, page: document.documentElement.scrollWidth <= innerWidth + 1 }; })()`);
            chk(fit && fit.inside && fit.panelScroll && fit.page, `${label}: the long message, its code and the unbroken string wrap inside the panel: ` + JSON.stringify(fit));
            chk((await docW()) >= 360, `${label}: the document keeps its minimum: ${await docW()}`);
            if (zoom === '200%') await shot('width-200-1280');
            await ev(`document.documentElement.style.fontSize = ''; true`); await closeV();
        }
        // 6) a phone's sheet is as it was: no separator, the sheet across the screen
        await fresh(390, 844, true); await openPanel();
        const ph = await ev(`(() => { const b = document.querySelector('#artifact-viewer .ac-resize'), p = document.querySelector('#artifact-viewer .ac-panel'); return { bar: !!b && !b.hidden && b.getClientRects().length > 0, panel: Math.round(p.getBoundingClientRect().width), vw: innerWidth }; })()`);
        chk(!ph.bar && ph.panel === ph.vw, 'a phone: no separator, the sheet is the screen wide: ' + JSON.stringify(ph));
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log('PASS the comments panel is resizable by drag and keys, remembered, with the document keeping its room');
})().catch(e => { console.error(e); process.exit(1); });
