// A Needs you row in three lines (#11719, the operator's Gmail comment; the mockup needs_row_three_lines): the top line is who it is from and the file's name with, at the row's right, how long it has waited; under it the
// summary of why it needs review, the question, cut at two lines with an ellipsis ("For review" when the file came with none); the team, the goal and the task link are not on the row. 1440 (a mouse) and 390. Review rows
// (a long question, a short one, none) stubbed in the page. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'three-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    const LONG = 'Is the rollout order right? I put the database migration before the API change; say if it should go the other way, or if they can ship together, and whether the feature flag stays off until Friday.';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));` });
        for (const [w, h, mobile] of [[1440, 800, false], [390, 800, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = (i, q) => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review'], produced_by: 'Plan Writer', ...(q ? { review_question: q } : {}) });
                const items = [item(1, ${JSON.stringify(LONG)}), item(2, 'Ship it?'), item(3, '')];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                    if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    return original(url, opts); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 3`, at + 'three review rows', 15000);
            await ev(framesJs(4));
            if (!mobile) await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 5, y: 5 });
            await shot(`needs-three-lines-${w}`);
            const m = await ev(`(() => { const rows = [...document.querySelectorAll('${T} tbody tr')], info = n => { const tr = rows.find(r => r.textContent.includes('plan-' + n + '.md')), q = s => tr.querySelector(s), r = tr.getBoundingClientRect(), from = q('.inbox-review-from'), name = q('.inbox-review-name'), sub = q('.dt-subtitle'), when = [...tr.querySelectorAll('.inbox-row-when, td')].find(e => /waiting/.test(e.textContent) && !e.querySelector('table')),
                    cs = sub ? getComputedStyle(sub) : null, lh = sub ? parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3 : 0, wr = when ? (when.querySelector && when.querySelector('.inbox-row-when') || when).getBoundingClientRect() : null;
                    return { from: from ? from.textContent.trim() : null, fromTop: from ? Math.round(from.getBoundingClientRect().top + from.getBoundingClientRect().height / 2 - r.top) : null, nameTop: name ? Math.round(name.getBoundingClientRect().top + name.getBoundingClientRect().height / 2 - r.top) : null, sub: sub ? sub.textContent.trim().slice(0, 40) : null, subH: sub ? Math.round(sub.getBoundingClientRect().height) : 0, lh: Math.round(lh), clamp: cs ? (cs.webkitLineClamp || cs.lineClamp) : null, subTop: sub ? Math.round(sub.getBoundingClientRect().top - r.top) : null,
                        whenTop: wr ? Math.round(wr.top - r.top) : null, whenRightGap: wr ? Math.round(r.right - wr.right) : null, text: tr.textContent.replace(/\\s+/g, ' '), h: Math.round(r.height) }; };
                return { long: info(1), short: info(2), none: info(3) }; })()`);
            check(m.long.from === 'Plan Writer' && Math.abs(m.long.fromTop - m.long.nameTop) <= 6, at + `the top line is who it is from, then the file's name, on one line: ${JSON.stringify([m.long.from, m.long.fromTop, m.long.nameTop])}`);
            if (w <= 480) check(m.long.whenTop !== null && m.long.whenTop > m.long.nameTop, at + `how long it has waited is under the file's name on a narrow phone (the Operator's decision on #13144: the name gets the line beside the sender): ${JSON.stringify([m.long.whenTop, m.long.nameTop])}`);
            else check(m.long.whenTop !== null && m.long.whenTop <= m.long.subTop && m.long.whenRightGap <= 24, at + `how long it has waited is at the top right of the row: ${JSON.stringify([m.long.whenTop, m.long.subTop, m.long.whenRightGap])}`);
            check(m.long.sub && m.long.sub.startsWith('Is the rollout order right') && String(m.long.clamp) === '2' && m.long.subH <= m.long.lh * 2 + 4 && m.long.subH > m.long.lh * 1.5, at + `the long question is cut at two lines: ${JSON.stringify([m.long.sub, m.long.clamp, m.long.subH, m.long.lh])}`);
            check(m.short.sub === 'Ship it?' && m.none.sub === 'For review', at + `a short question shows whole and a file with none says "For review": ${JSON.stringify([m.short.sub, m.none.sub])}`);
            check(!new RegExp(team).test(m.long.text) && !/No goal/.test(m.long.text), at + 'the team and the goal are not on the row: ' + m.long.text.slice(0, 200));
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await ev(`localStorage.removeItem('coral-inbox-needs-filters'); true`).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_three_lines_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
