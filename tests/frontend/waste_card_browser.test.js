// The Cost page's Waste card (#21127, feature bets stage 2; the approved mock #21055): under the Limit waits card on the Overview, per agent the re-read share, the cache expiries and the idle compactions, with the
// line saying what each means. The read is stubbed (GET /api/analytics/waste, names and counts only). Pinned: the card's words as the mock has them; the request asks for the page's range as days and the team
// chosen, and the Team select re-reads it; a figure the vendor does not report says "Not reported", never 0; the card belongs to the Overview alone; a refused and a failed read each say so in a sentence;
// an agent's name is text; a phone does not scroll sideways and shows the rows as "label value" lines. Isolated dev server.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const BODY = () => ({
    days_asked: 7, team: '', generated_at: new Date().toISOString(),
    totals: { input_tokens: 1000, reread_tokens: 560, reread_share: 0.56, cache_expiries: 14, idle_compactions: 3 },
    rows: [
        { agent: 'Lead Developer', input_tokens: 500, reread_tokens: 355, reread_share: 0.71, cache_expiries: 8, idle_compactions: 2 },
        { agent: 'QA Engineer', input_tokens: 300, reread_tokens: 144, reread_share: 0.48, cache_expiries: 4, idle_compactions: 1 },
        { agent: 'Codex Helper', input_tokens: 200, reread_tokens: 44, reread_share: 0.22, cache_expiries: null, idle_compactions: null },
        { agent: '<img src=x onerror=window.__pwned=1>', input_tokens: 10, reread_tokens: 0, reread_share: 0, cache_expiries: 0, idle_compactions: 0 },
    ],
});

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const run = async (name, fn) => { try { await fn(); console.log('PASS ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + (e && e.message)); process.exitCode = 1; } };
    const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent.replace(/\\s+/g, ' ').trim() || ''`);
    const reqs = () => ev(`window.__wa.reqs.slice()`);
    const setRange = v => ev(`(() => { const s = document.getElementById('cost-time-range'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const setBody = (status, body) => ev(`window.__wa.status = ${status}; window.__wa.body = ${JSON.stringify(body)}; true`);
    const reload = async () => { await setRange('day'); await setRange('week'); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { window.__wa = { reqs: [], status: 200, body: ${JSON.stringify(BODY())} };
            const R = window.fetch.bind(window);
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (url.pathname === '/api/analytics/waste') { window.__wa.reqs.push(url.search); const answer = window.__wa.status === 200 ? window.__wa.body : { error: 'no' }; return Promise.resolve(new Response(JSON.stringify(answer), { status: window.__wa.status, headers: { 'Content-Type': 'application/json' } })); }
                return R(u, o); };
            return true; })()`);
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`!!document.querySelector('#cost-waste .lw-card')`, 'the Waste card on the Overview', 15000);

        await run('the card has the mock\'s words and the three figures', async () => {
            assert.equal(await text('#cost-waste .lw-sec'), 'Waste');
            assert.match(await text('#cost-waste'), /Input an agent paid for again without learning anything new\. Counted per agent from the transcripts Coral already reads\./);
            assert.deepEqual(await ev(`[...document.querySelectorAll('#cost-waste .lw-kpi')].map(k => [k.querySelector('b').textContent, k.querySelector('span').textContent])`), [['56%', 're-read'], ['14', 'cache expiries'], ['3', 'idle compactions']]);
            assert.match(await text('#cost-waste'), /Re-read: share of input tokens that were the earlier conversation read again\. Cache expiry: the agent sat idle past the cache time, so the next turn paid full price\. Idle compaction: the conversation was summarised while the agent was idle\./);
        });
        await run('it sits under the Limit waits card, and the rows are per agent with the mock\'s columns', async () => {
            assert.ok(await ev(`(() => { const a = document.getElementById('cost-limit-waits-section'), b = document.getElementById('cost-waste-section'); return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); })()`), 'the Waste section follows the Limit waits section');
            assert.equal(await ev(`document.querySelectorAll('#cost-waste thead [aria-sort], #cost-waste .dt-sort, #cost-waste select').length`), 0, 'no sort controls: the mock has none and the rows come in the order of the most re-read first');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#cost-waste thead th')].map(t => t.textContent.replace(/[\\u2195\\u2191\\u2193]/g, '').trim())`), ['Agent', 'Re-read', 'Cache expiries', 'Idle compactions']);
            const rows = await ev(`[...document.querySelectorAll('#cost-waste tbody tr')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
            assert.match(rows[0], /Lead Developer\s*71%\s*8\s*2/); assert.match(rows[1], /QA Engineer\s*48%\s*4\s*1/);
        });
        await run('a figure the vendor does not report says Not reported, never 0; an agent\'s name is text', async () => {
            const rows = await ev(`[...document.querySelectorAll('#cost-waste tbody tr')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
            assert.match(rows[2], /Codex Helper\s*22%\s*Not reported\s*Not reported/, JSON.stringify(rows));
            assert.equal(await ev(`!!window.__pwned || !!document.querySelector('#cost-waste img')`), false);
            await setBody(200, { ...BODY(), totals: { reread_share: 0.1, cache_expiries: null, idle_compactions: null } });
            await reload();
            await waitFor(`/Not reported/.test(document.querySelector('#cost-waste .lw-kpis')?.textContent || '')`, 'the totals say Not reported', 6000);
            assert.deepEqual(await ev(`[...document.querySelectorAll('#cost-waste .lw-kpi b')].map(b => b.textContent)`), ['10%', 'Not reported', 'Not reported']);
            await setBody(200, BODY()); await reload();
        });
        await run('the request asks for the page\'s range as days and the team chosen; the Team select re-reads it', async () => {
            await setRange('month'); await waitFor(`window.__wa.reqs.some(q => q.includes('days=30'))`, 'a read for 30 days', 6000);
            await setRange('week');
            await ev(`(() => { const s = document.getElementById('cost-team'); s.append(Object.assign(document.createElement('option'), { value: 'alpha', textContent: 'alpha' })); s.value = 'alpha'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`window.__wa.reqs.some(q => q.includes('team=alpha'))`, 'a read for the team', 6000);
            assert.ok((await reqs()).some(q => /days=7/.test(q) && /team=alpha/.test(q)), JSON.stringify(await reqs()));
            await ev(`(() => { const s = document.getElementById('cost-team'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        });
        await run('the card belongs to the Overview alone', async () => {
            await ev(`window.switchNavTab('tokens'); true`);
            assert.ok(await ev(`document.getElementById('cost-waste-section').getClientRects().length > 0`), 'shown on the Overview');
            assert.equal(await ev(`document.getElementById('cost-waste-section').dataset.cview`), 'overview');
        });
        await run('a refused read and a failed read each say so in a sentence', async () => {
            await setBody(403, {}); await reload();
            await waitFor(`/for the person at this computer only/.test(document.getElementById('cost-waste')?.textContent || '')`, 'the refusal sentence', 6000);
            await setBody(500, {}); await reload();
            await waitFor(`/could not be read/.test(document.getElementById('cost-waste')?.textContent || '')`, 'the failure sentence', 6000);
            await setBody(200, BODY()); await reload();
            await waitFor(`!!document.querySelector('#cost-waste .lw-card')`, 'the card again', 6000);
        });
        await run('a phone does not scroll sideways and shows each row as "label value" lines', async () => {
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
            await ev(`window.switchNavTab('tokens'); true`);
            await ev(`(() => { const b = [...document.querySelectorAll('.sidebar-pane[data-pane="tokens"] li .row-btn')].find(x => x.textContent.trim() === 'Overview'); if (b) b.click(); return true; })()`);
            await waitFor(`document.getElementById('cost-page').getClientRects().length > 0`, 'the Overview as a phone screen', 8000);
            await reload();
            await waitFor(`!!document.querySelector('#cost-waste .lw-card')`, 'the card on a phone', 15000);
            assert.ok(await ev(`document.getElementById('cost-waste-section').getClientRects().length > 0`), 'the card is on screen, not only in the page');
            assert.ok(await ev(`document.documentElement.scrollWidth <= innerWidth`), 'no sideways scroll at 390');
            assert.ok(await ev(`(() => { const c = document.querySelector('#cost-waste .lw-card').getBoundingClientRect(); return c.left >= 0 && c.right <= innerWidth; })()`), 'the card sits inside the screen');
            const labels = await ev(`[...document.querySelector('#cost-waste tbody tr').children].filter(td => !td.classList.contains('dt-tone-primary')).map(td => getComputedStyle(td, '::before').content.replace(/"/g, ''))`);
            assert.deepEqual(labels, ['Re-read', 'Cache expiries', 'Idle compactions'], JSON.stringify(labels));
            // four rows an agent, the label at the left edge and the value at the right edge (the mock), the first row "Agent | name"
            const rows = await ev(`(() => { const tr = document.querySelector('#cost-waste tbody tr'), box = tr.getBoundingClientRect(); return [...tr.children].map(td => { const r = td.getBoundingClientRect(); const tr2 = document.createRange(); tr2.selectNodeContents(td); const v = tr2.getBoundingClientRect(); return { label: getComputedStyle(td, '::before').content.replace(/"/g, ''), gapRight: Math.round(r.right - v.right), gapLeft: Math.round(v.left - r.left) }; }); })()`);
            assert.equal(rows.length, 4, JSON.stringify(rows));
            assert.equal(rows[0].label, 'Agent', JSON.stringify(rows));
            for (const r of rows) assert.ok(r.gapRight <= 2 && r.gapLeft > 40, 'the value is at the right edge: ' + JSON.stringify(rows));
        });
    } finally { await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
