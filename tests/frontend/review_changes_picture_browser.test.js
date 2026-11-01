// A change request can show what to change (#11837, moment 6): the Request changes form in the viewer has the comment box's picture tray (Add image, paste, drop, thumbnails with Mark up and Remove, and the line that says the
// pictures are shared with the team's agents as they are), and the pictures go with the request as the comment's images. Words are still needed (a picture alone is not a change request). The comment, picture and review
// routes are page stubs on a real team. 1280 px.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], team = 'rcp-' + Date.now().toString(36), T = '#group-table-view', S = `(window.__coralStatic || '/static/')`;
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const PIC = 'a'.repeat(63) + 'b';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Review Writer', job_title: 'Writer' }) }).then(r => r.status)`);
        await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
            const hex = (1).toString(16).padStart(64, '0');
            const item = { id: hex, name: 'Review file.txt', media_type: 'text/plain', size: 30, created_at: new Date(Date.now() - 600000).toISOString(), task_id: 0, source: 'upload', available: true, session_id: 'writer-a', produced_by: 'Writer A', tags: ['for review'], uri: 'coral://artifacts/' + hex };
            window.__comments = []; window.__uploads = []; window.__decisions = [];
            window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), m = opts.method || 'GET';
                if (m === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: !u.searchParams.has('tag') || u.searchParams.get('tag') === 'for review' ? [item] : [], has_more: false });
                if (u.pathname.startsWith('/api/board/${team}/artifacts/') && u.pathname.endsWith('/review') && m === 'POST') { window.__decisions.push(JSON.parse(opts.body).decision); return json({ id: hex, state: 'changes requested', changed: true, tags: ['for review', 'changes requested'], review: null }); }
                if (u.pathname === '/api/artifacts/' + hex + '/comment-images' && m === 'POST') { window.__uploads.push(String(opts.body && opts.body.type)); return json({ hex: '${PIC}', name: 'screenshot.png', content_type: 'image/png', size: 70 }); }
                if (u.pathname === '/api/artifacts/' + hex + '/comments' && m === 'POST') { const b = JSON.parse(opts.body); window.__comments.push(b); return json({ id: 7, body: b.body, anchor: b.anchor, author_kind: 'owner', author_name: 'You', state: 'open', created_at: new Date().toISOString(), replies: [], images: [] }, 201); }
                if (u.pathname === '/api/artifacts/' + hex + '/comments/7/send') return json({ ok: true, results: [{ agent: JSON.parse(opts.body).agents[0], state: 'sent', ask_id: 1 }] });
                if (u.pathname.startsWith('/api/artifacts/') && /^[0-9a-f]{64}$/.test(u.pathname.split('/')[3]) && (u.pathname.split('/').length === 4 || u.pathname.split('/')[4] === 'content')) return Promise.resolve(new Response('Review preview text', { headers: { 'Content-Type': 'text/plain' } }));
                return original(url, opts); };
            return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`!![...document.querySelectorAll('${T} tbody tr')].find(r => r.textContent.includes('Review file.txt'))`, 'the review row', 15000);
        await ev(`[...document.querySelectorAll('${T} tbody tr')].find(r => r.textContent.includes('Review file.txt')).querySelector('.inbox-review-name').click(); true`);
        await waitFor(`!!document.querySelector('.artifact-review:not([hidden]) .artifact-review-changes:not([hidden])')`, 'Request changes in the viewer', 8000);
        await ev(`document.querySelector('.artifact-review-changes').click(); true`);
        await waitFor(`!document.querySelector('.artifact-review-form').hidden`, 'the form', 4000);
        const form = await ev(`(() => { const f = document.querySelector('.artifact-review-form'); return { add: !!f.querySelector('.ac-add-image'), hint: (f.querySelector('.ac-images-hint') || {}).textContent || '', tray: !!f.querySelector('.ac-images') }; })()`);
        check(form.add && form.tray && /shared with this team's agents as they are/.test(form.hint), 'the form has Add image, the tray and the line about who sees the pictures: ' + JSON.stringify(form));
        // a picture through the form's own file input
        await ev(`(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(PNG)}), c => c.charCodeAt(0)), dt = new DataTransfer(); dt.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' })); const i = document.querySelector('.artifact-review-form .ac-picker input'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`document.querySelectorAll('.artifact-review-form .ac-thumb-ready').length === 1`, 'the stored thumbnail', 8000);
        check(await ev(`!!document.querySelector('.artifact-review-form .ac-thumb-markup:not([hidden])') && !!document.querySelector('.artifact-review-form .ac-thumb-remove')`), 'the thumbnail has Mark up and Remove');
        await shot('review-changes-picture-1280');
        // words are still needed: a picture alone is not a change request
        await ev(`document.querySelector('.artifact-review-form').requestSubmit(); true`);
        await waitFor(`/Say what should change/.test(document.querySelector('.artifact-review-error').textContent)`, 'the words are asked for', 4000);
        check((await ev(`window.__comments.length`)) === 0, 'a picture alone sends no request');
        await ev(`(() => { const t = document.getElementById('artifact-review-text'); t.value = 'The totals row is missing; see the picture'; document.querySelector('.artifact-review-form').requestSubmit(); return true; })()`);
        await waitFor(`window.__decisions.includes('changes')`, 'the request was recorded', 8000);
        const c = await ev(`window.__comments[0]`);
        check(!!c && c.anchor.whole === true && /The totals row is missing/.test(c.body) && JSON.stringify(c.images) === JSON.stringify([PIC]), 'the comment carries the words and the picture: ' + JSON.stringify(c));
        check(await ev(`document.querySelectorAll('.artifact-review-form .ac-thumb').length`) === 0, 'the tray is empty after the request is sent');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('review_changes_picture_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
