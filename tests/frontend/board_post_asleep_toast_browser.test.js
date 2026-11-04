// #13224 (QA Reviewer 2's SHOULD on #13189): the dashboard's board composer says, in a toast, which recipients of the person's post will not read it now (asleep, terminal gone, ended, archived), in the server's own
// words: one note when one recipient, the first three joined when more, and "(and N more)" past three; a post to awake agents says nothing more, and the draft is cleared as always.
//
// Drives Chrome over CDP through agent_view_harness.js; run_cdp_suites.mjs finds CDP suites by that name.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const BOARD = 'qa-asleep-toast-board';

// The server's answer to a post, chosen per post: the harness's mock is wrapped (registered after it).
const POSTS = `(() => {
    const st = window.__posts = { next: null, sent: [] };
    const inner = window.fetch;
    window.fetch = (url, opts = {}) => {
        let p = '';
        try { const u = new URL(String(url && url.url || url), location.href); p = u.pathname; } catch {}
        const m = String((opts && opts.method) || 'GET').toUpperCase();
        if (m === 'POST' && new RegExp('^/api/board/${BOARD}/messages$').test(p)) {
            st.sent.push(JSON.parse(opts.body).content);
            return Promise.resolve(new Response(JSON.stringify({ id: 900 + st.sent.length, subscriber_id: 'Operator', content: 'x', notified: ['Dev'], ...(st.next ? { asleep: st.next } : {}) }),
                { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        return inner(url, opts);
    };
})();`;

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const toasts = `[...document.querySelectorAll('.toast .toast-message')].map(t => t.textContent)`;
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: POSTS });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await install();
        await ev(`(() => { window.selectBoardProject(${JSON.stringify(BOARD)}); return true; })()`);
        await waitFor(`!!document.querySelector('#team-page-view #mb-post-input') && document.getElementById('team-page-view').getClientRects().length > 0`, 'the board composer', 8000);
        const note = n => ({ name: 'Agent ' + n, state: 'asleep', note: `Agent ${n} is asleep; the message waits until it wakes.` });
        const post = async (text, asleep) => {
            const before = await ev('window.__posts.sent.length');
            await ev(`(() => { document.querySelectorAll('.toast').forEach(t => t.remove()); window.__posts.next = ${JSON.stringify(asleep)};
                document.getElementById('mb-post-input').value = ${JSON.stringify(text)};
                document.querySelector('#team-page-view [data-on-click="mb-post"]').click(); return true; })()`); // the Send button, as a person's click
            await waitFor(`window.__posts.sent.length === ${before + 1}`, 'the post to be sent', 3000);
        };

        console.log('1. One recipient asleep: its note, in the server\'s words');
        await post('@Agent 1 look', [note(1)]);
        await waitFor(`${toasts}.some(t => t.includes('Agent 1 is asleep'))`, 'the note', 3000);
        assert.deepEqual(await ev(toasts), ['Agent 1 is asleep; the message waits until it wakes.']);
        assert.equal(await ev(`document.getElementById('mb-post-input').value`), '', 'the draft is cleared as always');
        console.log('   ✓ one note');

        console.log('2. Three: all three joined, no "more"');
        await post('@all look', [note(1), note(2), note(3)]);
        await waitFor(`${toasts}.length === 1`, 'the toast', 3000);
        const three = (await ev(toasts))[0];
        assert.ok(['Agent 1', 'Agent 2', 'Agent 3'].every(n => three.includes(n + ' is asleep')), three);
        assert.ok(!/more\)/.test(three), 'three are all named: ' + three);
        console.log('   ✓ three named');

        console.log('3. Five: the first three, then "(and 2 more)"');
        await post('@all look', [1, 2, 3, 4, 5].map(note));
        await waitFor(`${toasts}.length === 1`, 'the toast', 3000);
        const five = (await ev(toasts))[0];
        assert.ok(['Agent 1', 'Agent 2', 'Agent 3'].every(n => five.includes(n + ' is asleep')), five);
        assert.ok(!five.includes('Agent 4') && !five.includes('Agent 5'), 'the fourth and fifth are counted, not named: ' + five);
        assert.ok(five.endsWith('(and 2 more)'), five);
        console.log('   ✓ three named and "(and 2 more)"');

        console.log('4. Nobody asleep (no field, an empty list, a note that is not text): no toast');
        for (const asleep of [null, [], [{ name: 'X', state: 'asleep', note: 42 }]]) {
            await post('@Dev ping', asleep);
            await ev(`new Promise(r => setTimeout(r, 400))`); // sleep-ok: nothing should appear: wait out the toast's own draw before reading none
            assert.deepEqual(await ev(toasts), [], `no toast for ${JSON.stringify(asleep)}`);
        }
        console.log('   ✓ no toast');
        console.log('PASS board_post_asleep_toast_browser');
    } finally {
        await removeBoards(ev, [BOARD]);
        await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
