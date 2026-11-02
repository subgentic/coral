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
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), method = (opts.method || 'GET').toUpperCase();
                    if (method === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    if (method === 'POST' && /\\/artifacts\\/[0-9a-f]{64}\\/review$/.test(u.pathname)) { const b = JSON.parse(opts.body); window.__posts.push(b.decision); const it = items.find(a => u.pathname.includes(a.id)); if (b.decision === 'ignore') it.tags = ['for review', 'ignored']; return json({ id: it.id, state: b.decision, changed: true, tags: it.tags, delivered: false }); }
                    if (u.pathname === '/api/operator-asks') return json([{ board: '${team}', kind: 'ask', id: 41, asker: 'Lead', text: 'Which port should the test server use?', at: ago(20) }]);
                    return original(url, opts); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 4`, at + 'three reviews and a question', 15000); await ev(framesJs(6));
            const row = await ev(`(() => { const tr = [...document.querySelectorAll('${T} tbody tr')].find(r => /plan-1/.test(r.textContent)); tr.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); const box = tr.querySelector('.inbox-review-actions'), vis = e => e.getClientRects().length > 0, name = b => b.getAttribute('aria-label') || b.textContent.trim();
                const direct = [...box.querySelectorAll(':scope > button, :scope > .inbox-row-more > button')].filter(vis); const toggle = box.querySelector('.inbox-row-more-toggle');
                return { direct: direct.map(b => [name(b), b.textContent.trim(), Math.round(b.getBoundingClientRect().width), Math.round(b.getBoundingClientRect().height)]), menu: [...box.querySelectorAll('.menu-item')].map(b => b.textContent.trim()), toggle: !!toggle, text: box.textContent }; })()`);
            assert.deepEqual(row.direct.map(d => d[0].replace(/: plan-1\.md$/, '').replace(/ for plan-1\.md$/, '')), ['Approve', 'Request changes', 'Save for later', 'More actions'].filter(n => !(mobile && n === 'Save for later')), at + 'the row has Approve, then icons for Request changes and Save for later, then the dots (a phone has Save in the dots): ' + JSON.stringify(row.direct));
            assert.ok(row.direct.every(d => d[0].startsWith('Approve') ? d[1] === 'Approve' : d[1] === ''), at + 'only Approve has a word; the others are icons with a name: ' + JSON.stringify(row.direct));
            assert.deepEqual(row.menu.filter(m => m !== 'Save for later'), ['Approve with a note', 'Dismiss', 'Deny'], at + 'the dots hold Approve with a note, Dismiss and Deny: ' + JSON.stringify(row.menu));
            assert.ok(!/Ignore/i.test(row.text), at + 'the word Ignore is nowhere on the row: ' + row.text);
            if (mobile) assert.ok(row.direct.every(d => d[2] >= 44 && d[3] >= 44), at + 'every target is 44 px: ' + JSON.stringify(row.direct));
            const xs = await ev(`[...document.querySelectorAll('${T} tbody tr')].filter(r => /plan-/.test(r.textContent)).map(r => { const a = [...r.querySelectorAll('.inbox-review-actions > button')].filter(b => /^Approve:/.test(b.getAttribute('aria-label') || ''))[0]; return a ? Math.round(a.getBoundingClientRect().left) : null; })`);
            assert.ok(xs.length === 3 && new Set(xs).size === 1, at + 'Approve is at the same x on every row: ' + JSON.stringify(xs));
            const one = `[...document.querySelectorAll('${T} tbody tr')].find(r => /plan-1/.test(r.textContent))`; await shot('needs-actions-b-rows-' + w); await ev(`${one}.querySelector('.inbox-row-more-toggle').click(); true`); await ev(framesJs(3)); await shot('needs-actions-b-' + w);
            const deny = await ev(`(() => { const d = [...${one}.querySelectorAll('.menu-item')].find(b => b.textContent.trim() === 'Deny'); const probe = document.createElement('i'); probe.style.color = 'var(--error)'; document.body.append(probe); const err = getComputedStyle(probe).color; probe.remove(); return d ? { color: getComputedStyle(d).color, err, bg: getComputedStyle(d).backgroundColor } : null; })()`);
            assert.ok(deny && deny.color === deny.err && /rgba\(0, 0, 0, 0\)|transparent/.test(deny.bg), at + 'Deny is in the error colour with no fill: ' + JSON.stringify(deny));
            await ev(`[...${one}.querySelectorAll('.menu-item')].find(b => b.textContent.trim() === 'Dismiss').click(); true`);
            await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Dismissed: plan-/.test(t.textContent))`, at + 'the toast says Dismissed', 6000);
            const toast = await ev(`(() => { const t = [...document.querySelectorAll('.toast')].find(x => /Dismissed/.test(x.textContent)); return { text: t.textContent.replace(/\\s+/g, ' ').trim(), undo: !!([...t.querySelectorAll('button')].find(b => b.textContent.trim() === 'Undo')), posts: window.__posts.slice() }; })()`);
            assert.ok(toast.undo && !/Ignore/i.test(toast.text) && toast.posts.includes('ignore'), at + 'the toast says Dismissed, with Undo, and the review route got the same decision as before: ' + JSON.stringify(toast));
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await client.close(); }
    console.log('needs_actions_b_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
