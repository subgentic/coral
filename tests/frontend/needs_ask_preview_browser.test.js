// A question's rows in Needs you are plain-text previews, so the Markdown the asker wrote is shown as its words (#12152): "**nothing**" reads "nothing", a list item loses its dash, a link is its text, code its text. The
// name on the top line and the second line under it, at 1280 and 390 px; the dialog still renders the Markdown (ask_item_browser). The route is stubbed (as in operator_asks_browser).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const OPERATOR_TEXT = '@Operator TEST ITEM, safe to answer any way: this is a test request so you can reproduce the disappearing-inbox issue.\n\nAnswering or approving it **changes nothing** on the team. Please note what else, if anything, disappears from your Inbox when you answer it:\n\n- the row in Needs you\n- the badge\n\nDetails: [the board](https://example.com/board).';
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            const at = `${w}: `;
            // the server's list, and the posts the page makes
            await ev(`(() => { window.__asks = [{ board: 'coral-hub', board_label: 'coral-hub', kind: 'ask', id: 41, asker: 'Orchestrator', text: ${JSON.stringify(OPERATOR_TEXT)}, at: new Date(Date.now() - 7 * 60000).toISOString() }, { board: 'team', board_label: 'Sprout', kind: 'ask', id: 42, asker: 'Dev', text: '@Operator may I delete the old table?', at: new Date(Date.now() - 3600000).toISOString() }];
                window.__posts = []; window.__failPost = false; const orig = window.fetch.bind(window);
                window.fetch = (u, o) => { const url = String(u); const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                    if (url === '/api/operator-asks') return json(window.__asks);
                    if (/^\\/api\\/board\\/[^/]+\\/messages$/.test(url) && o && o.method === 'POST') { const body = JSON.parse(o.body); window.__posts.push({ url, body }); if (window.__failPost) return json({ error: 'too many messages; retry in 20s' }, 429);
                        window.__asks = window.__asks.filter(a => !(body.content.startsWith('@' + a.asker + ' ') && (a.kind === 'wait' || body.reply_to === a.id))); return json({ id: 99 }); }
                    return orig(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, at + 'two rows of Needs you', 10000);
            const rows = await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(r => ({ name: (r.querySelector('.inbox-review-name') || {}).textContent || '', sub: (r.querySelector('.cell-subtitle, [class*="subtitle"]') || {}).textContent || '', all: r.textContent }))`);
            const lead = rows.find(r => /Orchestrator/.test(r.all));
            assert.ok(lead, at + 'the question is a row: ' + JSON.stringify(rows.map(r => r.name)));
            assert.ok(!/\*\*|\]\(|^\s*-\s|`/.test(lead.name + ' ' + lead.sub), at + 'no Markdown marks on the row (' + JSON.stringify(lead.name.slice(0, 60)) + ' / ' + JSON.stringify(lead.sub.slice(0, 120)) + ')');
            assert.ok(/changes nothing/.test(lead.sub), at + 'the second line reads the words: ' + lead.sub.slice(0, 160));
        }
    } finally { await client.close(); }
    console.log('needs_ask_preview_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
