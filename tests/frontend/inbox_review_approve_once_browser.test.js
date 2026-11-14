// Approve on a Needs you review row resolves the row at once (walk 48, #17068): after Request changes, version 2 arrives and replaces the row; one Approve (and the 'Approve without opening?' yes) used to leave the row
// on screen, dimmed, with Approve still showing, until a second click; and the row's title was cut to 'i'. At 1440 px, dark: the row of a file with an earlier version (changes were requested on it) has its whole
// file name, one Approve click leaves no row and no Approve button for it, and the review is sent once. The team's artifacts and the writes are stubbed in the page.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

const YES = "(()=>{const m=document.getElementById('confirm-modal');if(m&&getComputedStyle(m).display!=='none')document.getElementById('confirm-modal-yes').click();return true})()"; // an unopened file asks 'Approve without opening?' (#11999)

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'one-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const T = '#group-table-view';
    const S = `(window.__coralStatic || '/static/')`;
    const hex = n => n.toString(16).padStart(64, '0');
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`document.documentElement.setAttribute('data-theme', 'dark'); fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Orchestrator', job_title: 'Orchestrator' }) }).then(r => r.status)`);
        // index.html: v1 had changes requested, v2 arrived and is the newest, for review
        await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
            const hex = n => n.toString(16).padStart(64, '0'), made = n => new Date(Date.now() - n * 3600000).toISOString();
            const item = (n, tags, age) => ({ team: '${team}', id: hex(n), name: 'index.html', media_type: 'text/html', size: 3000, created_at: made(age), source: 'upload', available: true, tags, uri: 'coral://artifacts/' + hex(n), produced_by: 'Orchestrator', session_id: 's1' });
            window.__rv = { calls: [], items: [item(1, ['for review', 'changes requested', 'internal'], 2), item(2, ['for review', 'internal'], 1)] };
            window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href), st = window.__rv;
                if (u.pathname === '/api/team-artifacts') return json(window.__reviewFixturePage(u, location.href, { '${team}': st.items }));
                const m = u.pathname.match(/^\\/api\\/board\\/([^/]+)\\/artifacts(?:\\/([0-9a-f]{64})\\/(review|tags))?$/);
                if (!m) return original(url, opts);
                if (!m[2]) return json({ project: m[1], artifacts: st.items.filter(a => a.team === m[1] && (!u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag')))), has_more: false });
                const it = st.items.find(a => a.team === m[1] && a.id === m[2]), body = opts.body ? JSON.parse(opts.body) : {};
                st.calls.push({ route: m[3], id: m[2], body });
                if (m[3] === 'review') { it.tags = it.tags.filter(t => t !== 'for review').concat('approved'); return json({ id: it.id, state: 'approved', changed: true, tags: it.tags, delivered: true, to: 'Orchestrator', review: { state: 'approved', at: new Date().toISOString() } }); }
                it.tags = body.tags; return json({ id: it.id, tags: it.tags });
            };
            return true; })()`);
        await ev(`localStorage.removeItem('coral-inbox-needs-filters'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 1`, 'the review row', 15000);
        await ev(framesJs(10));
        const name = await ev(`(() => { const tr = document.querySelector('${T} tbody tr'), n = tr.querySelector('.inbox-review-name'); return n ? { text: n.textContent.replace(/\\s+/g, ' ').trim(), shown: n.clientWidth, needs: n.scrollWidth, w: Math.round(n.getBoundingClientRect().width) } : null; })()`);
        check(!!name && /index\.html/.test(name.text) && name.needs <= name.shown + 1, `the row keeps the whole file name, index.html: ` + JSON.stringify(name));
        await shot('review-row-v2-1440');
        await ev(`document.querySelector('${T} tbody tr button[aria-label^="Approve"]').click(); true`);
        await ev(`new Promise(r => setTimeout(r, 400))`); // sleep-ok: the unopened-file question draws
        await ev(`(() => { const m = document.getElementById('confirm-modal'); if (m && getComputedStyle(m).display !== 'none') document.getElementById('confirm-modal-yes').click(); return true; })()`);
        await waitFor(`window.__rv.calls.some(c => c.route === 'review')`, 'the review is sent', 10000).catch(() => {});
        await ev(framesJs(60));
        const after = await ev(`(() => ({ rows: [...document.querySelectorAll('${T} tbody tr')].map(tr => ({ text: tr.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80), approve: !!tr.querySelector('button[aria-label^="Approve"]'), opacity: getComputedStyle(tr).opacity })), calls: window.__rv.calls.filter(c => c.route === 'review').length }))()`);
        await shot('review-row-after-approve-1440');
        check(after.calls === 1, 'one review is sent for one click: ' + JSON.stringify(after));
        check(after.rows.length === 0, 'one Approve click leaves no row (it is not dimmed on screen with Approve still showing): ' + JSON.stringify(after));
    } catch (e) { failures.push('stopped: ' + e.message); } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('inbox_review_approve_once_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
