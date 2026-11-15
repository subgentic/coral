// A path in a task's result that names a file in its worker's folder opens in a read-only dialog (#18200, walk 31 F13): one button for the path under the agent's folder, none for a path that climbs out, the file's text in the dialog
// (as text), the server's words when it refuses, and a result with no running agent stays plain text.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        const S = `(window.__coralStatic || '/static/')`;
        const out = await ev(`(async () => {
            const m = await import(${S} + 'task_result_files.js');
            const asked = [], real = window.fetch;
            window.fetch = (u, o) => { const url = String(u); if (!/file-content/.test(url)) return real(u, o); asked.push(url);
                return Promise.resolve(new Response(JSON.stringify(/missing/.test(url) ? { error: 'File not found' } : { content: '<b>hello</b>\\nline 2' }), { status: /missing/.test(url) ? 404 : 200, headers: { 'Content-Type': 'application/json' } })); };
            const session = { name: 'work-1', session_id: 's1', working_directory: '/w' };
            const host = document.createElement('span'); host.textContent = 'Wrote README.md, /w/src/a.js and ../x.md and missing.md.'; document.body.append(host);
            m.linkPaths(host, session);
            const buttons = [...host.querySelectorAll('button')].map(b => b.textContent);
            const whole = host.textContent;
            host.querySelector('button').click();
            await new Promise(r => setTimeout(r, 400));
            const dlg = document.querySelector('dialog.task-result-file');
            const first = dlg && { open: dlg.open, title: dlg.querySelector('h3').textContent, text: dlg.querySelector('pre').textContent, markup: !!dlg.querySelector('pre b') };
            dlg && dlg.querySelector('button').click();
            const closed = !document.querySelector('dialog.task-result-file');
            const bad = document.createElement('span'); bad.textContent = 'See missing.md'; document.body.append(bad); m.linkPaths(bad, session); bad.querySelector('button').click();
            await new Promise(r => setTimeout(r, 400));
            const refused = document.querySelector('dialog.task-result-file pre') && document.querySelector('dialog.task-result-file pre').textContent;
            const plain = document.createElement('span'); plain.textContent = 'Wrote README.md'; document.body.append(plain); m.linkPaths(plain, null);
            window.fetch = real;
            return { buttons, whole, asked, first, closed, refused, plain: plain.querySelectorAll('button').length };
        })()`);
        assert.deepEqual(out.buttons, ['README.md', '/w/src/a.js', 'missing.md'], 'a button for each path under the folder, none for ../x.md: ' + JSON.stringify(out.buttons));
        assert.equal(out.whole, 'Wrote README.md, /w/src/a.js and ../x.md and missing.md.', 'the words are whole around the buttons');
        assert.ok(/filepath=README\.md/.test(out.asked[0]) && /session_id=s1/.test(out.asked[0]) && /work-1\/file-content/.test(out.asked[0]), 'it reads the file through the agent\'s own file-content route: ' + out.asked[0]);
        assert.deepEqual([out.first.open, out.first.title, out.first.text, out.first.markup], [true, 'README.md', '<b>hello</b>\nline 2', false], 'the file is shown as text, not as markup: ' + JSON.stringify(out.first));
        assert.ok(out.closed, 'Close closes the dialog');
        assert.equal(out.refused, 'File not found', 'the server\'s own words when it refuses');
        assert.equal(out.plain, 0, 'with no running agent the result stays plain text');
    } catch (e) { failures.push(e.stack || String(e)); }
    finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('task_result_files_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
