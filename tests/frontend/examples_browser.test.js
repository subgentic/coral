// The example job and workflow Coral adds (#10001, Beta tester #9958 point 1): the Jobs and Workflows folders and the job's page mark them with an Example tag, so nobody takes them for their own; Settings > Storage and cleanup
// has Remove examples, which deletes only those (a description that starts with Example) and asks first. 1280 px, isolated dev server, the server's answers stubbed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        const STUB = `(() => {
            const real = window.fetch; window.__deleted = [];
            window.__jobs = [{ id: 7, name: 'morning-motivation', description: 'Example (switched off): would run the daily-motivation workflow every weekday at 9am.', job_type: 'workflow', workflow_id: 3, cron_expr: '0 9 * * 1-5', timezone: 'Local', enabled: 0 },
                { id: 9, name: 'my-report', description: 'Example report for Acme', job_type: 'prompt', cron_expr: '0 3 * * *', timezone: 'Local', enabled: 1, repo_path: '/tmp/x', prompt: 'Write the report' },
                { id: 8, name: 'my-nightly', description: 'Mine', job_type: 'prompt', cron_expr: '0 2 * * *', timezone: 'Local', enabled: 1, repo_path: '/tmp/x', prompt: 'Run the tests' }];
            window.__workflows = [{ id: 3, name: 'daily-motivation', description: 'Example: generates a motivational message', steps: [], enabled: 1 }, { id: 4, name: 'my-flow', description: 'Mine', steps: [], enabled: 1 }];
            window.fetch = (input, init = {}) => {
                const u = new URL(String(input && input.url ? input.url : input), location.origin).pathname, m = (init.method || 'GET').toUpperCase();
                const json = o => Promise.resolve(new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } }));
                if (m === 'DELETE' && /^\\/api\\/(scheduled\\/jobs|workflows)\\/\\d+$/.test(u)) { window.__deleted.push(u); const id = Number(u.split('/').pop()); if (u.includes('scheduled')) window.__jobs = window.__jobs.filter(j => j.id !== id); else window.__workflows = window.__workflows.filter(w => w.id !== id); return json({ ok: true }); }
                if (u === '/api/scheduled/jobs') return json({ jobs: window.__jobs });
                if (u === '/api/workflows') return json({ workflows: window.__workflows });
                if (/^\\/api\\/scheduled\\/jobs\\/\\d+\\/runs/.test(u)) return json({ runs: [], total: 0 });
                return real(input, init);
            };
            return true;
        })()`;
        await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Page.navigate({ url: BASE + '/automations/jobs' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 3`, 'the three jobs', 10000);
        const rows = await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(r => [r.querySelector('.dt-primary')?.textContent.trim(), !!r.querySelector('.dt-name-example .dt-tag')])`);
        assert.deepEqual(rows.sort(), [['morning-motivation', true], ['my-nightly', false], ['my-report', false]], 'the seeded example is tagged; the person\'s own jobs are not, even one described Example report for Acme: ' + JSON.stringify(rows));
        await shot('examples-jobs');
        // the job's page
        await ev(`document.querySelector('#group-table-view tbody .dt-primary').click(); true`);
        await waitFor(`!!document.querySelector('#scheduler-detail h2')`, 'a job page', 8000);
        const tagged = await ev(`[...document.querySelectorAll('#scheduler-detail h2')].map(h => [h.textContent.trim().replace(/\\s+/g, ' '), !!h.querySelector('.dt-tag')])`);
        assert.equal(tagged.length, 1); assert.equal(tagged[0][1], /morning-motivation/.test(tagged[0][0]), 'the page of the example says Example, the other does not: ' + JSON.stringify(tagged));
        // Settings: Remove examples
        await ev(`window.showSettingsModal(); true`);
        await waitFor(`!!document.getElementById('settings-tab-cleanup')`, 'the Settings tabs', 8000);
        await ev(`document.getElementById('settings-tab-cleanup').click(); true`);
        await waitFor(`!document.getElementById('settings-examples-remove').hidden`, 'Remove examples shown', 8000);
        assert.match(await ev(`document.getElementById('settings-examples-status').textContent`), /^Coral added 2 examples to Automations: morning-motivation, daily-motivation\.$/);
        await shot('examples-settings');
        await ev(`document.getElementById('settings-examples-remove').click(); true`);
        await waitFor(`!!document.getElementById('confirm-modal-yes') && document.getElementById('confirm-modal-yes').getClientRects().length > 0`, 'the confirmation', 5000);
        assert.deepEqual(await ev(`window.__deleted`), [], 'nothing is deleted before the person agrees');
        await ev(`document.getElementById('confirm-modal-yes').click(); true`);
        await waitFor(`window.__deleted.length === 2`, 'the two deletes', 8000);
        assert.deepEqual((await ev(`window.__deleted`)).sort(), ['/api/scheduled/jobs/7', '/api/workflows/3'], 'only the seeded examples: the own job my-report described Example report for Acme survives');
        await waitFor(`document.getElementById('settings-examples-remove').hidden`, 'the button goes when none are left', 8000);
        console.log('\nPASS examples are tagged, and Remove examples deletes only them after asking');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
