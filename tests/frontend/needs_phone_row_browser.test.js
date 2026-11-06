// A phone's Needs you review and question rows (#13829, the Operator on #13795/#13818: "too bunched"; replaces #13795's title-first layout): line one is the agent's name (strong), line two the ask (two lines at most, whole)
// with the time since at its right; the kind's words ("For review", "Needs your answer"), the Goal and the Task are not drawn, and the Waiting column is not drawn twice. A long ask and a long sender at 320, 390 and 430.
// The computer's table (1280) is as it was: the sender before the name, the Waiting column, the kind's words. The artifacts and the question are stubbed. Isolated dev server.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], T = '#group-table-view', team = 'npr-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const geo = needle => ev(`(() => { const tr = [...document.querySelectorAll('${T} tbody tr')].find(r => r.textContent.includes(${JSON.stringify(needle)})); if (!tr) return null; const vis = e => !!e && e.getClientRects().length > 0 && e.getBoundingClientRect().width > 1;
        const item = tr.querySelector('.inbox-review-item'), name = tr.querySelector('.inbox-review-name'), from = tr.querySelector('.inbox-review-from'), wait = tr.querySelector('.inbox-review-wait'), col = tr.querySelector('[data-key=waiting]'), r = e => e.getBoundingClientRect();
        const kind = [...tr.querySelectorAll('*')].filter(e => !e.children.length && /^(For review|Needs your answer)$/.test(e.textContent.trim()) && vis(e)).length;
        const text = document.createRange(); text.selectNodeContents(name); const tr_ = text.getBoundingClientRect(), lh = parseFloat(getComputedStyle(name).lineHeight) || 20; // the name is a 44 px target: its text is what is measured
        return { nameTop: Math.round(tr_.top), nameBottom: Math.round(tr_.bottom), nameLeft: Math.round(r(name).left), fromTop: Math.round((() => { const g = document.createRange(); g.selectNodeContents(from); return g.getBoundingClientRect().top; })()), fromLeft: Math.round(r(from).left), fromBottom: Math.round((() => { const g = document.createRange(); g.selectNodeContents(from); return g.getBoundingClientRect().bottom; })()), fromWeight: Number(getComputedStyle(from).fontWeight), nameRight: Math.round(r(name).right), subjectsDrawn: [...tr.querySelectorAll('.inbox-ask-subject-links, .inbox-ask-subject-links a')].filter(e => e.getClientRects().length > 0).length, fromRight: Math.round(r(from).right), fromCut: from.scrollWidth > from.clientWidth + 1, nameCut: name.scrollHeight > name.clientHeight + 1, nameLines: Math.round(tr_.height / lh), boxH: Math.round(name.clientHeight), clamp: getComputedStyle(name).webkitLineClamp, nameFull: name.textContent.trim().length > 0,
            waitShown: vis(wait), waitLeft: wait ? Math.round(r(wait).left) : 0, waitTop: wait ? Math.round(r(wait).top) : 0, fromBoxTop: Math.round(r(from).top), waitText: wait ? wait.textContent.trim() : '', colShown: vis(col) && r(col).height > 1, kindWords: kind, nameText: name.textContent.trim().slice(0, 30) }; })()`);
    const prop = () => ev(`(() => { const tr = [...document.querySelectorAll('${T} tbody tr')].find(r => r.textContent.includes('Fix the login')); if (!tr) return null; const vis = e => !!e && e.getClientRects().length > 0 && e.getBoundingClientRect().width > 1, r = e => e.getBoundingClientRect();
        const item = tr.querySelector('.inbox-review-item'), from = tr.querySelector('.inbox-review-from'), name = item && (item.querySelector('.inbox-review-name') || item), col = tr.querySelector('[data-key=waiting]'), cr = col && col.getBoundingClientRect();
        return { hasItem: !!item, titleFirst: !!tr.querySelector('.inbox-agent-first'), grid: item ? getComputedStyle(item).display : '', waitSpan: !!tr.querySelector('.inbox-review-wait'), colShown: vis(col) && cr.height > 1, colText: col ? col.textContent.trim() : '', fromLeft: from ? Math.round(r(from).left) : null, nameLeft: name ? Math.round(r(name).left) : null, fromTop: from ? Math.round(r(from).top) : null, nameTop: name ? Math.round(r(name).top) : null, colTop: cr ? Math.round(cr.top) : null, rowBottom: Math.round(r(tr).bottom), text: item ? item.textContent.trim().slice(0, 50) : tr.textContent.trim().slice(0, 50) }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[320, 640, true], [390, 844, true], [430, 932, true], [1280, 820, false]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'W', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`localStorage.removeItem('coral-inbox-needs-filters'); true`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0'), made = n => new Date(Date.now() - n * 3600000).toISOString();
                const item = (n, name, extra) => ({ id: hex(n), name, media_type: 'text/html', size: 30, created_at: made(n), source: 'upload', available: true, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex(n), ...extra });
                const items = { '${team}': [item(1, 'Plan 1 - review the release notes for the tag run.html', { session_id: 'w-a', produced_by: 'Lead Developer of the platform team with a very long title' }), item(2, 'Plan 2 - review the release notes for the tag run.html', { session_id: 'w-b', produced_by: 'DevOps Engineer' })] };
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), m = u.pathname.match(/^\\/api\\/board\\/([^/]+)\\/artifacts$/);
                    if (m && items[m[1]]) return json({ project: m[1], artifacts: !u.searchParams.has('tag') || u.searchParams.get('tag') === 'for review' ? items[m[1]] : [], has_more: false });
                    if (u.pathname === '/api/proposals') return json({ proposals: [{ id: 11, board_id: '${team}', kind: 'task', title: 'Fix the login page on Safari', proposer: 'Backend Dev of the platform team', state: 'pending', created_at: new Date(Date.now() - 5400000).toISOString(), payload: { title: 'Fix the login page on Safari', body: 'It fails on Safari.' } }] });
                    if (u.pathname === '/api/operator-asks') return json([{ board: '${team}', board_label: 'Acme web', kind: 'ask', id: 41, asker: 'Lead Developer', text: '@Operator Ship batch-120 tonight, or wait for the phone check on the new release candidate?', at: new Date(Date.now() - 7 * 60000).toISOString() }]);
                    return original(url, opts); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`['Plan 1', 'Plan 2', 'batch-120', 'Fix the login'].every(n => [...document.querySelectorAll('${T} tbody tr')].some(r => r.textContent.includes(n)))`, at + 'the three rows', 15000);
            await ev(framesJs(2));
            const long = await geo('Plan 1'), short = await geo('Plan 2'), ask = await geo('batch-120');
            const pr = await prop();
            if (mobile) {
                for (const [what, g] of [['a long title and a long sender', long], ['a short sender', short], ['a question', ask]]) {
                    check(!!g, at + what + ': the row is there');
                    if (!g) continue;
                    check(g.fromBottom <= g.nameTop + 2 && Math.abs(g.nameLeft - g.fromLeft) <= 2 && g.fromWeight >= 600, `${at}${what}: the agent's name is line one (strong) and the ask line two, under it: ${JSON.stringify(g)}`);
                    check(g.subjectsDrawn === 0, `${at}${what}: no Goal or Task link is drawn: ${JSON.stringify(g)}`);
                    check(String(g.clamp) === '2' && g.boxH <= 48 && g.nameFull, `${at}${what}: the ask is on line two, at most two lines, an ellipsis only after the second (the button holds all of it): ${JSON.stringify(g)}`);
                    check(g.waitShown && g.waitLeft >= g.nameRight - 4 && Math.abs(g.waitTop - g.nameTop) <= 10 && /waiting/.test(g.waitText), `${at}${what}: the time since is at the right of the ask's first line: ${JSON.stringify(g)}`);
                    check(!g.colShown, `${at}${what}: the Waiting column is not drawn twice`);
                    check(g.kindWords === 0, `${at}${what}: the kind's words are left to the icon: ${g.kindWords}`);
                }
                // a proposal row is not one of these rows: it is as it was on the tag (the sender before the title on one line, its own wait cell drawn, no wait copy, no grid)
                check(pr && pr.hasItem && !pr.titleFirst && pr.grid !== 'grid' && !pr.waitSpan && pr.colShown && /waiting/.test(pr.colText) && pr.fromLeft < pr.nameLeft && Math.abs(pr.fromTop - pr.nameTop) <= 6, `${at}a proposal row keeps its order and its visible wait: ` + JSON.stringify(pr));
                check(!short.fromCut, `${at}a short sender is whole: ${JSON.stringify(short)}`);
                check(!(await ev(`document.documentElement.scrollWidth > innerWidth + 1`)), at + 'no sideways scroll');
            } else {
                check(long && long.fromRight <= long.nameLeft + 4 && long.nameTop <= long.fromTop + 8 && !long.waitShown && long.kindWords >= 1, `${at}the computer's table is as it was (the sender before the name, no second wait, the kind's words): ${JSON.stringify(long)}`);
            }
            await shot(`needs-phone-row-${w}`);
        }
    } finally { await ev(`fetch('/api/board/${team}', { method: 'DELETE' }).then(r => r.status)`).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS the phone Needs you row: title, then sender with the wait; the computer table unchanged');
})().catch(e => { console.error(e); process.exit(1); });
