// A job's "Trust this folder" box (#16421): off on a new job, shown for a worktree job of Claude or Codex only, saved with the job, shown ticked when the job is edited, and cleared by the server when the job's
// folder changes. Isolated dev server; the real API is used (the page is the person's own dashboard).
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

function repo() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'trustjob-'));
    execFileSync('git', ['init', '-q', '-b', 'main', d]);
    execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
    return d;
}

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const a = repo(), b = repo(), made = [];
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'}${body ? `,body:${JSON.stringify(JSON.stringify(body))}` : ''}}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`Promise.resolve(window.showJobModal()).then(() => true)`);
        await waitFor(`!!document.getElementById('job-modal-name') && getComputedStyle(document.getElementById('job-modal')).display !== 'none'`, 'the New job dialog', 8000);
        await ev(`(() => { const d = document.getElementById('job-modal-trust').closest('details'); if (!d.open) d.querySelector('summary').click(); return true; })()`); // a closed disclosure's rows still have boxes: it is opened as a person does
        await waitFor(`!!document.getElementById('job-modal-trust') && document.getElementById('job-modal-trust').getClientRects().length > 0`, 'the Trust box in More options', 5000);
        assert.equal(await ev(`document.getElementById('job-modal-trust').closest('details').open`), true, 'the box is in More options, which is open');
        const first = await ev(`({ on: document.getElementById('job-modal-trust').checked, label: document.querySelector('label[for="job-modal-trust"]') && document.body.textContent.includes('Trust this folder') })`);
        assert.equal(first.on, false, 'a new job starts with the box off');
        await ev(`(() => { document.querySelector('#job-modal details.sv-fold').open = true; const e = document.getElementById('job-modal-trust'); for (let n = e.parentElement; n; n = n.parentElement) if (n.scrollHeight > n.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(n).overflowY)) { n.scrollTop = n.scrollHeight; break; } return true; })()`);
        await shot('job-trust-off');

        // Shown for Claude and Codex, hidden for an agent with no card Coral can set, and when the job runs in the folder itself.
        const shown = () => ev(`document.getElementById('job-modal-trust').getClientRects().length > 0`);
        await ev(`(() => { const s = document.getElementById('job-modal-agent'); s.value = 'codex'; s.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
        assert.equal(await shown(), true, 'shown for Codex');
        await ev(`(() => { const s = document.getElementById('job-modal-agent'); const o = [...s.options].find(x => x.value === 'agy'); if (!o) return false; s.value = 'agy'; s.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
        assert.equal(await shown(), false, 'hidden for Antigravity');
        await ev(`(() => { const s = document.getElementById('job-modal-agent'); s.value = 'claude'; s.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
        assert.equal(await shown(), true, 'shown for Claude');
        await ev(`document.getElementById('job-modal-no-worktree').click(); true`);
        assert.equal(await shown(), false, 'hidden when the job runs in the folder itself');
        await ev(`document.getElementById('job-modal-no-worktree').click(); true`);
        assert.equal(await shown(), true);

        // Tick it, fill the form and create the job: it is saved with the box on.
        const fill = (id, v) => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
        await fill('job-modal-name', 'trust-job-' + Date.now().toString(36)); await fill('job-modal-repo', a); await fill('job-modal-prompt', 'Say hello');
        await ev(`document.getElementById('job-modal-trust').click(); true`);
        await ev(`(() => { document.querySelector('#job-modal details.sv-fold').open = true; const e = document.getElementById('job-modal-trust'); for (let n = e.parentElement; n; n = n.parentElement) if (n.scrollHeight > n.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(n).overflowY)) { n.scrollTop = n.scrollHeight; break; } return true; })()`);
        await shot('job-trust-on');
        await ev(`document.getElementById('job-modal-submit').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('job-modal')).display === 'none'`, 'the dialog closed after Create job', 10000);
        const list = await api('GET', '/api/scheduled/jobs');
        const job = (list.body.jobs || list.body).find(j => j.repo_path && j.repo_path.endsWith(path.basename(a)) && /^trust-job-/.test(j.name));
        assert.ok(job, 'the job was created');
        made.push(job.id);
        assert.equal(job.trust_worktree, 1, 'saved with the box on');

        // Editing shows it ticked; a new folder from the page clears it on the server.
        await ev(`Promise.resolve(window.editScheduledJob(${job.id})).then(() => true)`);
        await waitFor(`!!document.getElementById('job-modal-trust') && document.getElementById('job-modal-trust').checked === true`, 'the edit dialog shows the box ticked', 8000);
        const moved = await api('PUT', `/api/scheduled/jobs/${job.id}`, { repo_path: b });
        assert.equal(moved.status, 200);
        assert.equal(moved.body.trust_worktree, 0, 'a new folder clears the box');
        console.log('PASS A job\'s Trust box: off by default, shown for Claude and Codex worktree jobs, saved, shown when edited, cleared by a new folder');
    } finally {
        for (const id of made) await api('DELETE', `/api/scheduled/jobs/${id}`).catch(() => {});
        await client.close();
        fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true });
    }
})().catch(e => { console.error(e); process.exit(1); });
