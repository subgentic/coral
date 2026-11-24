// The Cost page's Limit waits card (#21020, feature bets stage 1; the approved mock #21017): limit waits per agent and day on the Overview, three counts, a Team select in the page bar beside the range.
// The read is stubbed (GET /api/analytics/limit-waits, names and counts only). Pinned: the card's words as the mock has them; the request asks for the page's range as days and for the team chosen; the Team
// select is in the page bar right after the range, lists "All teams" and the teams of the answer, and keeps its choice; the card and the select belong to the Overview alone; a refused read, a failed read,
// a computer that counts nothing and an empty range each say so in a sentence; an agent's name is text; a phone does not scroll sideways and shows the rows as "label value" lines. Isolated dev server.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const BODY = () => ({
    days_asked: 7, team: '', generated_at: new Date().toISOString(), tracking: true, waiting: 0, teams: ['alpha', 'beta'],
    totals: { waits: 7, at_reset: 5, early: 2 },
    rows: [{ agent: 'Lead Developer', day: '2026-11-23', waits: 3, at_reset: 2, early: 1 }, { agent: 'QA Engineer', day: '2026-11-23', waits: 2, at_reset: 2, early: 0 }, { agent: 'Lead Developer', day: '2026-11-22', waits: 2, at_reset: 1, early: 1 }],
});

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const run = async (name, fn) => { try { await fn(); console.log('PASS ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + (e && e.message)); process.exitCode = 1; } };
    const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent.replace(/\\s+/g, ' ').trim() || ''`);
    const reqs = () => ev(`window.__lw.reqs.slice()`);
    const setRange = v => ev(`(() => { const s = document.getElementById('cost-time-range'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const setBody = (status, body) => ev(`window.__lw.status = ${status}; window.__lw.body = ${JSON.stringify(body)}; true`);
    const reload = async () => { await setRange('day'); await setRange('week'); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { window.__lw = { reqs: [], status: 200, body: ${JSON.stringify(BODY())} };
            const R = window.fetch.bind(window);
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (url.pathname === '/api/analytics/limit-waits') { window.__lw.reqs.push(url.search); const b = window.__lw.body; const answer = window.__lw.status === 200 ? { ...b, team: url.searchParams.get('team') || '' } : { error: 'no' }; return Promise.resolve(new Response(JSON.stringify(answer), { status: window.__lw.status, headers: { 'Content-Type': 'application/json' } })); }
                return R(u, o); };
            return true; })()`);
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`!!document.querySelector('#cost-limit-waits .lw-card')`, 'the Limit waits card on the Overview', 15000);

        await run('the card has the mock\'s words and the three counts', async () => {
            assert.equal(await text('#cost-limit-waits .lw-sec'), 'Limit waits');
            assert.match(await text('#cost-limit-waits'), /When an agent hits its vendor limit it waits, then resumes at the reset time or earlier\. Counted per agent and day\./);
            assert.deepEqual(await ev(`[...document.querySelectorAll('#cost-limit-waits .lw-kpi')].map(k => [k.querySelector('b').textContent, k.querySelector('span').textContent])`), [['7', 'limit waits'], ['5', 'resumed at reset'], ['2', 'resumed early']]);
            assert.match(await text('#cost-limit-waits'), /"Early" means Coral or you resumed the agent before the reset time the vendor gave\./);
        });
        await run('the table has a row per agent and day with the mock\'s days', async () => {
            const rows = await ev(`[...document.querySelectorAll('#cost-limit-waits tbody tr')].filter(r => r.getClientRects().length).map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
            assert.equal(rows.length, 3, JSON.stringify(rows));
            assert.match(rows[0], /Lead Developer.*Mon 23 Nov.*3.*2.*1/); assert.match(rows[1], /QA Engineer.*Mon 23 Nov.*2.*2.*0/); assert.match(rows[2], /Lead Developer.*Sun 22 Nov.*2.*1.*1/);
            assert.deepEqual(await ev(`[...document.querySelectorAll('#cost-limit-waits thead th')].map(h => h.textContent.replace(/[^A-Za-z ]+$/, '').trim()).filter(Boolean)`), ['Agent', 'Day', 'Waits', 'At reset', 'Early']);
        });
        await run('the request asks for the page\'s range as days: a day is today, a week is seven', async () => {
            assert.ok((await reqs()).some(r => /days=1(&|$)/.test(r)), 'a day: ' + JSON.stringify(await reqs()));
            await setRange('week');
            await waitFor(`window.__lw.reqs.some(r => /days=7/.test(r))`, 'seven days asked', 5000);
            await setRange('month');
            await waitFor(`window.__lw.reqs.some(r => /days=30/.test(r))`, 'thirty days asked', 5000);
            await setRange('week');
        });
        await run('the Team select is in the page bar right after the range, with All teams and the answer\'s teams', async () => {
            assert.equal(await ev(`document.getElementById('cost-time-range').nextElementSibling?.id`), 'cost-team', 'beside the range, before Refresh');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#cost-team option')].map(o => o.textContent)`), ['All teams', 'alpha', 'beta']);
            assert.equal(await ev(`document.getElementById('cost-team').getAttribute('aria-label')`), 'Team');
            assert.ok(await ev(`document.getElementById('cost-team').getClientRects().length > 0`), 'shown on the Overview');
        });
        await run('choosing a team asks for it and keeps the choice across a refresh of the range', async () => {
            await ev(`window.__lw.reqs.length = 0; (() => { const s = document.getElementById('cost-team'); s.value = 'beta'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`window.__lw.reqs.some(r => /team=beta/.test(r))`, 'the team asked for', 5000);
            await setRange('month');
            await waitFor(`window.__lw.reqs.some(r => /days=30.*team=beta/.test(r))`, 'the range changed with the team kept', 5000);
            assert.equal(await ev(`document.getElementById('cost-team').value`), 'beta');
            await ev(`(() => { const s = document.getElementById('cost-team'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await setRange('week');
        });
        await run('the card and the Team select belong to the Overview alone', async () => {
            await ev(`[...document.querySelectorAll('#cost-nav-list .row-btn')].find(b => /^Usage/.test(b.textContent.trim())).click(); true`);
            await waitFor(`document.getElementById('cost-dashboard-view').dataset.view === 'usage'`, 'another view', 8000);
            assert.equal(await ev(`document.getElementById('cost-team').getClientRects().length`), 0, 'the Team select is not on another view');
            assert.equal(await ev(`document.getElementById('cost-limit-waits-section').getClientRects().length`), 0, 'nor the card');
            await ev(`[...document.querySelectorAll('#cost-nav-list .row-btn')].find(b => /^Overview/.test(b.textContent.trim())).click(); true`);
            await waitFor(`document.getElementById('cost-limit-waits-section').getClientRects().length > 0`, 'back on the Overview', 8000);
        });
        await run('a refused read, a failed read, a computer that counts nothing and an empty range each say so', async () => {
            await setBody(403, BODY()); await reload();
            await waitFor(`/for the person at this computer only/.test(document.querySelector('#cost-limit-waits')?.textContent || '')`, 'the refusal said', 5000);
            await setBody(500, BODY()); await reload();
            await waitFor(`/could not be read\\. Refresh to try again/.test(document.querySelector('#cost-limit-waits')?.textContent || '')`, 'the failure said', 5000);
            await setBody(200, { ...BODY(), tracking: false, totals: { waits: 0, at_reset: 0, early: 0 }, rows: [], teams: [] }); await reload();
            await waitFor(`/not being counted on this computer/.test(document.querySelector('#cost-limit-waits')?.textContent || '')`, 'not counted said', 5000);
            assert.deepEqual(await ev(`[...document.querySelectorAll('#cost-limit-waits .lw-kpi b')].map(b => b.textContent)`), ['0', '0', '0']);
            await setBody(200, { ...BODY(), totals: { waits: 0, at_reset: 0, early: 0 }, rows: [], teams: [] }); await reload();
            await waitFor(`/No agent was stopped by a limit in this range/.test(document.querySelector('#cost-limit-waits')?.textContent || '')`, 'the empty range said', 5000);
            await setBody(200, BODY()); await reload();
            await waitFor(`document.querySelectorAll('#cost-limit-waits tbody tr').length === 3`, 'rows again', 5000);
        });
        await run('an agent\'s name is text, never markup', async () => {
            await setBody(200, { ...BODY(), rows: [{ agent: '<img src=x onerror=window.__pwn=1>', day: '2026-11-23', waits: 1, at_reset: 1, early: 0 }], totals: { waits: 1, at_reset: 1, early: 0 } }); await reload();
            await waitFor(`document.querySelectorAll('#cost-limit-waits tbody tr').length === 1`, 'the row', 5000);
            assert.equal(await ev(`!!document.querySelector('#cost-limit-waits img') || window.__pwn === 1`), false);
            assert.match(await text('#cost-limit-waits tbody'), /<img src=x onerror=window\.__pwn=1>/);
            await setBody(200, BODY()); await reload();
            await waitFor(`document.querySelectorAll('#cost-limit-waits tbody tr').length === 3`, 'rows again', 5000);
        });
        await run('a phone does not scroll sideways and shows each row as "label value" lines', async () => {
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => { window.__lw = { reqs: [], status: 200, body: ${JSON.stringify(BODY())} };
                const R = window.fetch.bind(window);
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                    if (url.pathname === '/api/analytics/limit-waits') { window.__lw.reqs.push(url.search); return Promise.resolve(new Response(JSON.stringify(window.__lw.body), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                    return R(u, o); };
                return true; })()`);
            await ev(`window.switchNavTab('tokens'); true`);
            await waitFor(`document.querySelectorAll('#cost-nav-list .row-btn').length >= 5`, 'the list of views', 10000);
            await ev(`[...document.querySelectorAll('#cost-nav-list .row-btn')].find(b => /^Overview/.test(b.textContent.trim())).click(); true`);
            await waitFor(`!!document.querySelector('#cost-limit-waits .lw-card')`, 'the card on a phone', 15000);
            assert.ok(await ev(`document.documentElement.scrollWidth <= innerWidth`), 'no sideways scroll at 390');
            assert.ok(await ev(`(() => { const c = document.querySelector('#cost-limit-waits .lw-card').getBoundingClientRect(); return c.left >= 0 && c.right <= innerWidth; })()`), 'the card sits inside the screen');
            const rows = await ev(`[...document.querySelectorAll('#cost-limit-waits tbody tr')].filter(r => r.getClientRects().length).map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
            assert.equal(rows.length, 3, JSON.stringify(rows));
            assert.match(rows[0], /Lead Developer/); assert.match(rows[0], /Mon 23 Nov/);
            const labels = await ev(`[...document.querySelector('#cost-limit-waits tbody tr').children].filter(td => !td.classList.contains('dt-tone-primary')).map(td => getComputedStyle(td, '::before').content.replace(/"/g, ''))`);
            assert.deepEqual(labels, ['Day', 'Waits', 'At reset', 'Early'], 'a folded row names its columns: ' + JSON.stringify(labels));
            assert.deepEqual(await ev(`[...document.querySelectorAll('#cost-limit-waits .lw-kpi')].map(k => k.querySelector('b').textContent)`), ['7', '5', '2']);
        });
    } finally { await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
