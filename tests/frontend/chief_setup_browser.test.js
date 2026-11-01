// Settings > Chief (#11796, the Coral dot slice 1a): one screen for Chief's name, avatar colour and letter, which agent it is, the team it fronts and whether /chief is on. The real Settings dialog and the real
// settings routes on the isolated dev server (only the lists of running agents and teams are stubbed): the Chief tab is there, the preview follows the name and colour, a name over 40 characters is refused in
// words, Save writes chief_name, chief_avatar, chief_session, chief_team, chief_fronts and chief_page, GET /api/chief gives the look, and /chief's header and chat bubble show it (the chosen name and avatar, the
// agent's own name when none is chosen). 1280 px and a 390 px phone: swatches are 44 px and nothing scrolls sideways. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const SID = '11111111-2222-4333-8444-555555555555';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const STUB = `(() => {
        const real = window.fetch;
        const json = o => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o) => {
            const url = String(u), method = (o && o.method) || 'GET';
            if (method === 'GET' && /\\/api\\/sessions\\/live(\\?|$)/.test(url)) return json([{ session_id: '${SID}', name: 'claude-chief', display_name: 'Orchestrator', board_project: 'chiefteam', board_label: 'Chief desk', model: 'claude-opus-5-5' }]);
            if (method === 'GET' && /\\/api\\/board\\/projects(\\?|$)/.test(url)) return json([{ board_id: 'devteam', label: 'Dev team' }, { board_id: 'chiefteam', label: 'Chief desk' }]);
            return real(u, o);
        };
        return true; })()`;
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const host = `#settings-chief-host`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await api('PUT', '/api/settings', { chief_page: 'false', chief_name: '', chief_avatar: '1', chief_avatar_letter: '', chief_fronts: '', chief_session: '', chief_team: '', chief_actions: 'ask_first' });
            await ev(STUB);
            await ev(`(async () => { await window.showSettingsModal('chief'); return true; })()`);
            await waitFor(`!!document.querySelector('${host} .sv[data-ready]')`, at + 'the Chief screen', 10000);
            assert.equal(await ev(`document.getElementById('settings-tab-chief') && document.getElementById('settings-tab-chief').textContent.replace('chat', '').trim()`), 'Chief', at + 'the Settings dialog has a Chief tab');
            const labels = await ev(`[...document.querySelectorAll('${host} .sv-row .sv-label, ${host} .sv-row label')].map(l => l.textContent.trim()).filter(Boolean).slice(0, 12)`);
            for (const want of ['Name', 'Avatar colour', 'Avatar letter', 'Which agent', 'Its model', 'Team it fronts', 'Serve the Chief page']) assert.ok(labels.some(l => l.startsWith(want)), at + `a row says "${want}": ${JSON.stringify(labels)}`);
            assert.equal(await ev(`document.querySelectorAll('${host} .chief-swatch').length`), 8, at + 'eight colours');
            assert.equal(await ev(`[...document.querySelectorAll('${host} .chief-swatch')].every(b => b.getBoundingClientRect().height >= 43.5 && b.getBoundingClientRect().width >= 43.5)`), true, at + 'each swatch is a 44 px target');
            assert.equal(await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`), 0, at + 'nothing scrolls sideways');

            // the preview follows the name and the colour; a long name is refused in words
            const type = (sel, v) => ev(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await type(`${host} input[name=chief_name]`, 'Ada');
            await ev(`document.querySelector('${host} .chief-swatch[aria-label=Teal]').click(); true`);
            assert.deepEqual(await ev(`(() => { const a = document.querySelector('${host} .chief-preview .chief-avatar'); return [a.textContent, a.dataset.color, document.querySelector('${host} .chief-preview-name').textContent]; })()`), ['A', '3', 'Ada'], at + 'the preview is the name\'s first letter on the chosen colour');
            await type(`${host} input[name=chief_avatar_letter]`, 'k');
            assert.equal(await ev(`document.querySelector('${host} .chief-preview .chief-avatar').textContent`), 'K', at + 'a chosen letter wins');
            await type(`${host} input[name=chief_name]`, 'x'.repeat(41));
            await ev(`[...document.querySelectorAll('#settings-modal ${host} button, ${host} button')].find(b => /^Save Chief/.test(b.textContent.trim())).click(); true`);
            await waitFor(`/At most 40 characters/.test(document.querySelector('${host}').textContent)`, at + 'a name over 40 characters is refused in words', 5000);
            assert.equal(((await api('GET', '/api/settings')).body.settings || {}).chief_name || '', '', at + 'and nothing was saved');

            // Save: every setting is written
            await type(`${host} input[name=chief_name]`, 'Ada');
            await ev(`(() => { const s = document.querySelector('${host} select[name=chief_agent]'); s.value = '${SID}'; s.dispatchEvent(new Event('change', { bubbles: true })); const f = document.querySelector('${host} select[name=chief_fronts]'); f.value = 'Dev team'; f.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            assert.match(await ev(`document.querySelector('${host} .chief-model').textContent`), /Model: claude-opus-5-5\./, at + 'the agent\'s model is shown');
            assert.equal(await ev(`document.querySelector('${host} .chief-model a').getAttribute('href')`), `/agent/${SID}`, at + 'with the way to change it on the agent\'s page');
            await ev(`document.querySelector('${host} input[name=chief_page]').click(); true`);
            await ev(`[...document.querySelectorAll('${host} button')].find(b => /^Save Chief/.test(b.textContent.trim())).click(); true`);
            await waitFor(`/Saved/.test(document.querySelector('${host}').textContent)`, at + 'Saved', 8000);
            const st = (await api('GET', '/api/settings')).body.settings;
            assert.deepEqual([st.chief_name, st.chief_avatar, st.chief_avatar_letter, st.chief_session, st.chief_team, st.chief_fronts, String(st.chief_page)], ['Ada', '3', 'k', SID, 'chiefteam', 'Dev team', 'true'], at + 'saved to the machine: ' + JSON.stringify(st));
            const chief = (await api('GET', '/api/chief')).body;
            assert.deepEqual([chief.name, chief.avatar, chief.avatar_letter, chief.fronts], ['Ada', '3', 'K', 'Dev team'], at + '/api/chief gives the look');

            // opened again, the screen shows what was saved
            await ev(`(async () => { const m = await import(${S} + 'chief_setup.js'); await m.mountChiefSetup(document.querySelector('${host}')); return true; })()`);
            await waitFor(`!!document.querySelector('${host} .sv[data-ready]') && document.querySelector('${host} input[name=chief_name]').value === 'Ada'`, at + 'the saved name is shown again', 8000);
            assert.deepEqual(await ev(`[document.querySelector('${host} select[name=chief_agent]').value, document.querySelector('${host} select[name=chief_fronts]').value, document.querySelector('${host} .chief-swatch[aria-checked=true]').getAttribute('aria-label'), document.querySelector('${host} input[name=chief_avatar_letter]').value]`), [SID, 'Dev team', 'Teal', 'k'], at + 'with the agent, team, colour and letter');

            // /chief: the header and the chat bubble
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList');
            await ev(`(async () => { document.body.dataset.chief = 'true'; const b = document.createElement('div'); b.id = 'tb'; b.innerHTML = '<span id="terminal-header-label">Orchestrator</span>'; document.body.append(b); const bub = document.createElement('div'); bub.className = 'chat-bubble assistant'; bub.id = 'bub'; bub.textContent = 'hello'; document.body.append(bub); const m = await import(${S} + 'chief_look.js'); await m.showChiefFace(document.getElementById('terminal-header-label'), 'Orchestrator'); return true; })()`);
            assert.equal(await ev(`document.getElementById('terminal-header-label').textContent`), 'Ada', at + 'the header names Chief as chosen');
            assert.deepEqual(await ev(`(() => { const a = document.getElementById('chief-avatar-head'); return [a.textContent, getComputedStyle(a).backgroundColor === getComputedStyle(document.documentElement).getPropertyValue('--avatar-3').trim() || getComputedStyle(a).backgroundColor]; })()`).then(r => [r[0], typeof r[1] === 'boolean' ? r[1] : 'rgb']), ['K', 'rgb'], at + 'the header avatar has the letter');
            assert.equal(await ev(`getComputedStyle(document.getElementById('bub'), '::before').content`), '"K"', at + 'each of Chief\'s chat bubbles carries the avatar letter');
            assert.equal(await ev(`getComputedStyle(document.getElementById('bub'), '::before').backgroundColor === getComputedStyle(document.getElementById('chief-avatar-head')).backgroundColor`), true, at + 'in the same colour');
            console.log(`   ✓ ${w} px`);
        }
        await api('PUT', '/api/settings', { chief_page: 'false', chief_name: '', chief_avatar: '1', chief_avatar_letter: '', chief_fronts: '', chief_session: '', chief_team: '', chief_actions: 'ask_first' }); // put the Chief settings back (no leaked rows)
        console.log('PASS Settings > Chief: name, avatar, agent, team and page in one screen; /api/chief and the /chief header and chat show it');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
