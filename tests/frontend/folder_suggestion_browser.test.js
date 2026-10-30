// The first agent and the first team start with a folder to say yes to (#11258 item 3, the phone NUX pass): the Folder field holds <home>/Coral/<name> with
// a line that Coral makes it when the launch is confirmed, and the launch asks for it (create_dir). A person with a recent folder is offered none, and a folder
// they typed is never made for them. The isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, N, openNewAgent, stubModels, scenarios } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const S = scenarios();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev); await stubModels(ev);
        // Every launch the page sends is kept and answered with a folder error, so no agent starts.
        await ev(`(() => { window.__posts = []; const R = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.origin).pathname;
            if (o.method === 'POST' && (p === '/api/sessions/launch' || p === '/api/sessions/launch-team')) { window.__posts.push({ p, body: JSON.parse(o.body) }); return Promise.resolve(new Response(JSON.stringify({ error: 'stopped by the test', field: 'working_dir' }), { status: 400, headers: { 'Content-Type': 'application/json' } })); }
            return R(u, o); }; return true; })()`);
        const clearRecents = () => ev(`(() => { for (const k of Object.keys(localStorage)) if (/recent/i.test(k)) localStorage.removeItem(k); return true; })()`);
        const dirState = id => ev(`(() => { const i = document.getElementById(${JSON.stringify(id)}), n = document.getElementById(${JSON.stringify(id + '-suggest')}); return { value: i.value, note: !!n && !n.hidden && n.getClientRects().length > 0 && /Coral creates this folder/.test(n.textContent), described: (i.getAttribute('aria-describedby') || '').includes(${JSON.stringify(id + '-suggest')}) }; })()`);

        await S.run('New agent with no recent folder: the field is ~/Coral/first-agent and a line says Coral makes it', async () => {
            await clearRecents(); await openNewAgent(ev, waitFor);
            const s = await dirState('launch-dir');
            assert.ok(/[\\/]Coral[\\/]first-agent$/.test(s.value), 'the folder is suggested: ' + JSON.stringify(s));
            assert.ok(s.note && s.described, 'a line says Coral will create it, and the field is described by it: ' + JSON.stringify(s));
        });
        await S.run('a folder the person types takes the line away, and the launch does not ask Coral to make it', async () => {
            await ev(`(() => { const i = document.getElementById('launch-dir'); i.value = '/tmp'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`document.getElementById('launch-dir-suggest').hidden`, 'the line goes', 4000);
            assert.equal((await dirState('launch-dir')).described, false, 'and leaves the field description');
        });
        await S.run('the launch of the suggested folder says create_dir', async () => {
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); (() => { const i = document.getElementById('launch-dir'); if (i) i.value = ''; return true; })()`); // the earlier scenario's typed folder is not kept
            await clearRecents(); await openNewAgent(ev, waitFor);
            await ev(`window.__posts.length = 0; true`);
            for (let i = 0; i < 3; i++) {
                const hit = await ev(`(() => { const b = window.__na.find('button', /^(Next|Launch)$/i); if (!b) return ''; const n = window.__na.name(b); b.click(); return n; })()`);
                if (/launch/i.test(hit)) break;
                await waitFor(`!!window.__na.find('button', /^(Next|Launch)$/i)`, 'the next step', 4000);
            }
            await waitFor(`window.__posts.length > 0`, 'the launch request', 8000);
            const b = await ev(`window.__posts[0].body`);
            assert.equal(b.create_dir, true, 'create_dir is sent: ' + JSON.stringify(b));
            assert.ok(/[\\/]Coral[\\/]first-agent$/.test(b.working_dir), 'for the suggested folder: ' + b.working_dir);
        });
        await S.run('with a recent folder there is no suggestion', async () => {
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`);
            await clearRecents();
            await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/tmp/earlier'])); true`);
            await openNewAgent(ev, waitFor);
            const s = await dirState('launch-dir');
            assert.ok(!/first-agent/.test(s.value) && !s.note, 'no folder is chosen for them: ' + JSON.stringify(s));
        });
        await S.run('New team: the folder is ~/Coral/first-team with the same line', async () => {
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`);
            await clearRecents();
            await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('team'); return true; })()`);
            await waitFor(`!!document.getElementById('launch-team-dir') && document.getElementById('launch-team-dir').getClientRects().length > 0`, 'New team step 1', 8000);
            const s = await dirState('launch-team-dir');
            assert.ok(/[\\/]Coral[\\/]first-team$/.test(s.value) && s.note && s.described, JSON.stringify(s));
        });
        S.finish();
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
