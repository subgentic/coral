// Automations, the Queue folder, what each run is (#14857, the Operator: 'I am able to see more info about what they are running'): a row opens to its full note, command, head, computer, start, how long it has run and the
// expected time; the finished runs of a resource (the last 20) are one button under it and each says how it ended (Passed, exit 0 / Failed, exit N / No result recorded) with its last line and how long it took.
// Text only: a command is drawn as text, never as markup or a link. The chevron is a real button (aria-expanded, a name that says what it opens) and keeps the keyboard; on a phone the same is the row's ... menu. 1280 and 390.
// Drives Chrome over CDP through agent_view_harness.js with a stubbed /api/resources.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const now = Date.now();
const iso = ms => new Date(now + ms).toISOString();
const LONG_NOTE = 'QA #14839 re-review of #14831: the whole cdp family on the Mac, then the node tests, then the Go routes package with -race and a count of twenty';
const LONG_CMD = 'npm --prefix tests/frontend run test:cloud && node tests/frontend/run_cdp_suites.mjs --family inbox_ --shards 3 --retries 1 <b>not markup</b> ' + 'x'.repeat(160);
const QUEUE = [
    { name: 'mac-heavy', slots: 1, machine: 'Mac', max_lease_seconds: 3600,
        holders: [{ id: 11, agent: 'QA Engineer', task: 14839, priority: 3, note: LONG_NOTE, cmd: LONG_CMD, head: '6e00dcd5c36ca7f2', expect_min: 20, enqueued_at: iso(-1800000), granted_at: iso(-1500000), lease_until: iso(25 * 60000) }],
        queue: [{ id: 12, agent: 'Frontend Dev', task: 13600, priority: 2, note: 'go-test routes', cmd: 'go test ./internal/server/routes/', head: 'abcdef1', enqueued_at: iso(-600000), place: 1 }],
        history: [
            { id: 5, agent: 'UI/UX', task: 14825, note: 'launch notice suite', cmd: 'node run_cdp_suites.mjs launch_notice', head: 'ebbee88', machine: 'Mac', granted_at: iso(-7200000), released_at: iso(-6900000), how: 'released', exit: 0, line: 'launch_notice_toast_clear_browser: ok', took_s: 300 },
            { id: 4, agent: 'Backend Dev', task: 14786, note: 'go test routes', cmd: 'go test -race ./internal/server/routes/', head: '2e45814', machine: 'Mac', granted_at: iso(-9000000), released_at: iso(-8700000), how: 'released', exit: 2, line: 'FAIL internal/server/routes 12.3s', took_s: 300 },
            { id: 3, agent: 'DevOps Engineer', note: 'batch run', machine: 'Mac', granted_at: iso(-12000000), released_at: iso(-11400000), how: 'expired', took_s: 600 }] },
    { name: 'mini', slots: 2, machine: 'Mini', max_lease_seconds: 3600, holders: [], queue: [] },
];
const STUB = `(() => { const real = window.fetch; window.__queueTickMs = 1000; window.__queue = ${JSON.stringify(QUEUE)};
    const J = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
    window.fetch = (u, o) => { const s = String(u), method = (o && o.method) || 'GET';
        if (method === 'GET' && /\\/api\\/resources$/.test(s)) return J({ resources: window.__queue });
        return real(u, o); }; })();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 400)); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const T = `#group-table-view`;
    const rowOf = agent => `[...document.querySelectorAll('${T} tbody tr.dt-row')].find(r => r.textContent.includes(${JSON.stringify(agent)}))`;
    const detailOf = agent => `(() => { const r = ${rowOf(agent)}; const d = r && r.nextElementSibling; return d && d.classList.contains('dt-detail') ? d : null; })()`;
    const visible = expr => ev(`(() => { const d = ${expr}; return !!d && !d.hidden && d.getClientRects().length > 0; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`window.__errs = []; addEventListener('error', e => window.__errs.push(String(e.message))); localStorage.clear(); window.openAutomationsFolder('queue'); true`);
            await waitFor(`!!(${rowOf('QA Engineer')}) && !!(${rowOf('Frontend Dev')})`, at + 'the holder and the waiting entry are listed', 10000);
            assert.equal(await visible(detailOf('QA Engineer')), false, at + 'the details are closed to begin with');

            // open the holder's details: by its chevron (a button) on a wide screen, by the row's ... menu on a phone
            if (!mobile) {
                const btn = `(${rowOf('QA Engineer')}).querySelector('button.queue-more')`;
                assert.equal(await ev(`${btn}.getAttribute('aria-expanded')`), 'false', at + 'the chevron says collapsed');
                assert.match(await ev(`${btn}.getAttribute('aria-label')`), /^Show details: QA Engineer, mac-heavy/, at + 'its name says what it opens');
                assert.equal(await ev(`${btn}.getAttribute('aria-controls') === (${detailOf('QA Engineer')}).id`), true, at + 'aria-controls names the detail row');
                await ev(`${btn}.focus(); ${btn}.click(); true`);
                await waitFor(`${btn}.getAttribute('aria-expanded') === 'true'`, at + 'the chevron says expanded', 5000);
                await waitFor(`document.activeElement && document.activeElement.classList.contains('queue-more')`, at + 'the keyboard is back on the chevron once the table is drawn again', 4000);
            } else {
                await ev(`(${rowOf('QA Engineer')}).querySelector('.dt-mail-more-toggle').click(); true`);
                await waitFor(`!!document.querySelector('.dt-mail-menu:not([hidden]) [role=menuitem]')`, at + "the row's menu opens", 5000);
                const items = await ev(`[...document.querySelectorAll('.dt-mail-menu:not([hidden]) [role=menuitem]')].map(b => b.textContent.trim())`);
                assert.ok(items.includes('Show details'), at + 'the menu offers Show details: ' + JSON.stringify(items));
                await ev(`[...document.querySelectorAll('.dt-mail-menu:not([hidden]) [role=menuitem]')].find(b => b.textContent.trim() === 'Show details').click(); true`);
            }
            await waitFor(`!!(${detailOf('QA Engineer')}) && !(${detailOf('QA Engineer')}).hidden`, at + 'the details open', 5000);
            const text = await ev(`(${detailOf('QA Engineer')}).innerText.replace(/\\s+/g, ' ')`);
            assert.ok(text.includes(LONG_NOTE), at + 'the whole note, not cut: ' + text.slice(0, 300));
            assert.ok(text.includes('npm --prefix tests/frontend run test:cloud'), at + 'the command: ' + text.slice(0, 300));
            assert.ok(text.includes('<b>not markup</b>'), at + 'a command is text, its tags are shown as typed');
            assert.equal(await ev(`(${detailOf('QA Engineer')}).querySelectorAll('b, a').length`), 0, at + 'no markup or link is built from a command');
            assert.match(text, /Head 6e00dcd5c36ca7f2/, at + 'the head');
            assert.match(text, /Computer Mac/, at + 'the computer');
            assert.match(text, /Expected 20 min/, at + 'the expected time');
            assert.match(text, /Running for \d+ min/, at + 'how long it has run');
            const fit = await ev(`(() => { const d = ${detailOf('QA Engineer')}; return { cell: d.scrollWidth <= d.clientWidth + 1, page: document.documentElement.scrollWidth <= innerWidth + 1 }; })()`);
            assert.ok(fit.cell && fit.page, at + 'a long command wraps inside the page: ' + JSON.stringify(fit));
            await shot(`queue-details-${w}`);

            // the waiting entry has its own details: command and head, no result
            if (!mobile) await ev(`(${rowOf('Frontend Dev')}).querySelector('button.queue-more').click(); true`);
            else { await ev(`(${rowOf('Frontend Dev')}).querySelector('.dt-mail-more-toggle').click(); true`); await waitFor(`!!document.querySelector('.dt-mail-menu:not([hidden]) [role=menuitem]')`, at + 'the second menu', 5000); await ev(`[...document.querySelectorAll('.dt-mail-menu:not([hidden]) [role=menuitem]')].find(b => b.textContent.trim() === 'Show details').click(); true`); }
            await waitFor(`!!(${detailOf('Frontend Dev')}) && !(${detailOf('Frontend Dev')}).hidden`, at + "the waiting entry's details open", 5000);
            assert.match(await ev(`(${detailOf('Frontend Dev')}).innerText.replace(/\\s+/g, ' ')`), /Command go test \.\/internal\/server\/routes\/.*Waiting since/, at + 'a waiting entry says what it will run and since when');

            // the finished runs: one button under the resource, then each run with how it ended
            assert.equal(await ev(`document.querySelectorAll('${T} tbody tr.dt-row').length`) >= 3, true, at + 'rows are there');
            assert.equal(await ev(`[...document.querySelectorAll('${T} tbody tr.dt-row')].some(r => /Passed, exit 0|Failed, exit 2/.test(r.textContent))`), false, at + 'the finished runs are not shown until asked for');
            const hist = `(${rowOf('3 finished runs')})`;
            assert.ok(await ev(`!!${hist}`), at + 'a row says 3 finished runs');
            if (!mobile) {
                assert.match(await ev(`${hist}.querySelector('button.queue-more').getAttribute('aria-label')`), /^Show the last 3 finished runs of mac-heavy/, at + 'its button names what it shows');
                await ev(`${hist}.querySelector('button.queue-more').click(); true`);
            } else {
                await ev(`${hist}.querySelector('.dt-mail-more-toggle').click(); true`); await waitFor(`!!document.querySelector('.dt-mail-menu:not([hidden]) [role=menuitem]')`, at + 'the history menu', 5000);
                await ev(`[...document.querySelectorAll('.dt-mail-menu:not([hidden]) [role=menuitem]')].find(b => /Show finished runs/.test(b.textContent)).click(); true`);
            }
            await waitFor(`/Passed, exit 0/.test(document.querySelector('${T}').textContent)`, at + 'the finished runs are listed', 5000);
            const all = await ev(`document.querySelector('${T}').innerText.replace(/\\s+/g, ' ')`);
            for (const word of ['Passed, exit 0', 'Failed, exit 2', 'No result recorded']) assert.ok(all.includes(word), at + `a finished run says "${word}" in words`);
            // a finished run's details: the result, its last line and how long it took
            if (!mobile) await ev(`(${rowOf('Backend Dev')}).querySelector('button.queue-more').click(); true`);
            else { await ev(`(${rowOf('Backend Dev')}).querySelector('.dt-mail-more-toggle').click(); true`); await waitFor(`!!document.querySelector('.dt-mail-menu:not([hidden]) [role=menuitem]')`, at + 'the finished row menu', 5000); await ev(`[...document.querySelectorAll('.dt-mail-menu:not([hidden]) [role=menuitem]')].find(b => b.textContent.trim() === 'Show details').click(); true`); }
            await waitFor(`!!(${detailOf('Backend Dev')}) && !(${detailOf('Backend Dev')}).hidden`, at + "a finished run's details open", 5000);
            const fin = await ev(`(${detailOf('Backend Dev')}).innerText.replace(/\\s+/g, ' ')`);
            assert.match(fin, /Result Failed, exit 2/, at + 'the result');
            assert.match(fin, /Last line FAIL internal\/server\/routes 12\.3s/, at + 'the last line');
            assert.match(fin, /Took 5 min/, at + 'how long it took');
            assert.match(fin, /Ended Released by the agent/, at + 'how it ended');
            // a finished run has no Move or Kick
            assert.equal(await ev(`(${rowOf('Backend Dev')}).querySelectorAll('.queue-act').length`), 0, at + 'a finished run offers no Kick or Move');
            await shot(`queue-history-${w}`);
            assert.deepEqual(await ev(`window.__errs`), [], at + 'no script error');
        }
        console.log('PASS the Queue folder shows what each run is: details, the finished runs and their results, text only, at 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
