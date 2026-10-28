// A chat's own page on a phone, Star and Archive (#10738, Mobile pass 39): the buttons changed their icon and said nothing, and an archived chat vanished from the list with no word of where it went. Now Star says "Starred" (and
// "Star removed"), Archive says "Archived. Find it under Archived." with an Undo that puts the chat back, and Unarchive says "Unarchived". At 390 px; isolated dev server, the harness's page; the history read and the flags PATCH are stood in.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`(() => { const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
            window.__flags = [];
            const row = { session_id: 'chat-flag-1', type: 'agent', title: 'Release notes chat', summary: 'a chat', agent_type: 'claude', source_type: 'claude', last_timestamp: new Date().toISOString(), duration_sec: 60, starred: false, archived: false, active: false, tags: [], server: 'local' };
            window.__row = row;
            const R = window.fetch.bind(window);
            window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
                if (/\\/api\\/sessions\\/history\\/chat-flag-1\\/flags$/.test(url.pathname)) { window.__flags.push(JSON.parse(o.body)); return json({ ok: true }); }
                if (url.pathname === '/api/sessions/history/counts') return json({ all: 1, group: 0, notes: 0, active: 0, starred: 0, archived: 0, by_agent_type: {}, tags: [] });
                if (url.pathname === '/api/sessions/history') return json({ sessions: [row], total: 1, page: 1, page_size: 50 });
                if (/\\/api\\/sessions\\/history\\/chat-flag-1/.test(url.pathname)) return json({ messages: [], session_id: 'chat-flag-1' });
                return R(u, o); };
            return true; })()`);
        await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); state.historySessionsList = [{ ...window.__row }]; return true; })()`);
        await ev(`Promise.resolve(window.selectHistorySession('chat-flag-1')).then(() => true)`);
        await waitFor(`!!document.getElementById('history-star') && !document.getElementById('history-flags').hidden`, 'the chat page and its flags', 8000);
        const said = () => ev(`[...document.querySelectorAll('.toast, #notice-announcer')].map(e => e.textContent.replace(/\\s+/g, ' ').trim()).filter(Boolean).join(' | ')`);
        const press = id => ev(`document.getElementById('${id}').click(); true`);
        const expectSaid = async (re, what) => { try { await waitFor(`/${re.source}/.test([...document.querySelectorAll('.toast, #notice-announcer')].map(e => e.textContent).join(' | '))`, what, 3000); } catch { problems.push(`${what}: nothing said it (the page says "${await said()}")`); } };
        await press('history-star'); await expectSaid(/Starred/, 'Star says Starred');
        await press('history-star'); await expectSaid(/Star removed/, 'Star again says Star removed');
        await press('history-archive'); await expectSaid(/Archived\. Find it under Archived\./, 'Archive says where the chat went');
        const undo = await ev(`!![...document.querySelectorAll('.toast button')].find(b => /Undo/.test(b.textContent))`);
        if (!undo) problems.push('Archive offers Undo on its toast');
        else {
            await ev(`[...document.querySelectorAll('.toast button')].find(b => /Undo/.test(b.textContent)).click(); true`);
            try { await waitFor(`document.getElementById('history-archive').getAttribute('aria-label') === 'Archive'`, 'Undo puts the chat back', 3000); } catch { problems.push('Undo does not put the chat back (the button still says ' + await ev(`document.getElementById('history-archive').getAttribute('aria-label')`) + ')'); }
            const flags = await ev(`window.__flags`);
            if (JSON.stringify(flags[flags.length - 1]) !== '{"archived":false}') problems.push('Undo asks the server to unarchive: ' + JSON.stringify(flags));
        }
        await press('history-archive'); await press('history-archive'); await expectSaid(/Unarchived/, 'Unarchive says Unarchived');
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Star and Archive on a chat page:\n  ' + problems.join('\n  '));
    console.log('PASS Star and Archive say what they did');
})().catch(e => { console.error(e); process.exit(1); });
