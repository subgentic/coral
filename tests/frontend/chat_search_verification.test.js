import assert from 'node:assert/strict';

// Chat search: a slow query's late response must never overwrite a newer query's
// results (the requestGeneration guard in chat_search.js). This is the one scenario
// not covered by the other chat-search suites:
//   - chat_search_unit.test.js   covers highlightExcerpt (escaping, UTF-16 offsets)
//     and isSearchResponseUsable (complete/partial/unavailable/legacy "ok");
//   - chat_search_browser.test.js covers status rendering and real agent/board
//     locator navigation (deep navigation, repeated-text disambiguation, paging)
//     in a real browser.
// The rendering, escaping, status-contract and locator-dispatch assertions this file
// once duplicated were removed (#3814); only the generation/late-response race stays.

import { installDom } from './helpers/jsdom_env.mjs';
const dom = installDom({ mode: 'local' });
const container = document.getElementById('chat-search-results');
assert.ok(container, 'the real app shell includes the search results container');

const { searchChats } = await import('../../coral-go/pkg/frontend/static/chat_search.js');

// A slow first query, then a fast second query: the second's results show, and the
// first's late response is dropped by the generation check (never overwrites them).
{
    let resolveFirst;
    const firstPromise = new Promise(r => { resolveFirst = r; });

    globalThis.fetch = async (url) => {
        if (url.includes('q=first')) {
            await firstPromise;
            return { ok: true, json: async () => ({ status: 'partial', results: [{ session_id: 'sid-slow', source_type: 'src-slow', hits: [] }] }) };
        }
        if (url.includes('q=second')) {
            return { ok: true, json: async () => ({ status: 'partial', results: [{ session_id: 'sid-fast', source_type: 'src-fast', hits: [] }] }) };
        }
        return { ok: false, status: 500 };
    };

    const p1 = searchChats('first');   // slow
    const p2 = searchChats('second');  // fast

    await p2;
    const afterFast = [...container.children].filter(c => c.className === 'chat-search-result');
    assert.equal(afterFast.length, 1);
    assert.ok(afterFast[0].innerHTML.includes('src-fast'), 'Second (fast) response is displayed'); // the header names the chat by its title ("Chat" when it is not in the loaded list), never its id (#6288): the source tells the two answers apart

    resolveFirst();
    await p1;

    const afterLate = [...container.children].filter(c => c.className === 'chat-search-result');
    assert.equal(afterLate.length, 1);
    assert.ok(afterLate[0].innerHTML.includes('src-fast'), 'Late first response was dropped by the generation check');
    console.log('chat_search_verification: generation check drops stale late responses — ok');
}

dom.window.close();
