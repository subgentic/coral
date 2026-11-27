// #21851 (the Operator: "Let's keep the fullscreen expand in the top bar"): a document review's top bar has the expand (Full screen) icon button, icon only with its label and title and keyboard access, at 1280 and 390;
// it is not also an item of the ⋯ menu, and on a phone the name keeps its own full row and stops short of the two icons (#21777). #21185 (1f86d0fe9e) had hidden the button in a review (a phone had only the menu item).
// The review is the draft-comments document review (the fixture of artifact_review_header_actions_browser). EXPAND_SHOTS_ONLY=1 takes the before pictures on the old build.
const SHOTS_ONLY = !!process.env.EXPAND_SHOTS_ONLY;
const assert = SHOTS_ONLY ? { equal() {}, ok() {}, match() {}, deepEqual() {} } : require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const { BASE } = require('./test_base');
const HEX = 'd'.repeat(64);
const OTHER = 'e'.repeat(64);
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const S = `(window.__coralStatic || '/static/')`;
 const shot = require('./helpers/scene_shots')(Page, 'expand');
    const fixture = `(() => {
        const real = fetch;
        window.__reviewRow = { id: '${HEX}', uri: 'coral://artifacts/${HEX}', name: 'Release plan', media_type: 'text/markdown', available: true, tags: ['for review'], team: 'draft-test', board_id: 'draft-test', produced_by: 'Frontend Dev', version: 2, created_at: new Date().toISOString() }; window.__drafts = []; window.__revision = 0; window.__writes = []; window.__batches = []; window.__unknown = false; window.__refuse = false; window.__seen = {}; window.__published = []; window.__decisions = []; window.__decisionReplay = null; window.__loseDecision = false;
        const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, options = {}) => {
            const url = new URL(String(u), location.href), method = options.method || 'GET';
            if (url.pathname.endsWith('/comment-images')) return json({hex:'f'.repeat(64),name:'review.png',content_type:'image/png'});
            if (url.pathname === '/api/artifacts/' + 'f'.repeat(64)) return Promise.resolve(new Response(Uint8Array.from(atob(window.__png), c => c.charCodeAt(0)), {headers:{'Content-Type':'image/png'}}));
            const body = options.body ? JSON.parse(options.body) : {};
            if (url.pathname.endsWith('/tags') && method === 'PUT') { window.__reviewRow.tags = body.tags; return json({tags:body.tags}); }
            if (url.pathname === '/api/team-artifacts' && window.__reviewRow) return json(window.__reviewFixturePage(u, location.href, { 'draft-test': [{ ...window.__reviewRow, draft_count: window.__drafts.length }] }));
            if (url.pathname.endsWith('/review') && method === 'POST') {
                if (window.__decisionReplay) return json(window.__decisionReplay);
                window.__decisions.push(body); window.__drafts = []; window.__revision++;
                if (window.__loseDecision) { window.__loseDecision = false; window.__decisionReplay = { status: 'sent', request_id: body.send_drafts.request_id, replayed: true }; return Promise.reject(new TypeError('Decision response lost')); }
                return json({ state: body.decision === 'approve' ? 'approved' : 'changes', changed: true, tags: ['approved'], review: { state: body.decision === 'approve' ? 'approved' : 'changes' }, delivered: true, to: 'Builder', drafts_sent: true, batch: { status: window.__batchStatus || 'sent' } });
            }
            if (url.pathname.includes('/review-drafts')) {
                if (method === 'GET' && window.__draftsStatus) return json({ error: 'refused', message: 'refused' }, window.__draftsStatus); // a Hub without the route (404), a person who may not keep drafts (403)
                if (method === 'GET') return json({ drafts: url.pathname.includes('${OTHER}') ? [] : window.__drafts, revision: window.__revision, count: url.pathname.includes('${OTHER}') ? 0 : window.__drafts.length, drafts_supported: true, can_write: window.__writeAllowed !== false, can_send: window.__sendAllowed !== false, reason: window.__reason || '', targets: window.__targets || ['Builder'] });
                window.__writes.push({ url: url.pathname, method, body });
                if (url.pathname.endsWith('/send')) {
                    if (window.__refuse) return json({ code: window.__refuseCode || 'not_delivered', error: window.__refuseWords || 'Agent unavailable. Drafts kept.' }, 409);
                    if (window.__seen[body.request_id]) return json({ ...window.__seen[body.request_id], replayed: true });
                    if (body.revision !== window.__revision) return json({ code: 'stale_revision', error: 'Drafts changed. Reload before sending.' }, 409);
                    window.__batches.push(window.__drafts.map(d => ({ ...d })));
                    window.__published.push(...window.__drafts.map(d => ({ ...d, author: { kind: 'owner', subject: 'Operator' }, created_at: new Date().toISOString(), can: {} })));
                    window.__drafts = []; window.__revision++;
                    const result = { ok: true, status: 'sent', revision: window.__revision, remaining_count: 0 };
                    window.__seen[body.request_id] = result;
                    if (window.__unknown) { window.__unknown = false; return Promise.reject(new TypeError('Connection lost after delivery')); }
                    return json(result);
                }
                if (method === 'POST') { window.__drafts.push({ ...body, id: window.__revision + 1, source: 'owner' }); window.__revision++; return json({ draft: window.__drafts.at(-1), revision: window.__revision, count: window.__drafts.length }, 201); }
                const id = Number(url.pathname.split('/').at(-1));
                if (method === 'PATCH') window.__drafts = window.__drafts.map(d => d.id === id ? { ...d, body: body.body } : d);
                if (method === 'DELETE') window.__drafts = window.__drafts.filter(d => d.id !== id);
                window.__revision++; return json({ ok: true, revision: window.__revision });
            }
            if (url.pathname.includes('/api/artifacts/') && url.pathname.includes('/comments')) {
                if (method !== 'GET') { window.__writes.push({ url: url.pathname, method, body }); return json({ error: 'Published writes forbidden in draft fixture' }, 500); }
                return json({ comments: window.__published, locked: false, you: { kind: 'owner', name: 'Operator', can_comment: true, can_lock: true }, limits: { body: 8192 } });
            }
            if (url.pathname === '/api/artifacts/${HEX}' || url.pathname === '/api/artifacts/${OTHER}') return Promise.resolve(new Response('# Release plan\\n\\nVersion 2 · Frontend Dev\\n\\n## Before launch\\n\\nAssign an owner before launch. Confirm that the team can roll back the release.\\n\\n## Rollout\\n\\nMonitor the rollout. Pause if the error rate rises and confirm the review is finished.', { headers: { 'Content-Type': 'text/markdown' } }));
            return real(u, options);
        }; return true;
    })()`;

 const open = async width => {
  await Emulation.setDeviceMetricsOverride({ width, height: width === 390 ? 844 : 800, deviceScaleFactor: 1, mobile: width === 390 });
  await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
  await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await ev(fixture);
  await ev(`window.__drafts = [{ id: 1, body: 'Name the rollback owner before launch.', anchor: { whole: true }, source: 'owner', images: [] }]; window.__revision = 1; true`);
  await ev(`import(${S} + 'artifact_viewer.js').then(m => m.openArtifactViewer('${HEX}', { filename: 'Release plan for the spring launch, reviewed by legal and the press office', board: 'draft-test' }))`);
  await waitFor(`!!document.querySelector('.ac-draft-card') && !document.querySelector('.ac-draft-bar button.btn-primary')?.disabled`, 'review ready'); await ev(framesJs(3));
 };
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setTimezoneOverride({ timezoneId: 'UTC' });
  for (const w of [1280, 390]) {
   const mobile = w === 390;
   await open(w);
    const at = `${w} px: `;
    assert.equal(await ev(`document.querySelector('#artifact-viewer').classList.contains('av-draft-document') && document.querySelector('#artifact-viewer').hasAttribute('data-document-review')`), true, at + 'this is the document review');
    await ev(framesJs(3)); await shot(`expand-review-${w}`);
    if (SHOTS_ONLY) { await ev(`document.querySelector('.artifact-viewer-more').click(); true`); await ev(framesJs(3)); await shot(`expand-review-menu-${w}`); continue; }
    const info = await ev(`(() => { const b = document.querySelector('#artifact-viewer .artifact-viewer-header > .artifact-viewer-fullscreen'); if (!b) return null; const r = b.getBoundingClientRect(), t = document.querySelector('.artifact-viewer-title').getBoundingClientRect(), m = document.querySelector('.artifact-viewer-more').getBoundingClientRect(), h = document.querySelector('.artifact-viewer-header').getBoundingClientRect(); return { shown: b.getClientRects().length > 0, label: b.getAttribute('aria-label'), title: b.title, text: b.textContent.trim(), w: r.width, h: r.height, left: r.left, right: r.right, top: r.top, titleRight: t.right, titleW: t.width, headW: h.width, moreLeft: m.left, moreRight: m.right, inHeader: r.left >= h.left && r.right <= h.right, overlapsMore: r.right > m.left + 0.5 && r.left < m.right - 0.5 }; })()`);
    assert.ok(info && info.shown, at + 'the expand icon is in the review top bar: ' + JSON.stringify(info));
    assert.deepEqual([info.label, info.title, info.text], ['Full screen', 'Full screen', '\u2922'], at + 'an icon with its label and title');
    assert.ok(info.inHeader && !info.overlapsMore, at + 'inside the header, beside the ⋯ menu: ' + JSON.stringify(info));
    assert.ok(info.w >= (mobile ? 36 : 28) && info.h >= (mobile ? 44 : 28), at + 'a real target: ' + JSON.stringify(info));
    if (mobile) assert.ok(info.titleRight <= info.left + 0.5 && info.titleW >= 250, at + 'the name keeps its own full row and stops short of the icons (#21777): ' + JSON.stringify(info));
    // not a second copy in the ⋯ menu
    await ev(`document.querySelector('.artifact-viewer-more').click(); true`); await ev(framesJs(3));
    assert.equal(await ev(`[...document.querySelectorAll('#artifact-viewer .artifact-viewer-menu .menu-item')].filter(e => e.getClientRects().length).map(e => e.textContent.trim()).filter(t => /full screen/i.test(t)).length`), 0, at + 'the ⋯ menu has no Full screen item');
    await shot(`expand-review-menu-${w}`);
    await ev(`document.querySelector('.artifact-viewer-more').click(); true`);
    // it works by click and by keyboard
    await ev(`document.querySelector('.artifact-viewer-fullscreen').focus(); true`);
    assert.equal(await ev(`document.activeElement === document.querySelector('.artifact-viewer-fullscreen')`), true, at + 'it takes focus (a button)');
    await ev(`document.querySelector('.artifact-viewer-fullscreen').click(); true`);
    assert.equal(await ev(`document.querySelector('#artifact-viewer').classList.contains('av-fullscreen')`), true, at + 'a click opens full screen');
    assert.equal(await ev(`[document.querySelector('.artifact-viewer-fullscreen').getAttribute('aria-pressed'), document.querySelector('.artifact-viewer-fullscreen').getAttribute('aria-label')].join()`), 'true,Exit full screen', at + 'its state is said');
    await ev(`document.querySelector('.artifact-viewer-fullscreen').click(); true`);
    assert.equal(await ev(`document.querySelector('#artifact-viewer').classList.contains('av-fullscreen')`), false, at + 'and closes it');
    assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), true, at + 'no sideways scroll');
  }
  console.log('PASS the expand icon is in the document review top bar at 1280 and 390');
 } finally { try { client.close(); } catch {} }
})().catch(e => { console.error(e.message); process.exit(1); });
