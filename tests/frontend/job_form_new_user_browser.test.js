// What a new user meets in the New job dialog (Beta Tester pass 3, #9965): it opens on Agent prompt when the person has no workflow of their own, even though the seeded example workflow (its description
// starts with Example) is in the list (point 2), and a repository path the server refuses is said under that field, in words, with the focus there (point 3b). Isolated dev server, 1280 px, the workflow list stubbed through fetch.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        const openWith = async workflows => {
            await ev(`window.__wfList = ${JSON.stringify(workflows)}; if (!window.__wfStub) { window.__wfStub = true; const real = window.fetch; window.fetch = (u, o) => { const url = String(u && u.url ? u.url : u); if (/\\/api\\/workflows$/.test(url)) return Promise.resolve(new Response(JSON.stringify({ workflows: window.__wfList }), { headers: { 'Content-Type': 'application/json' } })); return real(u, o); }; } true`);
            await ev(`Promise.resolve(window.showJobModal()).then(() => true)`);
            await waitFor(`!!document.getElementById('job-modal-workflow') && document.getElementById('job-modal-workflow').options.length > 0`, 'the workflow list', 8000);
            await ev(`new Promise(r => setTimeout(r, 300))`); // sleep-ok: the dialog settles on its type after the list is read
            const type = await ev(`(() => { const b = [...document.querySelectorAll('#job-type-toggle button')].find(x => x.getAttribute('aria-pressed') === 'true'); return b ? b.dataset.type : null; })()`);
            await ev(`window.hideJobModal(); true`);
            return type;
        };
        assert.equal(await openWith([]), 'prompt', 'no workflow at all: Agent prompt');
        assert.equal(await openWith([{ id: 1, name: 'daily-motivation', description: 'Example: generates a motivational message and shows it as a popup', steps: [] }]), 'prompt', 'only the seeded example: Agent prompt');
        assert.equal(await openWith([{ id: 1, name: 'daily-motivation', description: 'Example: generates a message', steps: [] }, { id: 2, name: 'nightly-build', description: 'Build and test', steps: [] }]), 'prompt', 'a workflow of the person\'s own: the dialog still opens on Run a prompt, the first choice (#10515)');
        console.log('PASS a new job always opens on Run a prompt');
        // 3b. the server refuses the repository path: under the field, with the focus
        await ev(`const real2 = window.fetch; window.fetch = (u, o) => { const url = String(u && u.url ? u.url : u); if (o && o.method === 'POST' && /\\/api\\/scheduled\\/jobs$/.test(url)) return Promise.resolve(new Response(JSON.stringify({ error: 'repo_path is not an existing directory: /tmp/nowhere/work' }), { status: 400, headers: { 'Content-Type': 'application/json' } })); return real2(u, o); }; true`);
        await ev(`Promise.resolve(window.showJobModal()).then(() => true)`);
        await waitFor(`!!document.getElementById('job-modal-repo')`, 'the New job dialog', 8000);
        await ev(`(() => { const b = [...document.querySelectorAll('#job-type-toggle button')].find(x => x.dataset.type === 'prompt'); if (b) b.click(); const set = (id, v) => { const i = document.getElementById(id); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }; set('job-modal-name', 'hello'); set('job-modal-repo', '/tmp/nowhere/work'); set('job-modal-prompt', 'Say hello'); return true; })()`);
        await ev(`document.getElementById('job-modal-submit').click(); true`);
        await waitFor(`/That folder does not exist: \\/tmp\\/nowhere\\/work/.test(document.getElementById('job-form').textContent)`, 'the refusal is said in words', 8000);
        const where = await ev(`(() => { const f = document.getElementById('job-modal-repo'), m = [...document.querySelectorAll('#job-form [role=alert], #job-form .sv-error, #job-form .field-error')].find(e => /That folder does not exist/.test(e.textContent)); const fr = f.getBoundingClientRect(), mr = m ? m.getBoundingClientRect() : null; return { focused: document.activeElement === f, near: !!mr && Math.abs(mr.top - fr.bottom) < 80, found: !!m }; })()`);
        assert.deepEqual([where.found, where.focused, where.near], [true, true, true], 'under the Repository path field, which has the focus: ' + JSON.stringify(where));
        console.log('PASS a refused repository path is said under its field');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
