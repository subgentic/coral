// #20938 approved comparison, re-pointed at the Needs you list (article.nl-row, #22094, the approved ledger): the title (.nl-title; a file's .nl-file-open) is line one, strong, wrapped whole; the sender is muted under it on the meta
// line (.nl-meta: a question's asker, a proposal's proposer is the title itself with the proposal a plain line .nl-other-text under it) or, for a file, the avatar at the right named with the whole sender; the time since
// (time.nl-when, "… ago") is at the right, drawn once; the kind is the row's labelled icon (File for review, Question), not words; no Goal or Task link is drawn in a row (the goal is the group). A long title and a long
// sender at 320, 390 and 430, no sideways scroll; at 1280 the same order (title, then the sender under it). The artifacts, the proposal and the question are stubbed. Isolated dev server.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], T = '#group-table-view .needs-ledger', team = 'npr-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const geo = needle => ev(`(() => { const tr = [...document.querySelectorAll('${T} .nl-row')].find(r => r.textContent.includes(${JSON.stringify(needle)})); if (!tr) return null; const vis = e => !!e && e.getClientRects().length > 0 && e.getBoundingClientRect().width > 1, r = e => e.getBoundingClientRect();
        const file = tr.classList.contains('nl-file'), title = tr.querySelector('.nl-title'), name = file ? title.querySelector('.nl-file-open') : title, own = file ? [...name.childNodes].find(n => n.nodeType === 3) : name, meta = file ? null : tr.querySelector('.nl-body > .nl-meta'), who = file ? tr.querySelector('.nl-side .goal-decision-agent-icon') : meta && meta.querySelector('.agent-link, a, button, span'), waits = [...tr.querySelectorAll('.nl-when')].filter(vis), wait = waits[0], icon = tr.querySelector(':scope > .nl-icon');
        const text = document.createRange(); text.selectNodeContents(own); const tr_ = text.getBoundingClientRect(), lh = parseFloat(getComputedStyle(title).lineHeight) || 20, row = r(tr);
        const links = [...tr.querySelectorAll('a[href]')].filter(a => vis(a) && /goals|tasks/.test(a.getAttribute('href'))).length;
        return { file, nameTop: Math.round(tr_.top), nameBottom: Math.round(tr_.bottom), nameLeft: Math.round(r(title).left), nameRight: Math.round(r(title).right), nameWeight: Number(getComputedStyle(title).fontWeight), nameColor: getComputedStyle(title).color, nameCut: title.scrollHeight > title.clientHeight + 1 || title.scrollWidth > title.clientWidth + 1, clamp: getComputedStyle(title).webkitLineClamp, nameLines: Math.round(tr_.height / lh), nameFull: own.textContent.trim().length > 0,
            fromText: file ? (who && (who.getAttribute('aria-label') || who.title)) : meta && meta.textContent, fromShown: vis(who), fromTop: meta ? Math.round(r(meta).top) : null, fromLeft: meta ? Math.round(r(meta).left) : null, fromWeight: meta ? Number(getComputedStyle(meta).fontWeight) : null, fromColor: meta ? getComputedStyle(meta).color : null, fromCut: meta ? meta.scrollWidth > meta.clientWidth + 1 : false,
            links, waitCount: waits.length, waitShown: vis(wait), waitLeft: wait ? Math.round(r(wait).left) : 0, waitTop: wait ? Math.round(r(wait).top) : 0, waitBottom: wait ? Math.round(r(wait).bottom) : 0, sideTop: Math.round(r(tr.querySelector('.nl-side')).top), lh: Math.round(lh), rowTop: Math.round(row.top), rowBottom: Math.round(row.bottom), waitText: wait ? wait.textContent.trim() : '', kind: icon && icon.getAttribute('aria-label'), kindWords: [...tr.querySelectorAll('*')].filter(e => !e.children.length && /^(For review|Needs your answer)$/.test(e.textContent.trim()) && vis(e)).length, nameText: own.textContent.trim().slice(0, 30) }; })()`);
    const prop = () => ev(`(() => { const tr = [...document.querySelectorAll('${T} .nl-row')].find(r => r.textContent.includes('Fix the login')); if (!tr) return null; const vis = e => !!e && e.getClientRects().length > 0 && e.getBoundingClientRect().width > 1, r = e => e.getBoundingClientRect();
        const title = tr.querySelector('.nl-title'), line = tr.querySelector('.nl-other-text'), waits = [...tr.querySelectorAll('.nl-when')].filter(vis);
        return { title: title && title.textContent, line: line && line.textContent, titleLeft: Math.round(r(title).left), lineLeft: line ? Math.round(r(line).left) : null, titleBottom: Math.round(r(title).bottom), lineTop: line ? Math.round(r(line).top) : null, waits: waits.length, waitLeft: waits[0] ? Math.round(r(waits[0]).left) : 0, titleRight: Math.round(r(title).right) }; })()`);
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
                window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, items) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin), m = u.pathname.match(/^\\/api\\/board\\/([^/]+)\\/artifacts$/);
                    if (m && items[m[1]]) return json({ project: m[1], artifacts: !u.searchParams.has('tag') || u.searchParams.get('tag') === 'for review' ? items[m[1]] : [], has_more: false });
                    if (u.pathname === '/api/proposals') return json({ proposals: [{ id: 11, board_id: '${team}', kind: 'task', title: 'Fix the login page on Safari', proposer: 'Backend Dev of the platform team', state: 'pending', created_at: new Date(Date.now() - 5400000).toISOString(), payload: { title: 'Fix the login page on Safari', body: 'It fails on Safari.' } }] });
                    if (u.pathname === '/api/operator-asks') return json([{ board: '${team}', board_label: 'Acme web', kind: 'ask', id: 41, asker: 'Lead Developer', text: '@Operator Ship batch-120 tonight, or wait for the phone check on the new release candidate?', at: new Date(Date.now() - 7 * 60000).toISOString() }]);
                    return original(url, opts); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`['Plan 1', 'Plan 2', 'batch-120', 'Fix the login'].every(n => [...document.querySelectorAll('${T} .nl-row')].some(r => r.textContent.includes(n)))`, at + 'the four rows', 15000);
            await ev(`document.querySelectorAll('${T} .nl-group-toggle[aria-expanded=false]').forEach(b => b.click()); true`); await ev(framesJs(2)); // a goal group starts folded unless it holds a question
            const long = await geo('Plan 1'), short = await geo('Plan 2'), ask = await geo('batch-120');
            const pr = await prop();
            if (mobile) {
                for (const [what, g, sender] of [['a long title and a long sender', long, 'Lead Developer of the platform team with a very long title'], ['a short sender', short, 'DevOps Engineer'], ['a question', ask, 'Lead Developer']]) {
                    check(!!g, at + what + ': the row is there');
                    if (!g) continue;
                    check(g.nameWeight >= 600 && (g.file ? g.fromShown && g.fromText === sender : g.fromTop >= g.nameBottom - 2 && Math.abs(g.nameLeft - g.fromLeft) <= 2 && g.fromWeight <= 500 && g.fromColor !== g.nameColor && g.fromText.includes(sender)), `${at}${what}: the stronger title is line one and the sender is muted under it, or for a file the avatar named with the whole sender (#20938, #22094): ${JSON.stringify(g)}`);
                    check(g.links === 0, `${at}${what}: no Goal or Task link is drawn: ${JSON.stringify(g)}`);
                    check((String(g.clamp) === 'none' || String(g.clamp) === '') && g.nameFull && !g.nameCut, `${at}${what}: ${what === 'a question' ? 'a question to the Operator is said whole, wrapped, not clamped (#14574)' : 'the title wraps whole, without clipping or a line clamp (#20938 Titles first)'}: ${JSON.stringify(g)}`);
                    check(g.waitShown && g.waitLeft >= g.nameRight - 1 && (g.file ? g.waitTop >= g.rowTop && g.waitBottom <= g.rowBottom : Math.abs(g.sideTop - g.nameTop) <= 8 && g.waitTop < g.nameTop + 2 * g.lh) && /ago$/.test(g.waitText), `${at}${what}: the time since is at the right${g.file ? '' : ', its column (New, then the time) from line one'} (Layout A, #13911): ${JSON.stringify(g)}`);
                    check(g.waitCount === 1, `${at}${what}: the time since is not drawn twice: ${g.waitCount}`);
                    check(g.kind === (what === 'a question' ? 'Question' : 'File for review') && g.kindWords === 0, `${at}${what}: the row names its kind with its labelled icon (#20203, #22094): ${JSON.stringify(g)}`);
                }
                // a proposal row follows the same pattern (#13911, the Operator: "this one is not following the pattern")
                check(pr && pr.title === 'Backend Dev of the platform team' && /Fix the login page on Safari/.test(pr.line || '') && Math.abs(pr.titleLeft - pr.lineLeft) <= 2 && pr.lineTop >= pr.titleBottom - 1 && pr.waits === 1 && pr.waitLeft >= pr.titleRight - 1, `${at}a proposal row follows the pattern too (#13911): the proposer's name is line one, the proposal a line under it, the time since at the right, once: ` + JSON.stringify(pr));
                check(!short.fromCut && !ask.fromCut, `${at}a short sender is whole: ${JSON.stringify([short, ask])}`);
                check(!(await ev(`document.documentElement.scrollWidth > innerWidth + 1`)), at + 'no sideways scroll');
            } else {
                check(ask && ask.fromTop >= ask.nameBottom - 2 && ask.waitCount === 1 && ask.kind === 'Question' && long && long.fromShown && long.waitCount === 1 && long.kind === 'File for review', `${at}the computer's list: the title first, the sender on the meta line under it (#16678) or a file's named avatar, one wait, the kind's icon: ${JSON.stringify([ask, long])}`);
            }
            await shot(`needs-phone-row-${w}`);
        }
    } finally { await ev(`fetch('/api/board/${team}', { method: 'DELETE' }).then(r => r.status)`).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS the phone Needs you row: title, then sender with the wait; the computer table unchanged');
})().catch(e => { console.error(e); process.exit(1); });
