// New agent's Reminders tab (#21169; the Operator approved the mock: "just a tab like permissions in step 3"): step 3 has a fourth tab, Reminders. A person adds a daily and a weekly reminder, edits one, removes
// one (asked once), the tab shows how many there are, and Launch saves what is left for the new session through POST /api/reminders, one request each, with this computer's time zone. A blank agent with none
// saves nothing, and a reminder the launch could not save is said in a toast. Launch and reminders are stubbed at the page's fetch; 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, N, openNewAgent, stubModels } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const click = async (sel, rx) => { assert.ok(await ev(`(() => { const e = window.__na.find(${JSON.stringify(sel)}, ${rx}); if (!e) return false; e.click(); return true; })()`), `no visible ${sel} named ${rx}`); };
    const tab = async name => { assert.ok(await ev(`(() => { const t = [...window.__na.dialog().querySelectorAll('[role=tab]')].find(x => window.__na.name(x).replace(/\d+$/, '') === ${JSON.stringify(name)}); if (!t) return false; t.click(); return true; })()`), `no tab ${name}`); await settle(250); };
    const R = '#launch-agent-acf [data-section="reminders"]';
    const set = (sel, value) => ev(`(() => { const e = document.querySelector(${JSON.stringify(R + ' ' + sel)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const press = label => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(R + ' button')})].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
    const cards = () => ev(`[...document.querySelectorAll(${JSON.stringify(R + ' .launch-rem-card')})].map(c => ({ when: c.querySelector('.launch-rem-top strong').textContent, text: c.querySelector('.launch-rem-text').textContent, from: c.querySelector('.launch-rem-from').textContent, chip: c.querySelector('.launch-rem-chip').textContent }))`);
    const count = () => ev(`document.querySelector('.settings-tab[data-section="reminders"] .launch-rem-count')?.textContent || ''`);
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installNA(ev);
        await stubModels(ev);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); window.__reqs = []; window.__remFail = false; (() => { const real = window.fetch, json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href), m = (o.method || 'GET').toUpperCase();
                if (m === 'POST' && p.pathname === '/api/sessions/launch') { window.__reqs.push({ path: p.pathname }); return json({ session_name: 'rem-agent', session_id: 'sid-rem', agent_type: 'claude' }); }
                if (m === 'POST' && p.pathname === '/api/reminders') { window.__reqs.push({ path: p.pathname, body: JSON.parse(o.body) }); return window.__remFail && window.__reqs.filter(r => r.path === '/api/reminders').length === 2 ? json({ error: 'no' }, 400) : json({ id: 'r' + window.__reqs.length }); }
                return real(u, o); }; })(); true`);
        const toStep3 = async () => {
            await openNewAgent(ev, waitFor).catch(() => {});
            await ev(`(() => { const i = window.__na.find('input', ${N.folder}); if (!i) return false; i.value = '/work/payments-app'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await click('button', N.next); await waitFor(`/Step 2 of 3/.test(window.__na.dialog().textContent)`, 'step 2', 4000);
            await click('button', N.next); await waitFor(`/Step 3 of 3/.test(window.__na.dialog().textContent)`, 'step 3', 4000);
        };
        await toStep3();
        const names = await ev(`[...window.__na.dialog().querySelectorAll('[role=tab]')].map(t => window.__na.name(t))`);
        check(JSON.stringify(names) === JSON.stringify(['Agent', 'Permissions', 'Advanced', 'Reminders']), 'step 3 has the tabs Agent, Permissions, Advanced, Reminders: ' + JSON.stringify(names));
        check(/Step 3 of 3/.test(await ev(`window.__na.dialog().textContent`)), 'still three steps');
        await tab('Reminders'); await waitFor(`!!document.querySelector(${JSON.stringify(R + ' .launch-rem-none')})`, 'the empty state', 6000);
        check(/No reminders/.test(await ev(`document.querySelector(${JSON.stringify(R + ' .launch-rem-none')}).textContent`)), 'a blank agent says it has no reminders');
        // add a daily one
        await press('Add a reminder'); await waitFor(`!!document.querySelector(${JSON.stringify(R + ' form')})`, 'the form', 3000);
        await set('textarea', 'Post a three-line status.');
        await ev(`(() => { const f = document.querySelector(${JSON.stringify(R + ' form')}); const sel = f.querySelectorAll('select'); sel[0].value = 'daily'; sel[0].dispatchEvent(new Event('change', { bubbles: true })); const t = f.querySelector('input'); t.value = '17:30'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await press('Save reminder'); await waitFor(`document.querySelectorAll(${JSON.stringify(R + ' .launch-rem-card')}).length === 1`, 'one card', 3000);
        // add a weekly one
        await press('Add a reminder'); await waitFor(`!!document.querySelector(${JSON.stringify(R + ' form')})`, 'the form again', 3000);
        await ev(`(() => { const f = document.querySelector(${JSON.stringify(R + ' form')}); f.querySelector('textarea').value = 'Catch up on docs.'; const sel = f.querySelectorAll('select'); sel[0].value = 'weekly'; sel[0].dispatchEvent(new Event('change', { bubbles: true })); sel[2].value = 'Mon'; const t = f.querySelector('input'); t.value = '09:00'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await press('Save reminder'); await waitFor(`document.querySelectorAll(${JSON.stringify(R + ' .launch-rem-card')}).length === 2`, 'two cards', 3000);
        let c = await cards();
        check(/^Daily at 17:30 · /.test(c[0].when) && c[0].chip === 'Added by you' && /^Added by you/.test(c[0].from), 'the daily card says when and that it is the person\'s: ' + JSON.stringify(c[0]));
        check(/^Every Monday at 09:00 · /.test(c[1].when), 'the weekly card says Every Monday at 09:00: ' + JSON.stringify(c[1]));
        check(await count() === '2', 'the tab shows 2: ' + await count());
        // edit the daily one to 18:00
        await ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(R + ' .launch-rem-card')})][0].querySelector('button'); b.click(); return true; })()`);
        await waitFor(`!!document.querySelector(${JSON.stringify(R + ' form')}) && document.querySelector(${JSON.stringify(R + ' form textarea')}).value === 'Post a three-line status.'`, 'the form holds the reminder', 3000);
        await ev(`(() => { const t = document.querySelector(${JSON.stringify(R + ' form input')}); t.value = '18:00'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await press('Save reminder'); await waitFor(`/18:00/.test(document.querySelector(${JSON.stringify(R + ' .launch-rem-card .launch-rem-top strong')}).textContent)`, 'the edit shows', 3000);
        // remove the weekly one: asked once
        await ev(`(() => { document.querySelectorAll(${JSON.stringify(R + ' .launch-rem-card')})[1].querySelector('.launch-rem-remove').click(); return true; })()`);
        check((await cards()).length === 2 && /Confirm remove/.test(await ev(`document.querySelectorAll(${JSON.stringify(R + ' .launch-rem-card')})[1].querySelector('.launch-rem-remove').textContent`)), 'the first press only asks');
        await ev(`document.querySelectorAll(${JSON.stringify(R + ' .launch-rem-card')})[1].querySelector('.launch-rem-remove').click(); true`);
        await waitFor(`document.querySelectorAll(${JSON.stringify(R + ' .launch-rem-card')}).length === 1`, 'one card left', 3000);
        check(await count() === '1', 'the tab shows 1');
        // launch: one launch, one reminder, for the new session
        await click('button', N.launch); await waitFor(`window.__reqs.some(r => r.path === '/api/reminders')`, 'the reminder is saved', 6000);
        const reqs = await ev('window.__reqs'), rem = reqs.filter(r => r.path === '/api/reminders');
        check(reqs[0].path === '/api/sessions/launch' && rem.length === 1, 'launch first, then one reminder: ' + JSON.stringify(reqs.map(r => r.path)));
        const b = rem[0] && rem[0].body;
        check(b && b.session_id === 'sid-rem' && b.kind === 'daily' && b.at === '18:00' && b.text === 'Post a three-line status.' && typeof b.timezone === 'string' && b.timezone.length > 0, 'the body is the existing reminders body for the new session: ' + JSON.stringify(b));
        // a second agent, blank: nothing is saved
        await ev(`window.__reqs.length = 0; true`); await settle(500);
        await toStep3(); await click('button', N.launch); await waitFor(`window.__reqs.some(r => r.path === '/api/sessions/launch')`, 'the second launch', 6000); await settle(500);
        check(!(await ev('window.__reqs')).some(r => r.path === '/api/reminders'), 'a blank agent saves no reminder');
        // a persona's reminders fill the tab, named for it; 5 is the most; a reminder that cannot be saved is said, the agent still starts (#21184)
        await ev(`window.__reqs.length = 0; window.__remFail = true; true`);
        await toStep3(); await tab('Reminders'); await waitFor(`!!document.querySelector(${JSON.stringify(R + ' .launch-rem-none')})`, 'the empty tab again', 6000);
        const persona = n => Array.from({ length: n }, (_, i) => ({ text: 'Persona check ' + (i + 1), kind: 'daily', at: '0' + (i + 1) + ':00' }));
        const fill = n => ev(`document.getElementById('launch-agent-acf').dispatchEvent(new CustomEvent('persona-reminders', { detail: { name: 'Reviewer', list: ${JSON.stringify(persona(n))} } })); true`);
        await fill(4); await waitFor(`document.querySelectorAll(${JSON.stringify(R + ' .launch-rem-card')}).length === 4`, 'four persona cards', 3000);
        if (process.env.SHOT) require('fs').writeFileSync(process.env.SHOT, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
        c = await cards();
        check(c.every(x => x.chip === 'From the template') && /^From the template: Reviewer/.test(c[0].from), 'a persona\'s reminders say where they come from: ' + JSON.stringify(c[0]));
        await press('Add a reminder'); await set('textarea', 'My own.');
        await ev(`(() => { const t = document.querySelector(${JSON.stringify(R + ' form input')}); t.value = '20:00'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await press('Save reminder'); await waitFor(`document.querySelectorAll(${JSON.stringify(R + ' .launch-rem-card')}).length === 5`, 'five cards', 3000);
        check(await ev(`[...document.querySelectorAll(${JSON.stringify(R + ' button')})].find(b => b.textContent.trim() === 'Add a reminder').disabled`) && /5 reminders at most/.test(await ev(`document.querySelector(${JSON.stringify(R)}).textContent`)), 'a sixth is blocked with a plain message');
        await fill(7); await waitFor(`document.querySelectorAll(${JSON.stringify(R + ' .launch-rem-card')}).length === 5`, 'seven persona reminders show 5', 3000);
        await fill(4); await waitFor(`document.querySelectorAll(${JSON.stringify(R + ' .launch-rem-card')}).length === 4`, 'the persona\'s own list replaces the earlier one (the person\'s was dropped by the 7)', 3000);
        await click('button', N.launch); await waitFor(`window.__reqs.filter(r => r.path === '/api/reminders').length === 4`, 'four reminder requests', 6000);
        await waitFor(`/not saved/.test(document.body.textContent)`, 'the failed one is said', 4000);
        check(true, '');
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS New agent has a Reminders tab: add, edit, remove, a count, and Launch saves them for the new session');
})().catch(e => { console.error(e); process.exit(1); });
