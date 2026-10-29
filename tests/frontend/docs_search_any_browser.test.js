// The Docs search for a person who types a question (#10484, Desktop pass 16:26): small words (how, do, I, to, the, on, my, use, a) are dropped, a topic with ANY of the rest is a hit, "How do I...?" ranks first,
// a hit's snippet is the sentence that has the words, and a click opens the topic at that sentence. Against the real docs of the isolated dev server, 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.switchNavTab('docs'); true`);
        await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length > 10`, 'the topics', 12000);
        const search = async q => { await ev(`(() => { const i = document.getElementById('docs-search'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await sleep(300); }; // sleep-ok: the topics' text is read once, then the list is drawn again
        const settled = async () => { await waitFor(`!/Searching the topics/.test(document.getElementById('docs-nav-list').textContent)`, 'the search settled', 20000); await sleep(300); }; // sleep-ok: the list is redrawn after the text arrives
        const shown = () => ev(`[...document.querySelectorAll('#docs-nav-list [data-doc]')].map(b => b.dataset.doc)`);

        // small words say nothing; a question finds the topic that answers it, and "How do I...?" is first
        await search('how do I switch to the light theme'); await settled();
        let hits = await shown();
        assert.equal(hits[0], 'how-do-i', `How do I...? is first for a question: ${JSON.stringify(hits.slice(0, 4))}`);
        // any of the remaining words is a hit (add, a, member, on, my, team: "member" and "team" are enough to find the topic that has either)
        await search('add a member on my team'); await settled(); hits = await shown();
        const only = async q => { await search(q); await settled(); return shown(); };
        const withWord = await only('member'), withNoise = await only('a member on my');
        assert.deepEqual(withNoise, withWord, 'the small words change nothing: "a member on my" finds what "member" finds');
        assert.ok((await only('member zzzzqq')).length >= withWord.length, 'a word no topic has does not hide the topics that have the other one');
        assert.deepEqual((await only('how do i')).includes('how-do-i'), true, 'a search of nothing but small words still searches them');

        // the snippet is a sentence
        await search('light theme'); await settled();
        const snips = await ev(`[...document.querySelectorAll('#docs-nav-list .doc-snippet')].map(e => e.textContent.trim())`);
        assert.ok(snips.length > 0 && snips.every(x => x.length <= 200 && /light|theme/i.test(x)), `a snippet is the sentence with the words: ${JSON.stringify(snips.slice(0, 3))}`);

        // a click opens the topic at the sentence
        await search('light theme'); await settled();
        await ev(`document.querySelector('#docs-nav-list [data-doc="how-do-i"]').click(); true`);
        await waitFor(`!!document.querySelector('#docs-content .doc-hit')`, 'the page opens at the sentence', 8000);
        const at = await ev(`(() => { const e = document.querySelector('#docs-content .doc-hit'), r = e.getBoundingClientRect(), box = document.getElementById('docs-content').getBoundingClientRect(); return { text: e.textContent.trim().slice(0, 120), inView: r.top >= 0 && r.bottom <= innerHeight, n: document.querySelectorAll('#docs-content .doc-hit').length }; })()`);
        assert.match(at.text, /light|theme/i, `the marked block has the words: ${JSON.stringify(at)}`);
        assert.ok(at.inView, `and is on screen: ${JSON.stringify(at)}`);
        console.log('PASS Docs search: small words dropped, any word is a hit, How do I...? first, the snippet is the sentence, the click opens at it');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
