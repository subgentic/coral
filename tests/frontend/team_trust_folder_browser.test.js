// New team trusts the folder (#11889, the Operator's decision, Security's conditions): a folder Coral makes says "Coral will start these agents in this folder and trust it for them."; an existing folder shows
// a "Trust this folder" switch, off, that names the path, and only a ticked one sends trust_folder. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(async () => { window.__teamLaunches = [];
            const real = window.fetch; const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href), m = o.method || 'GET';
                if (p.pathname === '/api/sessions/launch-team' && m === 'POST') { window.__teamLaunches.push(JSON.parse(o.body)); return json({ agents: [{ name: 'A', session_id: 's' }], ...(window.__trustAnswer ? { trust_folder: window.__trustAnswer } : {}) }); }
                if (p.pathname === '/api/filesystem/trust-probe') {
                    window.__probePath = p.searchParams.get('path');
                    const body = window.__probeMode === 'clean' ? { checked:true, files:{'.claude/settings.json':false,'.claude/settings.local.json':false,'.mcp.json':false,'.codex/config.toml':false} }
                        : window.__probeMode === 'config' ? { checked:true, files:{'.claude/settings.json':true,'.claude/settings.local.json':false,'.mcp.json':false,'.codex/config.toml':false} } : {checked:false};
                    if(window.__probeMode==='hold') return new Promise(resolve=>{window.__trustProbeRelease=()=>resolve(Response.json({checked:true,files:{'.claude/settings.json':false,'.claude/settings.local.json':false,'.mcp.json':false,'.codex/config.toml':false}}));});
                    return json(body);
                }
                if (p.pathname === '/api/filesystem/list') { window.__listed = (window.__listed || 0) + 1; return p.searchParams.get('path') === '/home/p/Coral/exists' && !window.__hideExists ? json({ entries: [] }) : json({ error: 'not found' }, 404); }
                if (p.pathname === '/api/board/projects') return json([]);
                return real(u, o); };
            await window.showLaunchModal(); window.hideLaunchModal(); })(); true`);
        const open = async () => {
            await ev(`window.showLaunchModal(); window._selectLaunchType('team'); true`);
            await waitFor(`!!document.getElementById('launch-step-team') && getComputedStyle(document.getElementById('launch-step-team')).display !== 'none' && document.querySelectorAll('#team-template-select option').length > 1`, 'the team step');
        };
        const setDir = async (value, suggested) => {
            const before = await ev(`window.__listed || 0`);
            await ev(`{ const d = document.getElementById('launch-team-dir'); d.value = ${JSON.stringify(value)}; ${suggested ? `d.dataset.suggested = ${JSON.stringify(value)};` : `delete d.dataset.suggested;`} d.dispatchEvent(new Event('input', { bubbles: true })); } true`);
            if (suggested) await waitFor(`(window.__listed || 0) > ${before}`, 'the folder was looked up');
            await ev(`new Promise(r => setTimeout(r, 120))`); // sleep-ok: the answer is applied in the next task
        };
        const rowHidden = id => ev(`(document.getElementById(${JSON.stringify(id)}) || document.getElementById('launch-team-trust-line'))?.closest('.sv-row')?.hidden`);
        const visible = id => ev(`{ const r = document.getElementById(${JSON.stringify(id)})?.closest('.sv-row'); !!r && !r.hidden }`);
        const go = async () => {
            await ev(`{ const n = document.getElementById('team-board-name'); n.value = 'trust-' + (window.__teamLaunches.length + 1); n.dispatchEvent(new Event('input', { bubbles: true })); } true`);
            await ev(`document.querySelector('#launch-team-next').click(); true`);
            await ev(`document.querySelector('#launch-team-next').click(); true`);
            const before = await ev(`window.__teamLaunches.length`);
            await ev(`document.querySelector('#launch-team-go').click(); true`);
            await waitFor(`window.__teamLaunches.length === ${before + 1}`, 'the launch request');
            return ev(`window.__teamLaunches[window.__teamLaunches.length - 1]`);
        };

        console.log('A folder Coral makes says it will trust it, and has no switch');
        await open(); await setDir('/home/p/Coral/proj', true);
        assert.equal(await visible('launch-team-trust-line'), true, 'the line shows');
        assert.equal(await ev(`document.getElementById('launch-team-trust-line').textContent`), 'Coral will start these agents in this folder and trust it for them.');
        assert.equal(await visible('launch-team-trust'), false, 'no switch for a folder Coral makes');
        let sent = await go();
        assert.equal(sent.create_dir, true); assert.equal(sent.trust_folder, undefined, 'the made folder is trusted by the server, not asked for');
        await ev(`window.hideLaunchModal(); true`);

        console.log('An existing folder shows the switch, off, naming the path; unticked sends nothing, ticked sends trust_folder');
        await open(); await setDir('/home/p/Code/app', false);
        assert.equal(await visible('launch-team-trust'), true, 'the switch shows');
        assert.equal(await visible('launch-team-trust-line'), false, 'and the line does not');
        assert.equal(await ev(`document.getElementById('launch-team-trust').checked`), false, 'off by default');
        assert.match(await ev(`document.getElementById('launch-team-trust').closest('.sv-row').textContent`), /Trust this folder: its settings and tools can run/);
        assert.match(await ev(`document.getElementById('launch-team-trust').closest('.sv-row').textContent`), /\/home\/p\/Code\/app/, 'it names the path');
        assert.match(await ev(`document.getElementById('launch-team-trust').closest('.sv-row').textContent`), /Coral will not trust \/home\/p\/Code\/app unless this is on/, 'a typed folder says plainly that it is not trusted while the switch is off (#12413)');
        sent = await go();
        assert.equal(sent.trust_folder, undefined, 'unticked: nothing'); assert.equal(sent.create_dir, undefined);
        await ev(`window.hideLaunchModal(); true`);
        await open(); await setDir('/home/p/Code/app', false);
        await ev(`document.getElementById('launch-team-trust').click(); true`);
        { const t = await ev(`document.getElementById('launch-team-trust').closest('.sv-row').textContent`);
          assert.doesNotMatch(t, /will not trust/, 'ticked: the "will not trust" sentence is gone'); assert.match(t, /is trusted for the team's agents/, 'ticked: it says it is trusted'); }
        sent = await go();
        assert.equal(sent.trust_folder, true, 'ticked: the request says so');
        await ev(`window.hideLaunchModal(); true`);

        console.log('A suggested folder that is already there is not made by Coral: no line, the switch shows, and only a tick trusts it');
        await open(); await setDir('/home/p/Coral/exists', true);
        assert.equal(await visible('launch-team-trust-line'), false, 'the line "Coral will ... trust it for them" is gone');
        assert.equal(await visible('launch-team-trust'), true, 'the switch shows for it');
        sent = await go();
        assert.equal(sent.trust_folder, undefined, 'unticked: nothing is trusted');
        await ev(`window.hideLaunchModal(); true`);
        await open(); await setDir('/home/p/Coral/exists', true);
        await ev(`document.getElementById('launch-team-trust').click(); true`);
        sent = await go();
        assert.equal(sent.trust_folder, true, 'ticked: trusted');
        await ev(`window.hideLaunchModal(); true`);

        console.log('A tick for one folder is gone when the folder is another, even when the dialog is opened again');
        await open(); await setDir('/home/p/Code/app', false);
        await ev(`document.getElementById('launch-team-trust').click(); true`);
        await setDir('/home/p/Code/other', false);
        assert.equal(await ev(`document.getElementById('launch-team-trust').checked`), false, 'the switch went back to off for the other folder');
        sent = await go();
        assert.equal(sent.trust_folder, undefined, 'and nothing is trusted');
        await ev(`window.hideLaunchModal(); true`);

        console.log('A switch that is on without the person having ticked it for this folder, or that is hidden, sends nothing');
        await open(); await setDir('/home/p/Code/app', false);
        await ev(`document.getElementById('launch-team-trust').checked = true; true`); // on, with no change event: not the person's tick for this folder
        sent = await go();
        assert.equal(sent.trust_folder, undefined, 'a switch no tick put on is not a request');
        await ev(`window.hideLaunchModal(); true`);
        await open(); await setDir('/home/p/Coral/fresh', true);
        await ev(`document.getElementById('launch-team-trust').checked = true; true`); // hidden for a folder Coral makes
        sent = await go();
        assert.equal(sent.trust_folder, undefined, 'a hidden switch is not a request');
        await ev(`window.hideLaunchModal(); true`);

        console.log('A tick that was made while the switch showed is not sent once the switch is hidden for the same folder');
        await open(); await setDir('/home/p/Coral/exists', true);
        await ev(`document.getElementById('launch-team-trust').click(); true`);
        await ev(`window.__hideExists = true; true`); // the folder is gone: Coral would make it now, and the row goes
        const calls = await ev(`window.__listed`);
        await ev(`document.getElementById('launch-team-dir').dispatchEvent(new Event('input', { bubbles: true })); true`);
        await waitFor(`window.__listed > ${calls}`, 'the folder was looked up again');
        await ev(`new Promise(r => setTimeout(r, 120))`); // sleep-ok: the answer is applied in the next task
        assert.equal(await visible('launch-team-trust'), false, 'the switch is hidden again');
        assert.equal(await ev(`document.getElementById('launch-team-trust').checked`), true, 'still on underneath');
        sent = await go();
        assert.equal(sent.trust_folder, undefined, 'a hidden switch sends nothing, even on for this folder');
        await ev(`window.__hideExists = false; window.hideLaunchModal(); true`);

        console.log('Changing the folder to one Coral makes takes the switch away and does not send a stale tick');
        await open(); await setDir('/home/p/Code/app', false);
        await ev(`document.getElementById('launch-team-trust').click(); true`);
        await setDir('/home/p/Coral/proj2', true);
        assert.equal(await visible('launch-team-trust'), false);
        sent = await go();
        assert.equal(sent.trust_folder, undefined, 'a tick for another folder is not sent'); assert.equal(sent.create_dir, true);

        // #12338: what the person ticked and Coral did not do is said, in the server's own words, when the launch answers (a folder in /tmp is refused by design; nothing said so)
        console.log('A tick the server refused is said after the launch');
        await open(); await setDir('/home/p/Code/app', false);
        await ev(`document.getElementById('launch-team-trust').click(); true`);
        await ev(`window.__trustAnswer = { path: '/home/p/Code/app', trusted: [], refused: 'a folder in a shared place (/private/tmp) is never trusted: anyone on the computer can write into it' }; true`);
        sent = await go();
        assert.equal(sent.trust_folder, true);
        await waitFor(`[...document.querySelectorAll('.toast-message')].some(t => /Trust this folder was not applied: a folder in a shared place/.test(t.textContent))`, 'the refusal said in a toast');
        // #12532: no settings file yet is a first-time user, not an error: plain guidance that says what it means and what to do from the chat (no terminal), and not a red toast
        await ev(`window.__trustAnswer = { path: '/home/p/Code/app', trusted: ['codex'], no_settings: ['claude'], not: { claude: 'the agent\\'s settings file is not there yet' } }; window.hideLaunchModal(); true`);
        await open(); await setDir('/home/p/Code/app', false);
        await ev(`document.getElementById('launch-team-trust').click(); true`);
        await go();
        await waitFor(`[...document.querySelectorAll('.toast-message')].some(t => /Claude has no settings file on this computer yet/.test(t.textContent))`, 'the first-time guidance in a toast');
        const guide = await ev(`(() => { const t = [...document.querySelectorAll('.toast')].find(x => /has no settings file/.test(x.textContent)); return t ? { error: t.classList.contains('error'), text: t.textContent } : null; })()`);
        assert.equal(guide.error, false, 'guidance, not an error toast');
        assert.match(guide.text, /normal/, 'it says this is normal');
        assert.match(guide.text, /agent's chat/, 'it says what to do, from the chat');
        assert.doesNotMatch(guide.text, /terminal|was not applied/i, 'no terminal to go to, and not worded as a failure');
        await ev(`window.__trustAnswer = { path: '/home/p/Code/app', trusted: ['codex'], failed: { claude: 'the agent\\'s settings file is a link' }, not: { claude: 'the agent\\'s settings file is a link' } }; window.hideLaunchModal(); true`);

        await open(); await setDir('/home/p/Code/app', false);
        await ev(`document.getElementById('launch-team-trust').click(); true`);
        await go();
        await waitFor(`[...document.querySelectorAll('.toast-message')].some(t => /Trust this folder was not applied for claude: the agent's settings file is a link/.test(t.textContent))`, 'a real failure for one agent type is still said in a toast');
        await ev(`window.__trustAnswer = null; window.hideLaunchModal(); true`);
        console.log('A person-chosen checked folder defaults on, with an opt-out and a path-bound wire tick');
        const choose = async (folder, mode) => {
            await open();
            await ev(`(()=>{window.__probeMode=${JSON.stringify(mode)};window.__probePath='';const d=document.getElementById('launch-team-dir');delete d.dataset.suggested;d.value='';d.focus();return true;})()`);
            await client.Input.insertText({text:folder});
            await waitFor(`window.__probePath===${JSON.stringify(folder)}`,'one debounced project-config check');
        };
        await choose('/home/p/Code/clean','clean');
        await waitFor(`document.getElementById('launch-team-trust').checked`,'clean chosen folder defaults on');
        assert.match(await ev(`document.getElementById('launch-team-trust').closest('.sv-row').textContent`), /Untick/);
        sent = await go(); assert.equal(sent.trust_folder,true,'default tick reaches the existing server contract');
        await ev(`window.hideLaunchModal();true`);
        await choose('/home/p/Code/clean','clean');
        await waitFor(`document.getElementById('launch-team-trust').checked`,'default ready before opt-out');
        await ev(`document.getElementById('launch-team-trust').click();true`);
        sent = await go(); assert.equal(sent.trust_folder,undefined,'unticking omits the opt-in wire field');
        await ev(`window.hideLaunchModal();true`);
        await choose('/home/p/Code/config','config');
        await waitFor(`/this folder has its own settings/i.test(document.getElementById('launch-team-trust').closest('.sv-row').textContent)`,'project configuration is named');
        assert.equal(await ev(`document.getElementById('launch-team-trust').checked`),false,'existing project settings require an explicit tick');
        assert.match(await ev(`document.getElementById('launch-team-trust').closest('.sv-row').textContent`), /\.claude\/settings\.json/);
        await ev(`window.hideLaunchModal();true`);
        await choose('/home/p/Code/unchecked','unchecked');
        await waitFor(`/could not be checked/.test(document.getElementById('launch-team-trust').closest('.sv-row').textContent)`,'failed check is explained');
        assert.equal(await ev(`document.getElementById('launch-team-trust').checked`),false,'unchecked stays off');
        await ev(`window.hideLaunchModal();true`);
        await choose('/home/p/Code/slow','hold');
        await waitFor(`!!window.__trustProbeRelease`,'old-folder probe held');
        await setDir('/home/p/Code/other-after-probe',false);
        await ev(`window.__trustProbeRelease();true`);
        await waitFor(`document.getElementById('launch-team-dir').value==='/home/p/Code/other-after-probe'`,'changed folder remains');
        assert.equal(await ev(`document.getElementById('launch-team-trust').checked`),false,'late safe-folder reply cannot trust a different folder');
        await ev(`window.hideLaunchModal();true`);


        console.log('A scripted or remembered folder never receives the default trust tick');
        await open();
        await ev(`window.__probeMode='clean';window.__probePath='';true`);
        await setDir('/home/p/Code/scripted',false);
        await ev(`new Promise(resolve=>setTimeout(resolve,650))`); // sleep-ok: negative authorization assertion must outlast the 400 ms trust-default debounce
        assert.equal(await ev(`document.getElementById('launch-team-trust').checked`),false,'an untrusted input event without trustChosen cannot auto-tick trust');
        assert.equal(await ev(`window.__probePath`),'','a scripted folder never even requests default-trust advice');
        sent = await go(); assert.equal(sent.trust_folder,undefined,'scripted input sends no trust opt-in');
        await ev(`window.hideLaunchModal();true`);
        await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{window.__oldTrustDefault=state.settings.default_working_dir;state.settings.default_working_dir='/home/p/Code/remembered';window.__probeMode='clean';window.__probePath='';})`);
        await open();
        await waitFor(`document.getElementById('launch-team-dir').value==='/home/p/Code/remembered'`,'remembered Settings folder is restored');
        // Restored inputs can dispatch an untrusted event to update their hints.
        await ev(`document.getElementById('launch-team-dir').dispatchEvent(new Event('input',{bubbles:true}));true`);
        await ev(`new Promise(resolve=>setTimeout(resolve,650))`); // sleep-ok: the remembered-folder refusal must survive the deferred default check
        assert.equal(await ev(`document.getElementById('launch-team-trust').checked`),false,'a remembered default remains off until the person explicitly ticks it');
        assert.equal(await ev(`window.__probePath`),'','a remembered folder is not treated as a new folder choice');
        sent = await go(); assert.equal(sent.trust_folder,undefined,'remembered folder sends no trust opt-in');
        await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>{if(window.__oldTrustDefault===undefined)delete state.settings.default_working_dir;else state.settings.default_working_dir=window.__oldTrustDefault;window.hideLaunchModal();})`);

    } finally { await removeBoards(ev, Array.from({ length: 20 }, (_, i) => 'trust-' + (i + 1))); await client.close(); }
    console.log('team_trust_folder_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
