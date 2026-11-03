// The New goal screen, part 2: pictures (#12724, direction A). Paste into the text, drop on the screen and the picker add pictures as thumbnails in a row (each stored as it is added, on the goal's team), each
// with Mark up and Remove reachable (by hover or focus on a desktop, always shown on a phone), a dashed tile to drop, paste or choose, a count in the "Pictures" label, the toolbar's picture button opens the
// picker, and Create sends the stored pictures' ids. 1280, 390 and 200% text. The routes are stood in in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const STUB = `(() => { window.__posts = []; window.__uploads = []; let n = 0; const R = window.fetch; const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
    window.fetch = (u, o) => { const url = new URL(String(u), location.href);
        if (/\\/api\\/board\\/[^/]+\\/subscribers/.test(url.pathname)) return json([{ subscriber_id: 'Lead-agent', job_title: 'Orchestrator', session_name: 'lead' }]);
        if (/\\/api\\/board\\/[^/]+\\/goal-images$/.test(url.pathname) && o && o.method === 'POST') { n++; const hex = String(n).repeat(64).slice(0, 64); window.__uploads.push(hex); return json({ hex, name: 'pic' + n + '.png', content_type: 'image/png', size: 70 }); }
        if (/\\/api\\/board\\/[^/]+\\/goals$/.test(url.pathname) && o && o.method === 'POST') { window.__posts.push(JSON.parse(o.body)); return json({ id: 78 }, 201); }
        return R(u, o); }; })();`;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const file = (name) => `new File([Uint8Array.from(atob('${PNG}'), c => c.charCodeAt(0))], '${name}', { type: 'image/png' })`;
    const thumbs = () => ev(`[...document.querySelectorAll('.goal-editor .ac-thumb')].map(t => ({ ready: !t.classList.contains('ac-thumb-uploading') && !t.classList.contains('ac-thumb-failed'), w: Math.round(t.getBoundingClientRect().width), markup: !!t.querySelector('.ac-thumb-markup:not([hidden])'), remove: !!t.querySelector('.ac-thumb-remove') }))`);
    const label = () => ev(`document.getElementById('goal-picbox-label').textContent`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile, fs] of [[1280, 900, false, 16], [390, 844, true, 16], [390, 844, true, 32]]) {
            const tag = `${w} px ${fs === 32 ? '200% text' : '100%'}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`document.documentElement.style.fontSize = '${fs}px'; import((window.__coralStatic || '/static/') + 'goal_editor.js').then(m => { m.openGoalEditor({ project: 'team-a' }); return true; })`);
            await waitFor(`!!document.querySelector('.goal-editor .goal-drop') && !document.querySelector('#goal-new-driver').disabled`, `${tag}: the screen with its picture tile`, 8000);
            check(`${tag}: the tile says what it takes`, /Drop, paste or choose/.test(await ev(`document.querySelector('.goal-drop').textContent`)) && (await label()) === 'Pictures');

            // paste into the text
            await ev(`(() => { const dt = new DataTransfer(); dt.items.add(${file('pasted.png')}); const t = document.getElementById('goal-new-description'); t.focus(); t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('.goal-editor .ac-thumb').length === 1 && !document.querySelector('.goal-editor .ac-thumb-uploading')`, `${tag}: the pasted picture is a thumbnail`, 6000);
            // drop on the screen
            await ev(`(() => { const dt = new DataTransfer(); dt.items.add(${file('dropped.png')}); const f = document.querySelector('.goal-form'); f.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })); const over = f.classList.contains('ac-drop'); window.__over = over; f.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('.goal-editor .ac-thumb').length === 2 && !document.querySelector('.goal-editor .ac-thumb-uploading')`, `${tag}: the dropped picture is a thumbnail`, 6000);
            check(`${tag}: the screen shows it takes a drop`, (await ev(`window.__over`)) === true);
            // the picker, and the toolbar's picture button opens it
            await ev(`window.__pickClicks = 0; document.querySelector('.goal-picrow input[type=file]').addEventListener('click', e => { window.__pickClicks++; e.preventDefault(); }, true); document.querySelector('.goal-tb[data-tool="image"]').click(); true`);
            check(`${tag}: the toolbar's picture button opens the picker`, (await ev(`window.__pickClicks`)) === 1);
            await ev(`(() => { const i = document.querySelector('.goal-picrow input[type=file]'), dt = new DataTransfer(); dt.items.add(${file('chosen.png')}); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('.goal-editor .ac-thumb').length === 3 && !document.querySelector('.goal-editor .ac-thumb-uploading')`, `${tag}: the chosen picture is a thumbnail`, 6000);
            let t = await thumbs();
            check(`${tag}: three thumbnails, each stored, each with Mark up and Remove`, t.length === 3 && t.every(x => x.ready && x.markup && x.remove && x.w === Math.round(x.w)), JSON.stringify(t));
            check(`${tag}: the label counts them`, (await label()) === 'Pictures · 3', await label());
            check(`${tag}: three were stored on the team`, (await ev(`window.__uploads.length`)) === 3);
            // mark up and remove are reachable: by focus on a desktop, always on a phone
            await ev(`document.querySelector('.goal-editor .ac-thumb .ac-thumb-remove').focus(); true`); await new Promise(r => setTimeout(r, 150)); // sleep-ok: the focus style has no event
            const ops = await ev(`(() => { const b = document.querySelector('.goal-editor .ac-thumb .ac-thumb-remove'); const r = b.getBoundingClientRect(), o = Number(getComputedStyle(b).opacity), m = document.querySelector('.goal-editor .ac-thumb .ac-thumb-markup').getBoundingClientRect(); return { remove: [Math.round(r.width), Math.round(r.height)], opacity: o, overlap: !(r.right <= m.left || m.right <= r.left) }; })()`);
            check(`${tag}: Remove shows on focus and does not sit on Mark up`, ops.opacity === 1 && !ops.overlap, JSON.stringify(ops));
            if (mobile && fs === 16) check(`${tag}: on a phone the buttons are drawn without a hover and are at least 32 px`, ops.remove[1] >= 32, JSON.stringify(ops));
            check(`${tag}: nothing scrolls sideways`, (await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)) <= 0 && (await ev(`(() => { const d = document.querySelector('dialog.goal-editor'); return d.scrollWidth - d.clientWidth; })()`)) <= 1);
            if (fs === 16) await shot(`pictures-${w}`);
            // remove one; the rest stay and the count follows
            await ev(`document.querySelector('.goal-editor .ac-thumb .ac-thumb-remove').click(); true`);
            await waitFor(`document.querySelectorAll('.goal-editor .ac-thumb').length === 2`, `${tag}: one removed`, 4000);
            check(`${tag}: the count follows a removal`, (await label()) === 'Pictures · 2', await label());
            // Create sends the stored ones
            await ev(`document.getElementById('goal-new-title').value = 'With pictures'; document.querySelector('.goals-actions .btn-primary').click(); true`);
            await waitFor(`window.__posts.length === 1`, `${tag}: created`, 6000);
            const post = await ev(`window.__posts[0]`);
            check(`${tag}: Create names the two pictures that are left`, Array.isArray(post.images) && post.images.length === 2 && post.images.every(x => /^[0-9a-f]{64}$/.test(x)), JSON.stringify(post));
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the New goal screen, pictures:\n  ' + problems.join('\n  '));
    console.log('PASS the New goal screen: pictures by paste, drop and picker, mark up and remove, at 1280, 390 and 200% text');
})().catch(e => { console.error(e); process.exit(1); });
