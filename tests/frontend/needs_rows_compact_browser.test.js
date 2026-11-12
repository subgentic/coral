// Needs you rows on a computer, compact (#15722, the Operator's annotated screenshot and the layouts picked from #15723's mockups): the select box, the kind icon and the sender on the first line with the team and
// how long it has waited at the right; a question's whole text on its own line under the sender; every action a labelled button (Comment, Save, More, Star: no bare icons) on the bottom line, at the right, the star
// among them. A phone's rows are not touched (icons stay). 1440 and 960 wide, light and dark, and a phone at 390. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'hover-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));` });
        for (const [w, h, mobile] of [[1440, 1000, false], [960, 1000, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = (i, tags) => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags, produced_by: 'Plan Writer', review_question: 'Ship plan ' + i + '?' });
                const items = [item(1, ['for review']), item(2, ['for review', 'read']), item(3, ['for review'])];
                window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': items}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                    if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    return original(url, opts); };
                return true; })()`);
            await ev(`(() => { const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify([{ board: '${team}', kind: 'ask', id: 71, asker: 'Lead', text: 'Which port should the test server use for the integration run, and should it be the same one the dashboard is on? Say which, and why.', at: new Date(Date.now() - 300000).toISOString() }]), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 3 && !!document.querySelector('${T} tbody tr .inbox-answers, ${T} tbody tr [data-on-click*="ask"], ${T} tbody tr button')`, at + 'the review rows and the question', 15000);
            await ev(framesJs(4));
            await ev(`(() => { const st = document.createElement('style'); st.textContent = '*, *::before, *::after { transition: none !important; }'; document.head.append(st); return true; })()`);
            const geo = () => ev(`(() => { const R = e => e && e.getClientRects().length ? e.getBoundingClientRect() : null, cy = r => r ? r.top + r.height / 2 : null;
                return { over: document.documentElement.scrollWidth > innerWidth + 1, rows: [...document.querySelectorAll('${T} tbody tr:not(.dt-group)')].map(tr => { const rb = tr.getBoundingClientRect(), box = tr.querySelector('.inbox-review-actions'), btns = box ? [...box.querySelectorAll('button')].filter(b => b.getClientRects().length) : [],
                    q = tr.querySelector('.inbox-ask-name'), icon = R(tr.querySelector('.inbox-kind-icon')), check = R(tr.querySelector('.dt-check input')), from = R(tr.querySelector('.inbox-review-from')), team = R(tr.querySelector('td[data-key="team"] *') || tr.querySelector('td[data-key="team"]')), wait = R(tr.querySelector('td[data-key="waiting"] *') || tr.querySelector('td[data-key="waiting"]')), last = btns.length ? btns[btns.length - 1].getBoundingClientRect() : null;
                    return { h: Math.round(rb.height), ask: !!q, words: btns.map(b => b.textContent.trim()), labels: btns.map(b => b.getAttribute('aria-label') || ''), top: btns.length ? Math.round(Math.min(...btns.map(b => b.getBoundingClientRect().top)) - rb.top) : null, iconBottom: icon ? Math.round(icon.bottom - rb.top) : null,
                        line: [cy(icon), cy(check), cy(from), cy(team), cy(wait)].filter(v => v != null).map(v => Math.round(v - rb.top)), teamRight: team ? Math.round(rb.right - team.right) : null, waitRight: wait ? Math.round(rb.right - wait.right) : null, btnRight: last ? Math.round(rb.right - last.right) : null,
                        qCut: q ? q.scrollWidth > q.clientWidth + 1 || q.scrollHeight > q.clientHeight + 1 || getComputedStyle(q).textOverflow === 'ellipsis' : null, qLines: q ? Math.round(q.getBoundingClientRect().height / parseFloat(getComputedStyle(q).lineHeight || 20)) : null, qTop: q ? Math.round(q.getBoundingClientRect().top - (from ? from.bottom : 0)) : null, star: (() => { const s = tr.querySelector('.inbox-review-star'); return s ? { word: s.textContent.trim(), pressed: s.getAttribute('aria-pressed'), inBar: !!s.closest('.inbox-review-actions') } : null; })() }; }) }; })()`);
            for (const theme of ['light', 'dark']) {
                await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); true`); await ev(framesJs(3));
                const g = await geo(), a = at + theme + ': ';
                check(g.rows.length === 4 && !g.over, a + 'four rows, and the page does not scroll sideways: ' + JSON.stringify({ n: g.rows.length, over: g.over }));
                for (const r of g.rows) {
                    const files = !r.ask, what = (files ? 'file row' : 'question row') + ' ' + JSON.stringify(r);
                    if (!mobile) {
                        check(r.words.length >= 2 && r.words.every(x => x.length > 0), a + 'every button has a word, no bare icons: ' + what);
                        check(r.top != null && r.iconBottom != null && r.top >= r.iconBottom, a + 'the buttons are on the bottom line, under the icon: ' + what);
                        check(r.btnRight != null && r.btnRight <= 24, a + 'the buttons end at the right of the row: ' + what);
                        check(Math.max(...r.line) - Math.min(...r.line) <= 6, a + 'the select box, icon, sender, team and waiting share the first line: ' + what);
                        check(r.teamRight != null && r.waitRight != null && r.waitRight <= 24 && r.teamRight > r.waitRight, a + 'the team and the wait are at the top right, the wait last: ' + what);
                        check(r.h <= (files ? 120 : 150), a + 'the row is short (' + r.h + ' px): ' + what);
                        if (files) check(r.words.join(',') === 'Approve,Comment,Save,More,Star' && r.labels.join('|') === 'Approve: ' + 'plan-X.md|Comment: plan-X.md|Save for later: plan-X.md|More actions for plan-X.md|Star plan-X.md'.replace(/X/g, (r.labels[0].match(/plan-(\d)/) || [0, 0])[1]), a + 'a file row has Approve, Comment, Save, More and Star as words, with their names kept: ' + what);
                        if (files) check(r.star && r.star.inBar && r.star.word === 'Star' && r.star.pressed === 'false', a + 'the star is a labelled toggle in the bottom bar: ' + what);
                        if (!files) check(r.qCut === false && r.qLines >= 1 && r.qTop >= 0, a + 'the question is whole, under the sender: ' + what);
                    } else if (files) check(!r.words.some(x => /^(Comment|Save|More|Star)$/.test(x)), a + 'a phone keeps its icons: ' + what);
                }
                await shot((mobile ? 'phone-' : 'computer-') + w + '-' + theme);
            }
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    assert.equal(failures.length, 0, [...new Set(failures)].join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
