// An open file preview follows its file (#10334, Desktop pass 31): when the Files list is read again (Refresh, or the agent's reply ends) the open text file is read again too. A preview with no edits shows
// the new text and keeps its scroll place; an editor with unsaved edits keeps them and says "The file changed on disk" with a Reload button (never a silent overwrite). The file endpoint is answered in the page
// from a mutable "disk"; everything else goes to the isolated server. 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const LONG = n => Array.from({ length: 400 }, (_, i) => `line ${i} of ${n}`).join('\n');
const DISK = `(() => {
    window.__disk = { '/notes.txt': 'one\\nsecond line', '/long.txt': ${JSON.stringify(LONG('v1'))}, '/draft.txt': 'draft v1', '/slow.txt': 'slow v1' };
    const inner = window.fetch;
    const reply = content => Promise.resolve(new Response(JSON.stringify({ content }), { status: 200, headers: { 'content-type': 'application/json' } }));
    window.fetch = (url, opts) => {
        const u = new URL(String(url), location.origin);
        const f = window.__disk['/' + String(u.searchParams.get('filepath')).replace(/^[/]+/, '')];
        if (f !== undefined && window.__hold && String(u.searchParams.get('filepath')).endsWith('slow.txt') && /\\/file-content$/.test(u.pathname) && !(opts && opts.method === 'PUT')) return new Promise(r => { window.__release = () => { window.__hold = false; r(reply(f)); }; }); // the read is slow: answered when released
        if (f !== undefined && /\\/file-content$/.test(u.pathname) && !(opts && opts.method === 'PUT')) return reply(f);
        if (/\\/api\\/sessions\\/live\\/[^/]+\\/files(\\?|$)/.test(u.pathname + u.search)) return Promise.resolve(new Response(JSON.stringify({ files: [], diff_mode: 'branch_point' }), { headers: { 'content-type': 'application/json' } }));
        return inner(url, opts);
    };
})();`;

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const text = () => ev(`(document.getElementById('preview-body') || {}).innerText || ''`);
    const open = (p, mode) => ev(`import(${MOD} + 'preview_pane.js').then(pp => { pp.openPreviewTab(${JSON.stringify(p)}, 0, ${JSON.stringify(mode ? { mode } : {})}); return true; })`);
    const refresh = () => ev(`import(${MOD} + 'changed_files.js').then(m => m.loadChangedFiles('ed-a', 'ed-a-id')).then(() => true)`);
    const scroller = `(() => { const b = document.getElementById('preview-body'); return [b, ...b.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 20 && getComputedStyle(e).overflowY !== 'visible') || b; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: DISK });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); window.__m.add('ed-a', 'A', 3, { sleeping: false }); true`);
        await ev(`window.selectLiveSession('ed-a', 'claude', 'ed-a-id', 'local'); true`);

        console.log('1. A preview with no edits shows the new text after the list is read again');
        await open('notes.txt');
        await waitFor(`/second line/.test((document.getElementById('preview-body') || {}).innerText || '')`, 'the file', 8000);
        await ev(`window.__disk['/notes.txt'] = 'one\\nsecond line\\nand a line the agent added'; true`);
        await refresh();
        await waitFor(`/the agent added/.test((document.getElementById('preview-body') || {}).innerText || '')`, 'the preview shows the new text', 6000);
        console.log('   ✓');

        console.log('2. It keeps its scroll place');
        await open('long.txt');
        await waitFor(`/line 399 of v1/.test((document.getElementById('preview-body') || {}).innerText || '')`, 'the long file', 8000);
        await ev(`${scroller}.scrollTop = 900; true`);
        const before = await ev(`${scroller}.scrollTop`);
        assert.ok(before > 500, 'it scrolled: ' + before);
        await ev(`window.__disk['/long.txt'] = ${JSON.stringify(LONG('v2'))}; true`);
        await refresh();
        await waitFor(`/line 399 of v2/.test((document.getElementById('preview-body') || {}).innerText || '')`, 'the new text', 6000);
        const after = await ev(`${scroller}.scrollTop`);
        assert.ok(Math.abs(after - before) <= 40, `the scroll place is kept (${before} -> ${after})`);
        console.log('   ✓');

        console.log('3. An editor with unsaved edits keeps them, and says the file changed, with Reload');
        await open('draft.txt', 'edit');
        await waitFor(`!!document.querySelector('#preview-pane .cm-content')`, 'the editor', 10000);
        await ev(`document.querySelector('#preview-pane .cm-content').focus(); true`);
        await client.Input.insertText({ text: ' MY EDIT' });
        await ev(`window.__disk['/draft.txt'] = 'draft v2 from the agent'; true`);
        await refresh();
        await waitFor(`/changed on disk/i.test((document.getElementById('preview-body') || {}).innerText || '')`, 'the changed-on-disk note', 6000);
        assert.match(await ev(`document.querySelector('#preview-pane .cm-content').innerText`), /MY EDIT/, 'the unsaved edit is kept');
        assert.equal(await ev(`[...document.querySelectorAll('#preview-body button')].some(b => /^Reload/.test(b.textContent.trim()))`), true, 'a Reload button');
        await ev(`[...document.querySelectorAll('#preview-body button')].find(b => /^Reload/.test(b.textContent.trim())).click(); true`);
        await waitFor(`/draft v2 from the agent/.test((document.querySelector('#preview-pane .cm-content') || {}).innerText || '')`, 'Reload takes the disk text', 6000);
        assert.doesNotMatch(await ev(`document.querySelector('#preview-pane .cm-content').innerText`), /MY EDIT/, 'and only on that click');
        console.log('   ✓');
        console.log('4. Typing while the read is still in flight is not lost');
        await open('slow.txt', 'edit');
        await waitFor(`/slow v1/.test((document.querySelector('#preview-pane .cm-content') || {}).innerText || '')`, 'the editor', 10000);
        await ev(`window.__hold = true; window.__disk['/slow.txt'] = 'slow v2 from the agent'; import(${MOD} + 'changed_files.js').then(m => m.loadChangedFiles('ed-a', 'ed-a-id')); true`);
        await waitFor(`typeof window.__release === 'function'`, 'the read to be in flight', 5000);
        await ev(`document.querySelector('#preview-pane .cm-content').focus(); true`);
        await client.Input.insertText({ text: ' TYPED DURING THE READ' });
        await ev(`window.__release(); true`);
        await waitFor(`/changed on disk/i.test((document.getElementById('preview-body') || {}).innerText || '')`, 'the note, not an overwrite', 6000);
        assert.match(await ev(`document.querySelector('#preview-pane .cm-content').innerText`), /TYPED DURING THE READ/, 'what was typed while the read was out is kept');
        console.log('   \u2713');
        console.log('PASS Open previews follow their file: new text, scroll kept, edits never dropped');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
