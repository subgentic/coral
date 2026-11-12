// One page header for every list page (design guidelines 4.2, #15814), proved on Jobs: row 1 is the title (20 px) with its grey count, then More and the one blue button (New job) at the far right; row 2 is the search, the filter
// strip and the filter icon. "Copy for an agent" is an item of More (the robot has no row of its own). At 1440 px the header does not wrap, at 390 px row 2 goes under row 1, and nothing is cut at 200% text; dark and light.
// A stubbed server. Measured only after the header is laid out, all boxes read in one call.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, what) => { if (!ok) problems.push(what); };
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => {
            const real = window.fetch; const ago = h => new Date(Date.now() - h * 3600000).toISOString();
            const base = { description: '', timezone: 'UTC', agent_type: 'claude', repo_path: '/work/p', base_branch: 'main', prompt: 'Do it.', enabled: 1, max_duration_s: 3600, cleanup_worktree: 0, flags: '', cron_expr: '0 * * * *' };
            const jobs = [{ ...base, id: 1, name: 'nightly-build', last_run: { id: 11, status: 'completed', started_at: ago(2), finished_at: ago(2) } }, { ...base, id: 2, name: 'weekly-cleanup', enabled: 0 }];
            const json = o => Promise.resolve(new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u && u.url ? u.url : u);
                if (/\\/api\\/scheduled\\/jobs$/.test(url)) return json({ jobs });
                if (/\\/api\\/workflows$/.test(url)) return json({ workflows: [] });
                if (/\\/api\\/scheduled\\/jobs\\/\\d+\\/runs/.test(url)) return json({ runs: [], total: 0 });
                return real(u, o); };
            return true; })()`);
        await ev(`window.switchNavTab('automations'); import(${S} + 'scheduler.js').then(m => m.refreshJobs()).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length >= 2 && !!document.querySelector('#group-table-view .page-header .page-header-actions .team-tb-action')`, 'the Jobs page with its header', 12000);
        const measure = () => ev(`(() => { const r = e => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), h: Math.round(b.height), cy: Math.round((b.top + b.bottom) / 2) }; };
            const row = document.querySelector('#group-table-view .page-header'), q = s => row.querySelector(s), view = document.getElementById('group-table-view');
            const probe = document.createElement('i'); probe.style.fontSize = 'var(--fs-2xl)'; document.body.append(probe); const title20 = getComputedStyle(probe).fontSize; probe.remove();
            const h2 = q('#group-table-title'), cnt = q('.session-group-count'), more = q('.page-header-more > button'), prim = q('.page-header-actions .team-tb-action'), search = q('.list-bar-search-wrap'), pills = q('.team-tb-pills'), filt = q('.list-bar-toggle, .list-bar-more');
            return { h2: h2 && r(h2), h2font: h2 && getComputedStyle(h2).fontSize, title20, cnt: cnt && r(cnt), cntColor: cnt && getComputedStyle(cnt).color, textColor: getComputedStyle(h2).color, more: more && r(more), moreText: more && more.textContent.trim(), prim: prim && r(prim), primText: prim && prim.textContent.trim(), primary: row.querySelectorAll('.btn-primary').length,
                search: search && r(search), pills: pills && r(pills), filt: filt && r(filt), robot: document.querySelectorAll('#group-table-view .agent-copy').length, row: r(row), viewScroll: view.scrollWidth, viewClient: view.clientWidth, fs: parseFloat(getComputedStyle(document.documentElement).fontSize),
                outside: [...row.querySelectorAll('.inbox-folder-head, .page-header-actions, .list-bar-search-wrap, .team-tb-pills, .list-bar-toggle, .list-bar-more')].filter(e => e.getClientRects().length && (e.getBoundingClientRect().right > innerWidth + 1 || e.getBoundingClientRect().left < -1)).map(e => e.className) }; })()`);
        const modes = [['1440 px dark', 1440, 900, false, 'dark', ''], ['1440 px light', 1440, 900, false, 'light', ''], ['390 px dark', 390, 844, true, 'dark', ''], ['390 px light', 390, 844, true, 'light', ''], ['1440 px 200% text', 1440, 900, false, 'dark', '200%'], ['390 px 200% text', 390, 844, true, 'dark', '200%']];
        for (const [label, w, h, mobile, theme, zoom] of modes) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
            await waitFor(`(() => { const r = document.querySelector('#group-table-view .page-header'); return !!r && r.getClientRects().length > 0 && !!r.querySelector('.list-bar-search-wrap')?.getClientRects().length; })()`, `${label}: the header is laid out`, 6000);
            const m = await measure();
            const at = label + ': ';
            check(m.moreText === 'More' && m.primText === 'New job', `${at}the header has More and the Primary (${m.moreText}, ${m.primText})`);
            check(m.primary === 1, `${at}one blue button in the header (${m.primary})`);
            check(m.robot === 0, `${at}no robot of its own`);
            check(m.h2font === m.title20, `${at}the title is the page-title size (${m.h2font} vs ${m.title20})`);
            check(m.cnt && m.cntColor !== m.textColor, `${at}the count is grey, not the title's colour`);
            const phone = w < 768; // the phone's title is in its top bar and its create button is the floating New (phone_bar.js, phone_fab.js): row 1 is More alone, row 2 under it
            if (!phone) {
                check(Math.abs(m.h2.cy - m.more.cy) <= 4 && Math.abs(m.more.cy - m.prim.cy) <= 4 && m.h2.r <= m.more.l && m.more.r <= m.prim.l, `${at}row 1 reads Title count, then More, then the Primary, on one line: ${JSON.stringify([m.h2, m.more, m.prim])}`);
                check(m.prim.r >= m.row.r - 2, `${at}the Primary is at the far right (${m.prim.r} of ${m.row.r})`);
                check(m.search.t >= m.h2.b - 1 && m.search.t >= m.prim.b - 1, `${at}row 2 (search) is under row 1: ${JSON.stringify([m.h2, m.prim, m.search])}`);
                const strip = m.pills.r > m.pills.l; // where the width does not hold the strip (200% text) it is a select in the filter panel, as before (#8700)
                check((!strip || (m.pills.t < m.search.b && m.pills.l >= m.search.r - 1)) && m.filt.l >= (strip ? m.pills.r : m.search.r) - 1 && m.filt.t < m.search.b, `${at}the filter strip, then the filter icon, follow the search on row 2: ${JSON.stringify([m.search, m.pills, m.filt])}`);
            } else {
                check(m.more.r >= m.row.r - 2 && m.search.t >= m.more.b - 1, `${at}row 1 is More at the right and row 2 (search) goes under it: ${JSON.stringify([m.more, m.search, m.row])}`);
            }
            check(m.outside.length === 0 && m.viewScroll <= m.viewClient + 1, `${at}nothing is cut or wider than the page (${JSON.stringify(m.outside)}, ${m.viewScroll} of ${m.viewClient})`);
            if (!zoom && w === 1440) check(m.h2.h < 40, `${at}the title does not wrap (${m.h2.h})`);
            if (['1440 px dark', '390 px light', '390 px 200% text', '1440 px 200% text'].includes(label)) await shot('page-header-' + label.replace(/ /g, '-'));
        }
        await ev(`document.documentElement.style.fontSize = ''; document.documentElement.setAttribute('data-theme', 'dark'); true`);
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await ev(`document.querySelector('#group-table-view .page-header-more > button').click(); true`);
        await waitFor(`!!document.querySelector('.page-header-more-menu') && !document.querySelector('.page-header-more-menu').hidden`, 'More opens', 4000);
        const items = await ev(`[...document.querySelectorAll('.page-header-more-menu [role="menuitem"]')].map(b => b.textContent.trim())`);
        check(items.length === 1 && items[0] === 'Copy for an agent', 'More holds "Copy for an agent" (words, not a robot): ' + JSON.stringify(items));
        await shot('page-header-more-open');
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'The page header:\n  ' + problems.join('\n  '));
    console.log('PASS the page header: title and count, More and the Primary, then the search row');
})().catch(e => { console.error(e); process.exit(1); });
