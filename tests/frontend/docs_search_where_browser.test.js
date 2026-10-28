// The Docs search ranks a hit by where the word sits (#10303, Beta #10259): a title first, then a heading, then a step or paragraph, and a code line last, and the snippet under a hit shows the best place the word
// is, not the first one (a search for "sleep" showed a /bin/sleep code line). Four stubbed topics (their titles do not have the word), 1280 px. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const TOPICS = {
    'code-only': { title: 'Alpha reference', content: '# Alpha reference\n\nRun it like this:\n\n```\n/bin/sleep 5\n```\n' },
    'in-heading': { title: 'Beta guide', content: '# Beta guide\n\nIntro text.\n\n## Put agents to sleep\n\nPick the team and press the button.\n' },
    'in-step': { title: 'Gamma guide', content: '# Gamma guide\n\n1. Open the menu.\n2. Choose Sleep to pause the agent.\n' },
    'code-first': { title: 'Delta guide', content: '# Delta guide\n\n```\n/bin/sleep 1\n```\n\nLater, choose Sleep from the row\'s menu to stop it for now.\n' },
};

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const T = ${JSON.stringify(TOPICS)}; const inner = window.fetch;
            const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o) => { const p = new URL(String(u && u.url || u), location.origin).pathname;
                if (p === '/api/agent-docs') return json(Object.entries(T).map(([name, t]) => ({ name, title: t.title, summary: 'A topic.' })));
                const m = /^\\/api\\/agent-docs\\/([\\w-]+)$/.exec(p); if (m && T[m[1]]) return json({ name: m[1], title: T[m[1]].title, content: T[m[1]].content });
                return inner(u, o); }; })();` });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.switchNavTab('docs'); true`);
        await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length === 4`, 'the four topics', 12000);
        await ev(`(() => { const i = document.getElementById('docs-search'); i.value = 'sleep'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await waitFor(`!/Searching the topics/.test(document.getElementById('docs-nav-list').textContent) && document.querySelectorAll('#docs-nav-list .doc-snippet').length >= 3`, 'the search and its snippets', 20000);
        await sleep(300); // sleep-ok: the list is drawn again after the text arrives
        const order = await ev(`[...document.querySelectorAll('#docs-nav-list [data-doc]')].map(b => b.dataset.doc)`);
        assert.deepEqual(order, ['in-heading', 'in-step', 'code-first', 'code-only'], 'a heading, then a step, then (by its prose) a topic whose first hit is code, and the code-only topic last: ' + order.join(', '));
        const snip = await ev(`Object.fromEntries([...document.querySelectorAll('#docs-nav-list [data-doc]')].map(b => [b.dataset.doc, ((b.closest('li') || b.parentElement).querySelector('.doc-snippet') || {}).textContent || '']))`);
        assert.match(snip['code-first'], /choose Sleep from the row/, 'the snippet shows the prose line, not the /bin/sleep code line: ' + snip['code-first']);
        assert.doesNotMatch(snip['code-first'], /\/bin\/sleep/, 'and no code in it');
        assert.match(snip['in-heading'], /Put agents to sleep/, 'a heading hit shows the heading: ' + snip['in-heading']);
        // a word no topic has does not rank the others as code (#10484's any-word match): the same order, and the same snippet
        await ev(`(() => { const i = document.getElementById('docs-search'); i.value = 'sleep zzzzqq'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await sleep(600); // sleep-ok: the list is drawn again for the new words
        const order2 = await ev(`[...document.querySelectorAll('#docs-nav-list [data-doc]')].map(b => b.dataset.doc)`);
        assert.deepEqual(order2, ['in-heading', 'in-step', 'code-first', 'code-only'], 'with a word no topic has beside it, the order is the same: ' + order2.join(', '));
        assert.match(await ev(`((document.querySelector('#docs-nav-list [data-doc="code-first"]').closest('li') || document.body).querySelector('.doc-snippet') || {}).textContent || ''`), /choose Sleep from the row/, 'and the snippet is still the prose line');
        console.log('PASS Docs search: heading, then step, then code; the snippet is the best place');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
