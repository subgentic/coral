// #22094/v19 retires inline Approve/Save/Star and per-row More placement.
// Replacement: one file opener reaches the shared viewer decision controls and note/refuse/copy menu; Select Dismiss still writes once with Undo. No Save path exists in v19 (reported to Orchestrator).
// The actions of a Needs you review row, option B (#12231, the operator: "We can do better with these buttons", then "I like option B, let's use Dismiss instead of the word Ignore"): one Approve button; Request changes and Save for later as
// quiet icons of one size, named for the file; the three dots hold Approve with a note, Dismiss and Deny (Deny in the error colour, never a red fill); the word Ignore is nowhere on the row, in its menu or in the toast, which says Dismissed
// with Undo. A button is at the same x on every row; on a phone every target is 44 px. 1280 and 390 px; review files and a question stubbed in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'b-' + Date.now().toString(36), T = '#group-table-view';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await ev(`localStorage.clear(); sessionStorage.clear(); true`); await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const hex = n => n.toString(16).padStart(64, '0'), ago = m => new Date(Date.now() - m * 60000).toISOString(); const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                window.__posts = []; const items = [1, 2, 3].map(i => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 3000, created_at: ago(30 + i), source: 'upload', available: true, tags: ['for review'], uploader: 'Writer', produced_by: 'Writer' }));
                window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': items}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin), method = (opts.method || 'GET').toUpperCase();
                    if (method === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    if (method === 'POST' && /\\/artifacts\\/[0-9a-f]{64}\\/review$/.test(u.pathname)) { const b = JSON.parse(opts.body); window.__posts.push(b.decision); const it = items.find(a => u.pathname.includes(a.id)); if (b.decision === 'ignore') it.tags = ['for review', 'ignored']; return json({ id: it.id, state: b.decision, changed: true, tags: it.tags, delivered: false }); }
                    if (/\\/api\\/artifacts\\/[0-9a-f]{64}$/.test(u.pathname)) return Promise.resolve(new Response('# Plan content', {headers:{'Content-Type':'text/markdown'}}));
                    if (u.pathname.endsWith('/review-drafts')) return json({drafts_supported:false,drafts:[],count:0,revision:0,can_write:false,can_send:false});
                    if (u.pathname.endsWith('/tags') && method === 'PUT') {const it=items.find(a=>u.pathname.includes(a.id));if(it)it.tags=JSON.parse(opts.body).tags;return json({tags:it?.tags||[]});}
                    if (u.pathname === '/api/operator-asks') return json([{ board: '${team}', kind: 'ask', id: 41, asker: 'Lead', text: 'Which port should the test server use?', at: ago(20) }]);
                    return original(url, opts); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} .nl-row').length===4`,at+'three reviews and a question');
            const files=await ev(`[...document.querySelectorAll('${T} .nl-file')].map(row=>({name:row.querySelector('.nl-file-open').textContent,inline:!!row.querySelector('.inbox-review-actions'),target:row.querySelector('.nl-file-open').getBoundingClientRect().height}))`);
            assert.equal(files.length,3);assert.ok(files.every(f=>!f.inline),at+'file decisions are reached by opening the file, as v19 requires');
            if(mobile)assert.ok(files.every(f=>f.target>=44),at+'file opener targets are 44px');
            const one = `[...document.querySelectorAll('${T} .nl-file')].find(r=>r.textContent.includes('plan-1.md'))`;
            await ev(`${one}.querySelector('.nl-file-open').click();true`);
            await waitFor(`document.querySelector('#artifact-viewer .artifact-review-approve')&&!document.querySelector('#artifact-viewer .artifact-review-approve').hidden`,at+'viewer exposes the review action');
            const actions=await ev(`['.artifact-review-approve','.artifact-review-changes'].map(sel=>{const b=document.querySelector('#artifact-viewer '+sel),r=b.getBoundingClientRect();return{text:b.textContent,disabled:b.disabled,w:r.width,h:r.height};})`);
            assert.deepEqual(actions.map(b=>b.text),['Approve','Request changes'],at+'same decision owner remains reachable from the file');
            assert.ok(actions.every(b=>!b.disabled),at+'pending version can be reviewed');
            if(mobile)assert.ok(actions.every(b=>b.w>=44&&b.h>=44),at+'review decision targets stay 44px');
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-more').click();true`);
            await waitFor(`!document.querySelector('#artifact-viewer .artifact-viewer-menu').hidden`,at+'viewer More opens');
            const menu=await ev(`[...document.querySelectorAll('#artifact-viewer .menu-item')].filter(b=>b.getClientRects().length).map(b=>b.textContent.trim())`);
            for(const label of ['Approve with a note','Refuse','Copy version ID'])assert.ok(menu.includes(label),at+'viewer retains '+label+': '+JSON.stringify(menu));
            assert.ok(menu.every(t=>!/Ignore/.test(t)),at+'no obsolete Ignore wording');
            await shot('needs-actions-viewer-'+w);
            await ev(`document.querySelector('.artifact-viewer-close').click();true`);
            if(mobile)await ev(`document.querySelector('.nl-phone-select').click();true`);
            await ev(`${one}.querySelector('.nl-check').click();true`);
            await waitFor(`/1 selected/.test(document.querySelector('.nl-summary').textContent)`,at+'file selects once');
            await ev(`[...document.querySelectorAll('.nl-summary button')].find(b=>b.textContent==='Dismiss').click();true`);
            await waitFor(`[...document.querySelectorAll('.toast')].some(t=>/Dismissed 1/.test(t.textContent))`,at+'Dismiss uses the existing review route');
            const result=await ev(`({posts:window.__posts,undo:[...document.querySelectorAll('.toast')].some(t=>/Dismissed 1/.test(t.textContent)&&[...t.querySelectorAll('button')].some(b=>b.textContent==='Undo'))})`);
            assert.deepEqual(result.posts,['ignore'],at+'one dismissal sends one existing decision');assert.ok(result.undo,at+'Dismiss still offers Undo');
            await waitFor(`document.querySelectorAll('.nl-file').length===2`,at+'dismissed file leaves the list');
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await client.close(); }
    console.log('needs_actions_b_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
