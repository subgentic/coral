// #17211: the first-commit dialog's tick box is a row (box left of its sentence), and a big folder starts unticked with a warning; a folder past the limit has no box. (Setup copied from job_form_repo_offer.) New job's folder that is not a repository (#10276, Mobile pass 19): the server's refusal ("not a git repository", "no commit yet") is said under the field and offers "Make this folder a git repo"; the
// person is asked first (the dialog names the folder and says what Coral will do), and only then is the folder made a repository (POST init-repo); a folder that does not exist gets no offer. The routes are stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.__refusal = ''; window.__isgit = { is_git: false }; window.__inits = []; window.__posts = []; const real = window.fetch;
            window.fetch = (u, o = {}) => { const url = String(u && u.url ? u.url : u), m = (o.method || 'GET').toUpperCase(), json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
                if (m === 'POST' && /\\/api\\/scheduled\\/jobs$/.test(url)) { window.__posts.push(JSON.parse(o.body)); } if (m === 'POST' && /\\/api\\/scheduled\\/jobs$/.test(url)) return window.__refusal ? json({ error: window.__refusal }, 400) : json({ id: 9 });
                if (m === 'GET' && /\\/api\\/filesystem\\/is-git\?/.test(url)) return json(window.__isgit);
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

        const open = async (isgit) => {
            await ev(`window.__refusal = 'repo_path is not a git repository: /work/plain'; window.__inits = []; window.__isgit = ${JSON.stringify(isgit)}; true`);
            await ev(`document.getElementById('confirm-modal-no')?.click(); true`);
            await ev(`Promise.resolve(window.showJobModal()).then(() => true)`);
            await waitFor(`!!document.getElementById('job-modal-name') && getComputedStyle(document.getElementById('job-modal')).display !== 'none'`, 'the New job dialog', 8000);
            await ev(`(() => { const b = [...document.querySelectorAll('#job-type-toggle button')].find(x => x.dataset.type === 'prompt'); if (b) b.click(); return true; })()`);
            await fill();
            await ev(`document.getElementById('job-modal-repo').dispatchEvent(new Event('change', { bubbles: true })); true`);
            await waitFor(`!!document.getElementById('job-repo-offer') && document.getElementById('job-repo-offer').getClientRects().length > 0`, 'the offer', 5000);
            await ev(`document.getElementById('job-make-repo').click(); true`);
            await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the question', 5000);
        };
        // the tick box is a row: the box at the left of its sentence, on the same line
        await open({ is_git: false, files: 12 });
        const row = await ev(`(() => { const l = document.getElementById('confirm-modal-choice'), i = l.querySelector('input').getBoundingClientRect(), r = l.getBoundingClientRect(); return { display: getComputedStyle(l).display, boxLeft: i.left - r.left, boxTop: i.top - r.top, h: r.height, w: r.width, boxW: i.width }; })()`);
        assert.equal(row.display, 'flex', 'a row: ' + JSON.stringify(row));
        assert.ok(row.boxLeft < 4 && row.h < 60, 'the box sits at the left of its sentence, not centred above it: ' + JSON.stringify(row));
        // a big folder: unticked, and the dialog says why
        await open({ is_git: false, files: 6000 });
        assert.equal(await ev(`document.querySelector('#confirm-modal-choice input').checked`), false, 'a big folder starts unticked');
        assert.match(await ev(`document.getElementById('confirm-modal-message').textContent`), /holds 6,?000 files: including them takes a while/, 'and says why');
        // past the limit: no box at all, and the commit will be empty
        await open({ is_git: false, files: 20001, files_capped: true });
        assert.equal(await ev(`!!document.getElementById('confirm-modal-choice')`), false, 'no box for a folder past the limit');
        assert.match(await ev(`document.getElementById('confirm-modal-message').textContent`), /more than 20,000 files.*will be empty/, 'the commit will be empty, and it says so');
        console.log('PASS New job first commit: the tick box is a row, a big folder starts unticked, a huge one has no box');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
