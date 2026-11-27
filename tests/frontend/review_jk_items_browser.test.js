// #21852 (the Operator: "the left right arrows to switch items in the inbox is confusing, because I often think it is versions"): a document review's top bar has no item pager (no arrows, no "2 of 11", no
// Previous / Next file items in the ⋯ menu); J / K open the next / previous Inbox item, do nothing in a text field and say so at the first and last item; Details names the keys. 1280 and 390.
// The review is the draft-comments document review (the fixture of artifact_review_header_actions_browser). JK_SHOTS_ONLY=1 takes the before pictures on the old build.
const SHOTS_ONLY = !!process.env.JK_SHOTS_ONLY;
const assert = SHOTS_ONLY ? { equal() {}, ok() {}, match() {}, deepEqual() {} } : require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const { BASE } = require('./test_base');
const HEX = 'd'.repeat(64);
const OTHER = 'e'.repeat(64);
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const S = `(window.__coralStatic || '/static/')`;
 const shot = require('./helpers/scene_shots')(Page, 'jk');
 const { Input } = client;
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

 const LIST = `[{ hex: '${HEX}', filename: 'Release plan', board: 'draft-test' }, { hex: '${OTHER}', filename: 'Rollout plan', board: 'draft-test' }]`;
 const open = async width => {
  await Emulation.setDeviceMetricsOverride({ width, height: width === 390 ? 844 : 800, deviceScaleFactor: 1, mobile: width === 390 });
  await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
  await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await ev(fixture);
  await ev(`window.__drafts = [{ id: 1, body: 'Name the rollback owner before launch.', anchor: { whole: true }, source: 'owner', images: [] }]; window.__revision = 1; true`);
  await ev(`import(${S} + 'artifact_viewer.js').then(m => m.openArtifactViewer('${HEX}', { filename: 'Release plan', board: 'draft-test', fileList: ${LIST}, fileIndex: 0 }))`);
  await waitFor(`!!document.querySelector('.ac-draft-card') && !document.querySelector('.ac-draft-bar button.btn-primary')?.disabled`, 'review ready'); await waitFor(`!!document.querySelector('#artifact-viewer.av-draft-document[data-document-review]') && document.querySelector('.artifact-file-position')?.textContent === '1 of 2'`, 'the viewer is the document review with its list (class, attribute and position follow the draft card under load)'); await ev(framesJs(3));
 };
 const title = () => ev(`document.querySelector('.artifact-viewer-title').textContent.trim()`);
 const key = async (k, target) => { if (target) await ev(`document.querySelector(${JSON.stringify(target)}).focus(); true`); await Input.dispatchKeyEvent({ type: 'keyDown', key: k, code: 'Key' + k.toUpperCase(), text: k, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: 'Key' + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) }); await ev(framesJs(4)); };
 const say = t => ev(`document.querySelector('.artifact-file-note')?.textContent === ${JSON.stringify(t)}`);
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setTimezoneOverride({ timezoneId: 'UTC' });
  for (const w of [1280, 390]) {
   const at = `${w} px: `, mobile = w === 390;
   await open(w);
   await shot(`review-${w}`);
   await ev(`document.querySelector('.artifact-viewer-more').click(); true`); await ev(framesJs(4)); await shot(`menu-${w}`); await ev(`document.querySelector('.artifact-viewer-more').click(); true`); await ev(framesJs(2));
   if (SHOTS_ONLY) continue;
   // the pager is gone: no arrows, no "n of m", no menu items
   assert.equal(await ev(`[...document.querySelectorAll('.artifact-file-navigation, .artifact-file-prev, .artifact-file-next, .artifact-file-position')].filter(e => e.getClientRects().length).length`), 0, at + 'no item arrows or position in the top bar');
   assert.equal(await ev(`/\\d+ of \\d+/.test(document.querySelector('.artifact-viewer-header').innerText)`), false, at + 'no "n of m" in the top bar');
   await ev(`document.querySelector('.artifact-viewer-more').click(); true`); await ev(framesJs(3));
   assert.equal(await ev(`[...document.querySelectorAll('#artifact-viewer .artifact-viewer-menu .menu-item')].filter(e => e.getClientRects().length).map(e => e.textContent.trim()).filter(t => /^(previous|next) file/i.test(t)).length`), 0, at + 'no Previous / Next file items in the ⋯ menu');
   await ev(`document.querySelector('.artifact-viewer-more').click(); true`);
   // Details names the keys
   await ev(`document.querySelector('.artifact-viewer-details').click(); true`); await ev(framesJs(3));
   assert.equal(await ev(`document.body.textContent.includes('J / K: next / previous item in the Inbox')`), true, at + 'Details names J / K');
   await shot(`details-${w}`); await ev(`document.querySelector('.artifact-viewer-details').click(); true`);
   // J / K move; at the ends they stay put and say so
   assert.equal(await title(), 'Release plan', at + 'starts at the first item');
   await key('k', '#artifact-viewer'); assert.equal(await title(), 'Release plan', at + 'K at the first item stays put'); assert.equal(await say('This is the first item in the Inbox'), true, at + 'and says so in its status line (first) ' + await ev(`JSON.stringify(document.querySelector('.artifact-file-note')?.outerHTML)`));
   await key('j', '#artifact-viewer'); await waitFor(`document.querySelector('.artifact-viewer-title').textContent.trim() === 'Rollout plan'`, at + 'J opens the next item'); await waitFor(`document.querySelector('.artifact-file-position').textContent === '2 of 2'`, at + 'the item is drawn');
   await key('j', '#artifact-viewer'); assert.equal(await title(), 'Rollout plan', at + 'J at the last item stays put'); assert.equal(await say('This is the last item in the Inbox'), true, at + 'and says so in its status line (last) ' + await ev(`JSON.stringify(document.querySelector('.artifact-file-note')?.outerHTML)`));
   await key('k', '#artifact-viewer'); await waitFor(`document.querySelector('.artifact-viewer-title').textContent.trim() === 'Release plan'`, at + 'K opens the previous item'); await waitFor(`document.querySelector('.artifact-file-position').textContent === '1 of 2'`, at + 'the item is drawn');
   // a j typed in the comment box is a j
   await waitFor(`!!document.querySelector('.ac-composer .ac-input, .ac-composer textarea')`, at + 'the comment box is there');
   const box = '.ac-composer .ac-input, .ac-composer textarea';
   await ev(`document.querySelector(${JSON.stringify(box)}).value = ''; true`);
   await key('j', box); await key('k', box);
   assert.equal(await ev(`document.querySelector(${JSON.stringify(box)}).value`), 'jk', at + 'J and K type in the comment box');
   assert.equal(await title(), 'Release plan', at + 'and move nothing');
   // no modifier
   await ev(`document.querySelector('#artifact-viewer').focus(); true`);
   await Input.dispatchKeyEvent({ type: 'keyDown', key: 'j', code: 'KeyJ', modifiers: 2, windowsVirtualKeyCode: 74 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'j', code: 'KeyJ', modifiers: 2, windowsVirtualKeyCode: 74 }); await ev(framesJs(4));
   assert.equal(await title(), 'Release plan', at + 'Ctrl+J moves nothing');
  }
  console.log('PASS the review has no item arrows; J / K move between Inbox items at 1280 and 390');
 } finally { try { client.close(); } catch {} }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
