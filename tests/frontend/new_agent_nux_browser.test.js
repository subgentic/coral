// The New agent wizard for a new user, on a desktop (#11289, QA Engineer's walkthrough #11256), at 1440 px with the keyboard and the mouse:
//  1. Escape in the Browse folder picker closes the picker only; a second Escape closes the dialog.
//  2. Enter in a single-line field is the step's primary button: the folder's Enter goes to the persona, the persona's name field's Enter goes to the agent step (and where Launch is the primary button, it launches); Enter in a multi-line field is a new line, not Next.
//  3. The first step says there is a team to make ("Start a team instead"), a click goes to the team form; New agent from the sidebar opens the chooser with New agent and New project as equals.
//  4. An agent whose name is left empty is offered a role-like name (Agent 1, then the next number not taken), not the folder's; a name typed is kept.
// Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const settle = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the dialog redraws over a frame or two after a key
    const press = async (key, vk, extra = {}) => { await Input.dispatchKeyEvent({ type: key === 'Enter' ? 'keyDown' : 'rawKeyDown', key, code: key, windowsVirtualKeyCode: vk, ...(key === 'Enter' ? { text: '\r' } : {}), ...extra }); await Input.dispatchKeyEvent({ type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk, ...extra }); await settle(300); };
    const type = async text => { await Input.insertText({ text }); await settle(150); };
    const stage = () => ev(`document.getElementById('launch-step-agent').dataset.stage`);
    const modalOpen = () => ev(`getComputedStyle(document.getElementById('launch-modal')).display !== 'none'`);
    const pickerOpen = () => ev(`(() => { const p = document.getElementById('dir-browser'); return !!p && p.style.display !== 'none' && p.getClientRects().length > 0; })()`);
    const stepsShown = () => ev(`['chooser', 'agent', 'team'].filter(s => { const e = document.getElementById('launch-step-' + s); return e && e.style.display !== 'none' && e.getClientRects().length; })`);
    const openAgent = async () => { await ev(`window.showLaunchModal(); window._selectLaunchType('agent'); true`); await waitFor(`document.getElementById('launch-dir') && document.getElementById('launch-dir').getClientRects().length > 0`, 'the folder step', 8000); };
    const close = async () => { await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`); await settle(200); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);

        // 1. Escape in Browse
        await openAgent();
        await ev(`document.getElementById('btn-browse').click(); true`);
        await waitFor(`(() => { const p = document.getElementById('dir-browser'); return !!p && p.style.display !== 'none' && p.getClientRects().length > 0; })()`, 'the Browse picker', 8000);
        await press('Escape', 27);
        assert.equal(await pickerOpen(), false, 'Escape closes the picker');
        assert.equal(await modalOpen(), true, 'Escape in Browse leaves the dialog open');
        assert.equal(await ev(`document.activeElement.id`), 'btn-browse', 'the focus goes back to Browse');
        await press('Escape', 27);
        assert.equal(await modalOpen(), false, 'a second Escape closes the dialog');

        // 2. Enter advances
        await openAgent();
        await ev(`document.getElementById('launch-dir').focus(); true`);
        await type('/tmp'); await press('Enter', 13);
        assert.equal(await stage(), 'persona', 'Enter in the folder goes to the persona step');
        await ev(`document.getElementById('launch-agent-name-input').focus(); true`);
        await press('Enter', 13);
        assert.equal(await stage(), 'agent', 'Enter in the persona step\'s name field goes to the agent step');
        // the persona's prompt is multi-line: its Enter is a new line, not Next
        await ev(`document.querySelector('#launch-step-agent [data-launch-stage-go="persona"], #launch-step-agent .launch-stage-tab[data-stage="persona"]')?.click(); true`);
        await ev(`window._launchStage('persona'); true`); await settle(300);
        const ta = await ev(`(() => { const t = [...document.querySelectorAll('#launch-step-agent textarea')].find(e => e.getClientRects().length); if (!t) return false; t.focus(); return true; })()`);
        if (ta) { await press('Enter', 13); assert.equal(await stage(), 'persona', 'Enter in a multi-line field does not advance'); }
        await close();

        // 3. the way to a team
        await openAgent();
        const link = await ev(`(() => { const p = document.getElementById('launch-team-instead'); const b = p && p.querySelector('button'); return { shown: !!p && !p.hidden && p.getClientRects().length > 0, text: b ? b.textContent.trim() : null }; })()`);
        assert.deepEqual(link, { shown: true, text: 'Start a team instead' }, 'the first step offers a team: ' + JSON.stringify(link));
        await ev(`document.querySelector('#launch-team-instead button').click(); true`); await settle(500);
        assert.deepEqual(await stepsShown(), ['team'], 'a click on it opens the team form');
        await close();
        await ev(`document.querySelector('.sidebar-new-btn-full').click(); true`); await settle(500);
        assert.deepEqual(await stepsShown(), ['chooser'], 'New agent opens the chooser');
        const choices = await ev(`document.getElementById('launch-step-chooser').innerText.replace(/\\s+/g, ' ')`);
        assert.ok(/New agent/.test(choices) && /New project/.test(choices), 'New agent and New project are both on the chooser: ' + choices);
        await close();

        // 4. a role-like name
        await ev(`for (const n of ['Agent 1', 'shop-app']) window.__m.add(n, 'A', 2, { sleeping: false, session_id: n + '-id' }); true`);
        await waitFor(`(window.__qaState.liveSessions || []).length >= 2`, 'two agents', 8000).catch(() => {});
        await openAgent();
        await ev(`document.getElementById('launch-dir').focus(); true`); await type('/tmp/shop-app'); await press('Enter', 13);
        const field = await ev(`({ value: document.getElementById('launch-agent-name-input').value, placeholder: document.getElementById('launch-agent-name-input').placeholder })`);
        const name = field.placeholder;
        assert.equal(field.value, '', 'the suggestion is a placeholder, not a value: Save as persona still needs a typed name');
        assert.match(name, /^Agent \d+$/, 'an empty name is offered a role-like one, not the folder\'s: ' + JSON.stringify(name));
        assert.notEqual(name, 'Agent 1', 'the number is not one a live agent has');
        await ev(`window._launchStage('folder'); true`); await settle(200);
        await ev(`const i = document.getElementById('launch-agent-name-input'); i.value = 'Reviewer'; i.dispatchEvent(new Event('input', { bubbles: true })); true`);
        await ev(`window._launchStage('persona'); true`); await settle(200);
        assert.equal(await ev(`document.getElementById('launch-agent-name-input').value`), 'Reviewer', 'a name typed is kept');
        await close();
        // the suggestion is what the agent is called when the field stays empty
        await openAgent();
        await ev(`document.getElementById('launch-dir').focus(); true`); await type('/tmp/nux-11289-agent'); await press('Enter', 13);
        const suggested = await ev(`document.getElementById('launch-agent-name-input').placeholder`);
        await ev(`window.__launchBodies = []; const f = window.fetch; window.fetch = (u, o) => { if (/\\/api\\/sessions\\/launch\\b/.test(String(u && u.url || u)) && o && o.body) window.__launchBodies.push(String(o.body)); return f.call(window, u, o); }; window.launchSession(); true`);
        await waitFor(`window.__launchBodies.length > 0`, 'the launch request', 10000);
        assert.equal(JSON.parse(await ev(`window.__launchBodies[0]`)).display_name, suggested, 'the agent is launched under the suggestion when the field is empty, not the folder\'s name');
        console.log('PASS New agent wizard: Escape closes the picker only, Enter advances, the team is one click from the first step, an agent is offered a role-like name');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
