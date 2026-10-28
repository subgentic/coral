// New job's folder that is not a repository (#10276, Mobile pass 19): the server's refusal ("not a git repository", "no commit yet") is said under the field and offers "Make this folder a git repo"; the
// person is asked first (the dialog names the folder and says what Coral will do), and only then is the folder made a repository (POST init-repo); a folder that does not exist gets no offer. The routes are stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.__refusal = ''; window.__inits = []; window.__posts = []; const real = window.fetch;
            window.fetch = (u, o = {}) => { const url = String(u && u.url ? u.url : u), m = (o.method || 'GET').toUpperCase(), json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
                if (m === 'POST' && /\\/api\\/scheduled\\/jobs$/.test(url)) { window.__posts.push(JSON.parse(o.body)); } if (m === 'POST' && /\\/api\\/scheduled\\/jobs$/.test(url)) return window.__refusal ? json({ error: window.__refusal }, 400) : json({ id: 9 });
                if (m === 'POST' && /\\/api\\/scheduled\\/jobs\\/init-repo$/.test(url)) { window.__inits.push(JSON.parse(o.body)); return json({ ok: true, created: true }); }
                return real(u, o); }; true`);
        await ev(`Promise.resolve(window.showJobModal()).then(() => true)`);
        await waitFor(`!!document.getElementById('job-modal-name') && getComputedStyle(document.getElementById('job-modal')).display !== 'none'`, 'the New job dialog', 8000);
        await ev(`(() => { const b = [...document.querySelectorAll('#job-type-toggle button')].find(x => x.dataset.type === 'prompt'); if (b) b.click(); return true; })()`);
        const fill = () => ev(`(() => { const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
            set('job-modal-name', 'nightly'); set('job-modal-repo', '/work/plain'); set('job-modal-prompt', 'do it'); return true; })()`);
        const create = () => ev(`document.getElementById('job-modal-submit').click(); true`);
        const offer = () => ev(`(() => { const o = document.getElementById('job-repo-offer'); return o && o.getClientRects().length ? o.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
        await fill();

        await ev(`window.__refusal = 'repo_path is not an existing directory: /work/plain'; true`); await create();
        await waitFor(`/does not exist/.test(document.getElementById('job-form').textContent)`, 'a missing folder is said', 5000);
        assert.equal(await offer(), null, 'a folder that is not there is not offered a repository');

        await ev(`window.__refusal = 'repo_path is not a git repository: /work/plain'; true`); await create();
        await waitFor(`!!document.getElementById('job-repo-offer') && document.getElementById('job-repo-offer').getClientRects().length > 0`, 'the offer', 5000);
        assert.match(await offer(), /needs a git repository with one commit\. Make it a git repo$/, 'the offer says why and has one button (#10783)');
        assert.equal(await ev(`document.querySelectorAll('#job-repo-offer button').length`), 1, 'one button: the way to run in the folder itself is the switch under More options');
        assert.match(await ev(`document.getElementById('job-form').textContent`), /That folder is not a git repository: \/work\/plain/);
        assert.doesNotMatch(await ev(`document.body.innerText`), /repo_path/, 'no field name from the code reaches the person (#10558): the field says it, the foot says to fix the folder');

        await ev(`window.__refusal = 'repo_path has no commit yet: /work/plain'; true`); await create();
        await waitFor(`/has no commit yet/.test(document.getElementById('job-form').textContent)`, 'a repository with no commit is said', 5000);
        assert.ok(await offer(), 'and offers the same');

        await ev(`window.__posts = []; document.getElementById('job-make-repo').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the person is asked first', 5000);
        assert.deepEqual(await ev(`window.__inits`), [], 'nothing is made before the person agrees');
        const asked = await ev(`document.getElementById('confirm-modal-message').textContent`);
        assert.match(asked, /git init in \/work\/plain/, 'the dialog names the folder: ' + asked);
        assert.match(asked, /one empty first commit/, 'and what Coral will do');
        await ev(`window.__refusal = ''; document.getElementById('confirm-modal-yes').click(); true`); // the server will take the folder now
        await waitFor(`window.__inits.length === 1`, 'the folder is made a repository', 5000);
        assert.deepEqual(await ev(`window.__inits[0]`), { repo_path: '/work/plain' });
        await waitFor(`window.__posts.length === 1 && getComputedStyle(document.getElementById('job-modal')).display === 'none'`, 'the job is created at once, the person is not asked to create it again (#10783)', 5000);
        console.log('PASS New job: a folder that is not a repository is offered one "Make it a git repo" button, asked first, made one, and the job is created; a missing folder is not offered');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
