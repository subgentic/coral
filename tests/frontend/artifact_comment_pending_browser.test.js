// A comment on its way says so (#14027, the Operator: "when submitting a comment on a doc, it can take a while for it to come back. There is no indication that something is happening"): the held response shows Sending…
// at once, the words stay in the box, a second press sends nothing, a failure keeps the draft and says why, a success clears the box and shows the comment; a reply and an edit say it too; a delete says "Deleting the
// comment…" on one line and the buttons wait; the working line and the button are announced (role=status). 1280 and 390 px. The comments API is stubbed at the page's fetch, with the answers held until the test releases them.
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
        window.__hold = null; window.__failNext = false; window.__posts = 0;
        const waitHold = r => (window.__hold ? new Promise(res => { window.__release = () => res(r()); }) : r());
        const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        const inner = (u, o) => {
            const url = String(u), method = (o && o.method) || 'GET';
            if (url.includes('/api/artifacts/${HEX}/comment-images')) { window.__pics = (window.__pics || 0) + 1; return json({ hex: String(window.__pics).padStart(64, 'a'), name: 'pic' + window.__pics + '.png', content_type: 'image/png', size: 70 }); }
            if (url.includes('/api/artifacts/${HEX}/comments')) {
                window.__calls.push({ method, url, body: o && o.body ? JSON.parse(o.body) : null });
                if (window.__missing) return json({ error: 'not found' }, 404);
                const me = window.__role, mine = c => (me === 'owner' && c.author.kind === 'owner'), sub = url.split('/comments')[1].split('?')[0];
                const can = c => ({ reply: me === 'owner' && !window.__locked && c.parent_id == null, edit: mine(c) && !window.__locked, delete: mine(c), resolve: me === 'owner' && !window.__locked && c.parent_id == null });
                if (method === 'GET') return json({ comments: window.__cs.filter(c => !c.deleted_at || window.__cs.some(r => r.parent_id === c.id && !r.deleted_at)).map(c => ({ ...c, deleted: !!c.deleted_at, body: c.deleted_at ? '' : c.body, mine: mine(c), can: can(c) })), locked: window.__locked, you: { kind: me === 'owner' ? 'owner' : 'hub', name: me === 'owner' ? 'Operator' : 'hub-user-3f2a', can_comment: me === 'owner' && !window.__locked, reason: me === 'owner' ? '' : 'Your Coral Hub access is view only.', can_lock: me === 'owner' }, limits: { body: 8192, quote: 2048, comments: 500 } });
                if (me !== 'owner' && sub !== '') return json({ error: 'Your Coral Hub access is view only.' }, 403);
                if (method !== 'GET' && window.__failNext) { window.__failNext = false; window.__posts++; return waitHold(() => new Response(JSON.stringify({ error: 'The comment could not be saved: the file is locked.' }), { status: 409, headers: { 'Content-Type': 'application/json' } })); }
                if (method === 'POST' && sub === '') window.__posts++;
                if (method === 'POST' && sub === '') { const b = JSON.parse(o.body); const c = { id: window.__next++, parent_id: b.parent_id == null ? null : b.parent_id, anchor: b.anchor, body: b.body, author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date().toISOString(), ...(window.__sentTo ? { sent_to: window.__sentTo } : {}) }; window.__cs.push(c); return json({ ...c, can: can(c) }, 201); }
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
    const type = (sel, text) => ev(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); return true; })()`);
    const submit = () => ev(`document.querySelector('.ac-composer').requestSubmit(); true`);
    const sendState = () => ev(`(() => { const b = document.querySelector('.ac-composer .ac-send'), t = document.querySelector('.ac-composer .ac-input'); return b && { text: b.textContent, disabled: b.disabled, busy: b.getAttribute('aria-busy'), readOnly: t.readOnly, value: t.value, cancelDisabled: document.querySelector('.ac-composer .ac-cancel').disabled }; })()`);
    const live = () => ev(`(document.querySelector('.ac-live') || {}).textContent || ''`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`try { localStorage.removeItem('coral-artifact-comments-open'); } catch {} true`);
            await open(undefined, { board: 'ask-team' });
            await waitFor(`!!document.querySelector('.ac-toggle')`, 'the comments toggle', 8000);
            await ev(`(() => { const t = document.querySelector('.ac-toggle'); if (t && t.getAttribute('aria-expanded') !== 'true') t.click(); return true; })()`);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the panel opens over a frame or two
            await waitFor(`!!document.querySelector('.ac-whole')`, 'the whole-document button', 8000);
            await ev(`document.querySelector('.ac-whole').click(); true`);
            await waitFor(`!!document.querySelector('.ac-composer .ac-input')`, 'the composer', 5000);
            // 1) a new comment, held: Sending… at once, the words stay, a second press sends nothing
            await type('.ac-composer .ac-input', 'Is the lock per table or per database?');
            await ev(`window.__hold = true; window.__posts = 0; true`);
            await submit();
            await waitFor(`document.querySelector('.ac-composer .ac-send')?.textContent === 'Sending…'`, at + 'the button says Sending…', 3000).catch(() => {}); // a missing busy word is reported by the check below, and the shot is still taken
            let st = await sendState();
            chk(st.disabled && st.busy === 'true' && st.readOnly && st.value === 'Is the lock per table or per database?' && st.cancelDisabled, at + 'Sending…: disabled, busy, the words stay in the box, read only: ' + JSON.stringify(st));
            chk(/Sending your comment/.test(await live()) && (await ev(vis('.ac-working'))) && (await ev(`document.querySelector('.ac-working').getAttribute('role')`)) === 'status', at + 'it is announced and said on one status line: ' + JSON.stringify([await live()]));
            await shot(`pending-${w}`);
            await submit(); await submit();
            chk((await ev(`window.__posts`)) === 1, at + 'a second and third press send nothing: ' + await ev(`window.__posts`));
            // a redraw while it is on its way (a live refresh) keeps the busy button and the words
            await ev(`document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('resize')); true`);
            st = await sendState(); chk(st && st.text === 'Sending…' && st.value === 'Is the lock per table or per database?', at + 'a redraw keeps the busy state and the words: ' + JSON.stringify(st));
            await ev(`window.__release(); window.__hold = null; true`);
            await waitFor(`!document.querySelector('.ac-composer') && [...document.querySelectorAll('.ac-card')].some(c => /Is the lock per table/.test(c.textContent))`, at + 'the comment appears and the box clears', 8000);
            chk(!(await ev(vis('.ac-working'))), at + 'and the working line is gone');
            // 1b) once sent, one short line (the Operator, comment 232): an agent was told -> 'Sent. The agent will respond shortly.'; none was -> says so, and never 'Sent to <name>' or silence
            const toastsNow = () => ev(`[...document.querySelectorAll('.toast .toast-message, #toast-host .toast')].map(t => t.textContent.trim())`);
            chk((await toastsNow()).some(t => t.startsWith('Saved. No agent was told.')), at + 'no agent told: the line says so: ' + JSON.stringify(await toastsNow()));
            await ev(`document.querySelectorAll('#toast-host .toast, .toast').forEach(e => e.remove()); window.__sentTo = 'Writer A'; document.querySelector('.ac-whole').click(); true`);
            await waitFor(`!!document.querySelector('.ac-composer .ac-input')`, 'the composer for the sent case', 5000);
            await type('.ac-composer .ac-input', 'Is Thursday firm?'); await submit();
            await waitFor(`[...document.querySelectorAll('.toast')].some(t => /^Sent\\. The agent will respond shortly\\./.test(t.textContent.trim()))`, at + 'an agent told: Sent. The agent will respond shortly.', 8000);
            chk(!(await toastsNow()).some(t => /^Sent to /.test(t)), at + 'and no Sent to <name> toast: ' + JSON.stringify(await toastsNow()));
            await ev(`window.__sentTo = null; true`);
            // 2) a failure keeps the draft and says why
            await ev(`document.querySelector('.ac-whole').click(); true`);
            await waitFor(`!!document.querySelector('.ac-composer .ac-input')`, 'the composer again', 5000);
            await type('.ac-composer .ac-input', 'Second thought, written longer.');
            await ev(`window.__failNext = true; true`);
            await submit();
            await waitFor(`document.querySelector('.ac-composer .ac-error') && !document.querySelector('.ac-composer .ac-error').hidden`, at + 'the failure is said under the box', 6000);
            st = await sendState();
            chk(st.value === 'Second thought, written longer.' && !st.disabled && st.text === 'Comment' && !st.readOnly, at + 'a refusal keeps the draft, and Send is ready again: ' + JSON.stringify(st));
            chk(/locked/.test(await ev(`document.querySelector('.ac-composer .ac-error').textContent`)), at + 'and says why');
            await ev(`document.querySelector('.ac-composer .ac-cancel').click(); true`);
            // 3) a reply and an edit say it too
            await ev(`window.__hold = true; true`);
            await ev(`document.querySelector('.ac-card[data-id="1"] .ac-replybox')?.click(); true`);
            await waitFor(`!!document.querySelector('.ac-composer .ac-input')`, at + 'a reply box', 5000).catch(() => {});
            if (await ev(`!!document.querySelector('.ac-composer .ac-input')`)) {
                await type('.ac-composer .ac-input', 'A reply.'); await submit();
                await waitFor(`document.querySelector('.ac-composer .ac-send')?.textContent === 'Sending reply…'`, at + 'a reply says Sending reply…', 3000).catch(() => {});
                chk((await sendState())?.text === 'Sending reply…', at + 'a reply says Sending reply…: ' + JSON.stringify(await sendState()));
                await ev(`window.__release(); window.__hold = null; true`);
                await waitFor(`!document.querySelector('.ac-composer')`, at + 'the reply box closes', 8000);
            } else { chk(false, at + 'the reply box did not open'); await ev(`window.__hold = null; true`); }
            // 3b) an EDIT says it too: the Edit button on the comment, Saving…, the words kept, one PATCH
            await ev(`window.__hold = null; true`);
            await ev(`document.querySelector('.ac-card[data-id="1"] .ac-actions .ac-act[aria-label^="Edit"]')?.click(); true`);
            await waitFor(`!!document.querySelector('.ac-composer .ac-input')`, at + 'the edit box', 5000).catch(() => {});
            if (await ev(`!!document.querySelector('.ac-composer .ac-input')`)) {
                await type('.ac-composer .ac-input', 'Batches of 500 is far too small, try 5,000 and measure.');
                await ev(`window.__hold = true; window.__posts = 0; window.__calls = []; true`); await submit();
                await waitFor(`document.querySelector('.ac-composer .ac-send')?.textContent === 'Saving…'`, at + 'an edit says Saving…', 3000).catch(() => {});
                const es = await sendState();
                chk(es && es.text === 'Saving…' && es.disabled && es.readOnly && /far too small/.test(es.value), at + 'an edit says Saving…, waits, and keeps the words: ' + JSON.stringify(es));
                chk(/Saving your comment/.test(await live()), at + 'and is announced: ' + JSON.stringify([await live()]));
                await submit();
                chk((await ev(`window.__calls.filter(c => c.method === 'PATCH').length`)) === 1, at + 'a second press does not start another save: one PATCH ' + await ev(`window.__calls.filter(c => c.method === 'PATCH').length`));
                await ev(`window.__release(); window.__hold = null; true`);
                await waitFor(`!document.querySelector('.ac-composer')`, at + 'the edit box closes', 8000);
            } else { chk(false, at + 'the edit box did not open'); }
            // 3c) a picture that changes while the comment is on its way never makes Send ready again
            await ev(`window.__hold = null; document.querySelector('.ac-whole').click(); true`);
            await waitFor(`!!document.querySelector('.ac-composer .ac-input')`, at + 'the composer for the picture case', 5000);
            const addPic = () => ev(`(() => { const i = document.querySelector('.ac-composer input[type=file]'); const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([png], 'p.png', { type: 'image/png' })); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await addPic(); await new Promise(r2 => setTimeout(r2, 400)); // sleep-ok: the picture goes up
            await type('.ac-composer .ac-input', 'With a picture.');
            await ev(`window.__hold = true; true`); await submit();
            await waitFor(`document.querySelector('.ac-composer .ac-send')?.textContent === 'Sending…'`, at + 'sending with a picture', 3000).catch(() => {});
            await addPic(); await new Promise(r2 => setTimeout(r2, 500)); // sleep-ok: a second picture goes up and the tray reports its change
            const ps = await sendState();
            chk(ps && ps.disabled && ps.text === 'Sending…', at + 'a picture that changes while the POST is held leaves Send disabled and busy: ' + JSON.stringify(ps));
            await ev(`window.__release(); window.__hold = null; true`);
            await waitFor(`!document.querySelector('.ac-composer')`, at + 'it closes when answered', 8000).catch(() => {});
            // 4) a delete says what it is doing, and the buttons wait
            await ev(`window.__hold = true; true`);
            await ev(`window.showConfirmModal = (t, m, fn) => fn(); true`); // the confirmation is not what is tested here
            await ev(`document.querySelector('.ac-card[data-id="1"] .ac-actions .ac-act[aria-label^="Delete"]').click(); true`);
            await waitFor(vis('.ac-working'), at + 'a delete says Deleting the comment…', 3000);
            chk(/Deleting the comment/.test(await ev(`document.querySelector('.ac-working').textContent`)) && /Deleting the comment/.test(await live()), at + 'a delete says so on one line and is announced: ' + JSON.stringify([await ev(`document.querySelector('.ac-working').textContent`), await live()]));
            chk(await ev(`getComputedStyle(document.querySelector('.ac-card .ac-act')).pointerEvents`) === 'none', at + 'and the thread\'s buttons wait');
            await ev(`window.__release(); window.__hold = null; true`);
            await waitFor(`!document.querySelector('.ac-working')`, at + 'the line goes when it is answered', 8000);
            await ev(`document.querySelector('#artifact-viewer [data-dialog-close], #artifact-viewer .artifact-viewer-close')?.click(); true`);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: the viewer closes over a frame
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log('PASS a comment on its way says so: busy, no double send, a failure keeps the draft, a delete says what it does');
})().catch(e => { console.error(e); process.exit(1); });
