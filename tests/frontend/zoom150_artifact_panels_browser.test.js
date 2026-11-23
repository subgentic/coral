// Walk 60 (#17300), 150% zoom on a 1280 x 800 laptop (853 x 533 CSS px): the comment panel's Send is on screen with its box, and Request changes does not push the document out of view.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`, out = [];
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 853, height: 533, deviceScaleFactor: 1.5, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(STUB);
        await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(H3)}, { filename: 'release-plan.md' }); return true; })()`);
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-body') && document.querySelector('#artifact-viewer .artifact-viewer-body').textContent.length > 20`, 'the file shows', 12000);
        await shot('zoom-viewer');
        const sel = () => {
            const body = document.querySelector('#artifact-viewer .artifact-viewer-body'), p = [...body.querySelectorAll('p, li')].find(e => e.textContent.trim().length > 30) || body;
            const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let last = null; while (walker.nextNode()) last = walker.currentNode;
            const r = document.createRange(); r.setStart(last, Math.max(0, last.length - 12)); r.setEnd(last, last.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true;
        };
        await ev(`(${sel.toString()})()`);
        await waitFor(`(() => { const b = document.querySelector('.ac-selbtn'); return !!b && !b.hidden; })()`, 'Add comment shows', 8000);
        await ev(`document.querySelector('.ac-selbtn').click(); true`);
        await waitFor(`!!document.querySelector('#artifact-viewer .ac-composer .ac-quote')`, 'the comment box opens', 5000);
        await shot('zoom-comment');
        const m = await ev(`(() => { const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom), Math.round(b.left), Math.round(b.right)]; }, c = document.querySelector('#artifact-viewer .ac-composer');
            return { vh: innerHeight, composer: r(c), send2: r(c.querySelector('.ac-send')), buttons: [...c.querySelectorAll('button')].map(b => b.textContent.trim() + ':' + r(b)), box: r(c.querySelector('textarea')), body: r(document.querySelector('#artifact-viewer .artifact-viewer-body')) }; })()`);
        assert.ok(m.buttons.length === 3 && m.composer[1] <= m.vh && m.send2 && m.send2[1] <= m.vh, 'the comment box and its Send (Comment) button are on screen at the panel foot: ' + JSON.stringify(m));
        await ev(`document.querySelector('#artifact-viewer .ac-composer .ac-cancel').click(); true`);
        // Request changes: the panel that opens leaves the document in view
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await ev(STUB);
        await ev(`(() => { const orig = window.fetch.bind(window); window.fetch = (u, o) => { const url = String(u);
            if (/\\/api\\/team-artifacts/.test(url)) return Promise.resolve(new Response(JSON.stringify(window.__reviewFixturePage(u, location.origin, { 'team-a': [{ id: '${H3}', name: 'release-plan.md', available:true,tags: ['for review'], produced_by: 'Writer A', media_type: 'text/markdown', size: 12000, created_at: new Date().toISOString() }] })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            if (/\\/api\\/board\\/team-a\\/artifacts\\?tag=(approved|reviewed)/.test(url)) return Promise.resolve(new Response(JSON.stringify({ artifacts: [], has_more: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            if (/\\/api\\/board\\/team-a\\/artifacts\\/[0-9a-f]{64}\\/tags/.test(url) && o && o.method === 'PUT') return Promise.resolve(new Response(JSON.stringify({ tags: ['for review', 'read'] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            return orig(u, o); }; return true; })()`);
        await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${H3}', { goal: 'Ship it', goalId: 3, goalTeam: 'team-a', task: 'A task', filename: 'release-plan.md', board: 'team-a', from: 'Writer A · team-a' })).then(() => true)`);
        await waitFor(`!!document.querySelector('.artifact-review-changes:not([hidden])') && !!document.querySelector('.av-current')`, 'the viewer shows its review', 12000);
        await ev(`(() => { const b = document.querySelector('#artifact-viewer .artifact-review-changes'); if (b) b.click(); return true; })()`);
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-review:not([hidden]) textarea, #artifact-viewer .artifact-review-form:not([hidden])')`, 'the request-changes form opens', 6000);
        await shot('zoom-request');
        const q = await ev(`(() => { const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom)]; }, d = document.querySelector('#artifact-viewer'); return { vh: innerHeight, body: r(d.querySelector('.artifact-viewer-body')), review: r(d.querySelector('.artifact-review')), form: r(d.querySelector('.artifact-review form')), kids: [...d.querySelector('.artifact-review form').children].map(e => e.tagName + '.' + e.className + ':' + r(e)), buttons: [...d.querySelectorAll('.artifact-review button')].map(b => b.textContent.trim() + ':' + r(b)) }; })()`);
        assert.ok(q.body[0] <= 330 && q.review[1] <= 330 && q.buttons.every(b => { const bottom = +b.split(',')[1]; return bottom > 0 && bottom <= q.vh; }), 'the change request is compact and the document starts in the upper part of the window: ' + JSON.stringify(q));
        assert.equal(await ev(`(()=>{const p=document.querySelector('.artifact-review-form .ac-picker').getBoundingClientRect(),t=document.querySelector('#artifact-review-text').getBoundingClientRect();return Math.abs(p.left-t.left)<=1})()`),true,'Add image keeps the field’s left edge beside the decision buttons');
        console.log('PASS zoom150_artifact_panels_browser');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
