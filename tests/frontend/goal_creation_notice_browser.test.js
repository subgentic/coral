// #16372: a persisted board notice is not proof that a stopped Orchestrator can read a new goal now.
// Drives the real editor submit, with only subscribers/create responses stubbed. Desktop/phone, real light/dark.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const { coralReady, nextFrame } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const STUB = `(() => {
    const inner = window.fetch;
    const json = b => Promise.resolve(new Response(JSON.stringify(b), {status: 200, headers: {'Content-Type':'application/json'}}));
    window.__goalResult = {}; window.__goalPosts = [];
    window.fetch = (u, o = {}) => {
        const p = new URL(String(u && u.url || u), location.href).pathname;
        if (p === '/api/board/notice-team/subscribers') return json([{subscriber_id:'Lead', job_title:'Orchestrator', session_name:'claude-lead'}]);
        if (p === '/api/board/notice-team/goals' && o.method === 'POST') {
            window.__goalPosts.push(JSON.parse(o.body)); return json({id: 77, ...window.__goalResult});
        }
        return inner(u, o);
    };
})();`;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({source: PRELOAD});
        await Page.addScriptToEvaluateOnNewDocument({source: STUB});
        for (const width of [1440, 390]) for (const theme of ['dark', 'light']) {
            const tag = `${width}-${theme}`;
            await Emulation.setDeviceMetricsOverride({width, height: 900, deviceScaleFactor: 1, mobile: width === 390});
            await Emulation.setTouchEmulationEnabled({enabled: width === 390});
            await Page.navigate({url: BASE + '/'}); await Page.loadEventFired(); await install(); await coralReady(ev);
            await setTheme(ev, theme);
            for (const [name, result, told] of [
                ['stopped', {orchestrator_told_at:'2026-11-17T00:00:00Z', orchestrator_waiting:true}, false],
                ['running', {orchestrator_told_at:'2026-11-17T00:00:00Z', orchestrator_waiting:false}, true],
                ['none', {}, false],
            ]) {
                await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); window.__goalResult = ${JSON.stringify(result)}; window.__created = null;
                    import((window.__coralStatic || '/static/') + 'goal_editor.js').then(m => m.openGoalEditor({project:'notice-team', onCreated:(p,told) => {window.__created = {p,told};}})); true`);
                await waitFor(`!!document.querySelector('#goal-new-title') && !document.querySelector('#goal-new-driver').disabled`, tag + ' editor', 8000);
                await ev(`document.querySelector('#goal-new-title').value = 'Make the phone flow clear'; document.querySelector('dialog.goal-editor form').requestSubmit(); true`);
                await waitFor(`window.__created !== null`, tag + ' created', 5000);
                const expected = told ? 'Goal created. The Orchestrator was told.' : 'Goal created. The Orchestrator will see it when it starts.';
                // Capture the old wording too, before reporting failures, so the before/after probe is identical.
                await nextFrame(ev);
                if (name === 'stopped' && process.env.CORAL_SCREENSHOT_DIR) {
                    fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, {recursive:true});
                    fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${tag}.png`, Buffer.from((await Page.captureScreenshot({format:'png'})).data, 'base64'));
                }
                const actual = await ev(`document.querySelector('#toast-host')?.textContent || ''`);
                if (!told && await ev(`(() => { const t = document.querySelector('.toast-message'); return !!t && t.scrollHeight > t.clientHeight + 1; })()`)) problems.push(`${tag} ${name}: delivery timing is clipped`);
                if (!actual.includes(expected)) problems.push(`${tag} ${name}: ${JSON.stringify(actual)}; expected ${expected}`);
                if (await ev('window.__created.told') !== told) problems.push(`${tag} ${name}: callback delivery state`);
                if (await ev('window.__created.p') !== 'notice-team') problems.push(`${tag} ${name}: wrong team`);
            }
            assert.equal(await ev('window.__goalPosts.length'), 3, tag + ' one create per submit');
        }
        assert.deepEqual(problems, [], problems.join('\n'));
        console.log('PASS new goals report whether the Orchestrator can read them now, including a stopped one with a notice timestamp');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
