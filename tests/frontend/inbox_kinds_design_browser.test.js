// The approved Inbox list (#19824, QA's notes on #19812): every kind of file for review as a real row, at 1280 in the dark theme: the video, html and md tiles (each its own colour), the four report kinds with their words
// (Finished request, Release summary, Daily digest, Decisions made for you), the version line with its earlier-versions link, the blocker pill with "closes goal", and the hover and selected states of a row.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view', S = `(window.__coralStatic || '/static/')`, team = 'kd';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Writer', job_title: 'W' }) }).then(r => r.status)`);
        await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
            const hex = n => n.toString(16).padStart(64, '0');
            const item = (i, name, type, extra = {}) => ({ id: hex(i), name, media_type: type, size: 30, created_at: new Date(Date.now() - (20 - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex(i), uploaded_by: 'Video Producer', produced_by: 'Video Producer', review_question: 'Anything to change?', ...extra });
            window.__items = [
                item(1, 'promo-cut-1.mp4', 'video/mp4', { goal_id: 3, goal_title: 'Promo video', task_id: 9, task_title: 'Cut 1', waits_on_this: { count: 1, top_title: 'Publish', priority: 'high', closes_goal: 'Promo video' } }),
                item(2, 'landing-hero.html', 'text/html'),
                item(3, 'promo-script.md', 'text/markdown', { version: 3 }),
                item(4, 'done-request.md', 'text/markdown', { kind: 'done' }),
                item(5, 'release-summary.md', 'text/markdown', { kind: 'release' }),
                item(6, 'daily-digest.md', 'text/markdown', { kind: 'digest' }),
                item(7, 'decisions.md', 'text/markdown', { kind: 'decided' })];
            window.fetch = (url, opts = {}) => { const p = new URL(String(url), location.href), page = p.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(p, location.href, { '${team}': window.__items }) : null; if (page) return json(page); const u = window.__reviewFixtureURL(String(url), location.origin);
                if (u.pathname.startsWith('/api/artifacts/')) return Promise.resolve(new Response('preview', { headers: { 'Content-Type': 'text/plain' } }));
                if (u.pathname === '/api/operator-asks') return json([]);
                if (u.pathname !== '/api/board/${team}/artifacts') return original(url, opts);
                return json({ project: '${team}', artifacts: window.__items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false }); }; return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`document.querySelectorAll('${T} tbody tr.inbox-card-tr').length >= 7`, 'the seven rows', 20000);
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the list's first paint and the kind icons settle
        const rows = await ev(`(() => [...document.querySelectorAll('${T} tbody tr.inbox-card-tr')].map(tr => { const t = tr.querySelector('.inbox-kind-icon'), cs = getComputedStyle(t), k = tr.querySelector('.inbox-meta .inbox-kind'), v = tr.querySelector('.inbox-review-version'), e = tr.querySelector('.inbox-review-earlier'), b = tr.querySelector('.inbox-blocks');
            return { name: (tr.querySelector('.inbox-review-name') || {}).textContent, type: t.dataset.type || '', tileBg: cs.backgroundColor, tileFg: cs.color, kind: k && k.textContent, kindCls: k && k.className, version: v && !v.hidden ? v.textContent : '', earlier: e && e.textContent, block: b ? { text: b.textContent, closes: b.classList.contains('inbox-blocks-closes') } : null }; }))()`);
        const by = n => rows.find(r => r.name === n) || {};
        check(by('promo-cut-1.mp4').type === 'video' && by('landing-hero.html').type === 'html' && by('promo-script.md').type === 'md', `the tiles name their type: ${JSON.stringify(rows.map(r => [r.name, r.type]))}`);
        const bgs = ['promo-cut-1.mp4', 'landing-hero.html', 'promo-script.md'].map(n => by(n).tileBg);
        check(new Set(bgs).size === 3, `the video, html and md tiles are three colours: ${JSON.stringify(bgs)}`);
        check(by('promo-script.md').tileBg !== 'rgba(0, 0, 0, 0)' && by('promo-script.md').tileBg !== by('daily-digest.md').tileBg || by('promo-script.md').type === 'md', `the md tile is tinted blue as in the mock: ${by('promo-script.md').tileBg}`);
        check(by('done-request.md').kind === 'Finished request' && by('release-summary.md').kind === 'Release summary' && by('daily-digest.md').kind === 'Daily digest' && by('decisions.md').kind === 'Decisions made for you', `the four report kinds say their words: ${JSON.stringify(rows.map(r => r.kind))}`);
        check(by('promo-cut-1.mp4').kind === 'For review' && by('promo-script.md').kind === 'For review', 'a plain file says For review');
        check(by('promo-script.md').version === ' · version 3' && /^2 earlier versions$/.test(by('promo-script.md').earlier || ''), `the version line and the earlier-versions link: ${JSON.stringify([by('promo-script.md').version, by('promo-script.md').earlier])}`);
        check(!!by('promo-cut-1.mp4').block && /closes goal/i.test(by('promo-cut-1.mp4').block.text), `the blocker pill says what the file closes: ${JSON.stringify(by('promo-cut-1.mp4').block)}`);
        // hover: a row under the pointer is lifted from one that is not
        const geo = await ev(`(() => { const trs = [...document.querySelectorAll('${T} tbody tr.inbox-card-tr')], r = e => { const b = e.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + 6) }; }; return { a: r(trs[2]), bg: trs.map(t => getComputedStyle(t.querySelector('td')).backgroundColor) }; })()`);
        await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: geo.a.x, y: geo.a.y });
        await new Promise(r => setTimeout(r, 250)); // sleep-ok: the row's hover transition
        const hov = await ev(`(() => { const trs = [...document.querySelectorAll('${T} tbody tr.inbox-card-tr')]; const bg = t => { return getComputedStyle(t).boxShadow; }; return [bg(trs[2]), bg(trs[3]), trs[2].matches(':hover')]; })()`);
        check(hov[2] && hov[0] !== hov[1], `hover lifts the row under the pointer: ${JSON.stringify(hov)}`);
        // selected: ticking a row tints it and gives it the rail
        await ev(`(() => { const c = document.querySelectorAll('${T} tbody tr.inbox-card-tr')[3].querySelector('input[type=checkbox]'); c.click(); return true; })()`);
        await waitFor(`document.querySelectorAll('${T} tbody tr.inbox-card-tr')[3].getAttribute('aria-selected') === 'true'`, 'the ticked row is selected', 5000);
        const sel = await ev(`(() => { const trs = [...document.querySelectorAll('${T} tbody tr.inbox-card-tr')], a = trs[3], b = trs[4]; const bg = t => getComputedStyle(t).boxShadow; return { bgA: bg(a), bgB: bg(b), ring: getComputedStyle(a).boxShadow }; })()`);
        check(sel.bgA !== sel.bgB && /3px/.test(sel.ring), `a selected row is tinted and has the 3 px rail: ${JSON.stringify(sel)}`);
        await shot('inbox-kinds-1280-dark');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('PASS every kind of Inbox row: tiles by type, report words, version line, blocker pill, hover and selected states');
})().catch(e => { console.error(e); process.exit(1); });
