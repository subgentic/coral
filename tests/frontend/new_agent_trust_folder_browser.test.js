// New agent: a "Trust this folder" tick that sends trust_folder, as the team launch does (#19216, QA's SHOULD on #19176). #19176 lets a launch trust an existing folder the person ticked, but the
// New agent form had no tick, so only a folder Coral made was trusted. The tick is off by default, names the folder it is for (another folder goes back to off), and Launch sends trust_folder only while it is on.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { connect } = require('./agent_view_harness');
const { install: installNA, openNewAgent, stubModels, scenarios } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const S = scenarios();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coral-19216-'));
    const one = path.join(root, 'one'), two = path.join(root, 'two'); fs.mkdirSync(one); fs.mkdirSync(two);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev); await stubModels(ev);
        await ev(`(() => { window.__posts = []; const R = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.origin).pathname;
            if (o.method === 'POST' && p === '/api/sessions/launch') { window.__posts.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify({ error: 'stopped by the test' }), { status: 500, headers: { 'Content-Type': 'application/json' } })); }
            return R(u, o); }; return true; })()`);
        const fill = v => ev(`(() => { const i = document.getElementById('launch-dir'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        const open = async dir => {
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); for (const k of Object.keys(localStorage)) if (/recent/i.test(k)) localStorage.removeItem(k); window.__posts.length = 0; true`);
            await openNewAgent(ev, waitFor); await fill(dir);
        };
        const tick = () => ev(`(() => { const t = document.getElementById('launch-agent-trust'), r = document.getElementById('launch-agent-trust-row'); return { there: !!t, shown: !!r && !r.hidden, on: !!t && t.checked, help: r ? r.textContent : '' }; })()`);
        const click = () => ev(`(() => { const t = document.getElementById('launch-agent-trust'); t.click(); return t.checked; })()`);
        const next = () => ev(`(() => { const b = window.__na.find('button', /^(Next|Choose model)$/i); if (b) b.click(); return !!b; })()`);
        const stage = () => ev(`document.getElementById('launch-step-agent').dataset.stage`);
        const launch = async () => {
            for (let i = 0; i < 3 && (await stage()) !== 'agent'; i++) { await next(); await new Promise(r => setTimeout(r, 300)); } // sleep-ok: a step change has no event to wait on in the harness
            await ev(`(() => { const b = window.__na.find('button', /^Launch$/i); if (b) b.click(); return !!b; })()`);
            await waitFor(`window.__posts.length > 0`, 'the launch request', 8000);
            return ev(`window.__posts[0]`);
        };

        await S.run('an existing folder shows the tick, off, and Launch without it does not ask for trust', async () => {
            await open(one);
            await waitFor(`!!document.getElementById('launch-agent-trust-row') && !document.getElementById('launch-agent-trust-row').hidden`, 'the tick', 6000);
            const t = await tick();
            assert.equal(t.on, false, 'off by default: ' + JSON.stringify(t));
            assert.ok(/Coral will not trust .*one unless this is on/.test(t.help), 'off says what that means: ' + t.help);
            const b = await launch();
            assert.ok(!('trust_folder' in b), 'no trust_folder: ' + JSON.stringify(b));
        });
        await S.run('ticked, Launch sends trust_folder', async () => {
            await open(one);
            await waitFor(`!!document.getElementById('launch-agent-trust-row') && !document.getElementById('launch-agent-trust-row').hidden`, 'the tick', 6000);
            assert.equal(await click(), true);
            assert.ok(/will be trusted/.test((await tick()).help), 'on says it is trusted');
            const b = await launch();
            assert.equal(b.trust_folder, true, 'the launch asks for trust: ' + JSON.stringify(b));
            assert.equal(b.working_dir, one);
        });
        await S.run('a tick is for one folder: another folder goes back to off and sends nothing', async () => {
            await open(one);
            await waitFor(`!!document.getElementById('launch-agent-trust-row') && !document.getElementById('launch-agent-trust-row').hidden`, 'the tick', 6000);
            await click(); await fill(two);
            await waitFor(`!document.getElementById('launch-agent-trust').checked`, 'the tick goes off with the folder', 4000);
            const b = await launch();
            assert.equal(b.working_dir, two);
            assert.ok(!('trust_folder' in b), 'the other folder is not trusted: ' + JSON.stringify(b));
        });
        S.finish();
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} await client.close(); }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
