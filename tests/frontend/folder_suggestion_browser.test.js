// The first agent and the first team start with a folder to say yes to (#11258 item 3, the phone NUX pass): the Folder field holds <home>/Coral/<name> with
// a line that Coral makes it when the launch is confirmed, and the launch asks for it (create_dir). A person with a recent folder is offered none, and a folder
// they typed is never made for them. The isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, N, openNewAgent, stubModels, scenarios } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { existing: recentsExist } = require('./helpers/recent_dirs');

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
        const dirState = (id, words = /Coral creates this folder/) => ev(`(() => { const i = document.getElementById(${JSON.stringify(id)}), n = document.getElementById(${JSON.stringify(id + '-suggest')}); return { value: i.value, note: !!n && !n.hidden && n.getClientRects().length > 0 && ${words}.test(n.textContent), text: n ? n.textContent : '', tip: n ? n.title : '', label: (document.querySelector('label[for=' + ${JSON.stringify(id)} + ']') || {}).textContent || '', described: (i.getAttribute('aria-describedby') || '').includes(${JSON.stringify(id + '-suggest')}) }; })()`);

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
            await recentsExist(ev); await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/tmp/earlier'])); true`);
            await openNewAgent(ev, waitFor);
            const s = await dirState('launch-dir');
            assert.ok(!/first-agent/.test(s.value) && !s.note, 'no folder is chosen for them: ' + JSON.stringify(s));
        });
        await S.run('New team: the folder is ~/Coral/first-team with the same line', async () => {
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`);
            await clearRecents();
            await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('team'); return true; })()`);
            await waitFor(`!!document.getElementById('launch-team-dir') && document.getElementById('launch-team-dir').getClientRects().length > 0`, 'New team step 1', 8000);
            const s = await dirState('launch-team-dir', /Coral creates it for you/);
            assert.ok(/[\\/]Coral[\\/]first-team$/.test(s.value) && s.note && s.described, JSON.stringify(s));
            // #11865: the folder is said with ~ for the home folder (the user name is not the first thing read), the whole path is the tooltip, and the words say what the folder is for
            const win = /^[A-Za-z]:|\\/.test(s.value); // a Windows home: the path as the field holds it, ~ is not a convention there (the Operator's rule, v2.0.29)
            assert.equal(s.text, `${win ? s.value : '~/Coral/first-team'}. The team's agents work in this folder. Coral creates it for you. Choose another folder to work on a project you already have.`, JSON.stringify(s));
            // the rule itself, on any computer: ~ on a POSIX home, the real path on a Windows one
            assert.deepEqual(await ev(`import((window.__coralStatic || '/static/') + 'folder_suggestion.js').then(m => [m.tildeFolder('/Users/pat', '/Users/pat/Coral/x'), m.tildeFolder('C:\\\\Users\\\\Pat', 'C:\\\\Users\\\\Pat\\\\Coral\\\\x'), m.tildeFolder('', '/a/b'), m.tildeFolder('/Users/pat', '/work/other')])`), ['~/Coral/x', 'C:\\Users\\Pat\\Coral\\x', '/a/b', '/work/other'], 'the tilde form is for POSIX homes only');
            assert.equal(s.tip, s.value, 'the whole path is the tooltip');
            assert.match(s.label, /^Folder for this team/, 'the field is named for what it is: ' + s.label);
        });
        // #13510: on the Windows runner the note held "D:\\a\\_temp\\coral-cdp-...": a backslash path has no place to break, so at 390 px and 200% text it ran past the dialog and was cut
        // (phone_targets_census_b failed its first attempt on it). The note wraps anywhere in a long path. Checked with a path of that shape on any computer.
        await S.run('New team: a long Windows path in the note wraps inside the dialog (390 px, 200% text)', async () => {
            await client.Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
            await ev(`document.documentElement.style.fontSize = '200%'; true`);
            const r = await ev(`(() => { const n = document.getElementById('launch-team-dir-suggest'); n.hidden = false; const bs = String.fromCharCode(92);
                n.textContent = '/private/tmp/coral-test-qa-engineer/D:' + bs + 'a' + bs + '_temp/coral-cdp-8RYiBH/shard1/home/Coral/first-team. The team' + String.fromCharCode(39) + 's agents work in this folder. Coral creates it for you.'; // the path a run under a Windows-named temp folder drew: 'D:' + backslashes in a long path, which Chrome will not break (48 px past the dialog at 200% text)
                const box = n.getBoundingClientRect(), up = n.parentElement.getBoundingClientRect();
                return { shown: n.getClientRects().length > 0, w: n.clientWidth, sw: n.scrollWidth, over: n.scrollWidth - n.clientWidth, right: Math.round(box.right), parentRight: Math.round(up.right), vw: innerWidth, fs: getComputedStyle(n).fontSize, ow: getComputedStyle(n).overflowWrap }; })()`);
            console.log('note at 390 px, 200% text: ' + JSON.stringify(r));
            await client.Emulation.clearDeviceMetricsOverride(); await ev(`document.documentElement.style.fontSize = ''; true`);
            assert.ok(r.shown && r.w > 100, 'the note is on screen (a hidden note would pass for nothing): ' + JSON.stringify(r));
            assert.ok(r.over <= 1 && r.right <= r.parentRight + 1, 'the note stays inside its dialog: ' + JSON.stringify(r));
        });
        S.finish();
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
