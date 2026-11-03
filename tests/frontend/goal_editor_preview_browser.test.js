// The New goal screen, part 4: the Preview and the goal's page (#12724, direction A). The Preview shows the goal as its page will: the title, the state, the driver, the description as Markdown-lite (bold,
// lists, checkboxes, code, links drawn through the safe renderer: no HTML, no image, no javascript: link), done when and the pictures; Edit goes back and the words are as they were. The goal page (a real
// goal on the isolated server) draws the same description the same way. 1280, 390 and 200% text.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MD = 'Customers import a **CSV** and _only_ a CSV.\n\n- read the file\n- [ ] show progress\n\nSee [the docs](https://example.com/docs) and `coral import`.\n\n<img src=x onerror="window.__pwned=1"> [bad](javascript:window.__pwned=2) <script>window.__pwned=3</script>';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'gpv-' + Date.now().toString(36);
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const set = (id, v) => ev(`(() => { const e = document.getElementById('${id}'); e.focus(); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const inspect = sel => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}); if (!r) return null; return { strong: [...r.querySelectorAll('strong')].map(x => x.textContent), em: [...r.querySelectorAll('em')].map(x => x.textContent), li: r.querySelectorAll('li').length, code: [...r.querySelectorAll('code')].map(x => x.textContent), imgs: r.querySelectorAll('img').length, scripts: r.querySelectorAll('script').length, hrefs: [...r.querySelectorAll('a')].map(a => a.getAttribute('href')), raw: /\\*\\*|<img|<script/.test(r.textContent), handlers: [...r.querySelectorAll('*')].some(e => [...e.attributes].some(a => /^on/i.test(a.name))), pwned: window.__pwned || 0 }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'orch-s' })).status < 300);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Markdown description', outcome: MD, done_when: 'a customer sees every row' }); assert.equal(g.status, 201, JSON.stringify(g));
        const G = g.body.id;
        for (const [w, h, mobile, fs] of [[1280, 900, false, 16], [390, 844, true, 16], [390, 844, true, 32]]) {
            const tag = `${w} px ${fs === 32 ? '200% text' : '100%'}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`document.documentElement.style.fontSize = '${fs}px'; window.__pwned = 0; (() => { const R = window.fetch; window.fetch = (u, o) => /\\/api\\/board\\/[^/]+\\/subscribers/.test(String(u)) ? Promise.resolve(new Response(JSON.stringify([{ subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'o' }]), { status: 200, headers: { 'Content-Type': 'application/json' } })) : R(u, o); })(); import((window.__coralStatic || '/static/') + 'goal_editor.js').then(m => { m.openGoalEditor({ project: '${B}' }); return true; })`);
            await waitFor(`!!document.querySelector('.goal-editor .goal-preview-toggle') && !document.querySelector('#goal-new-driver').disabled`, `${tag}: the screen`, 8000);

            // empty: the Preview says what is missing
            await ev(`document.querySelector('.goal-preview-toggle').click(); true`);
            await waitFor(`!document.querySelector('.goal-preview').hidden && !!document.querySelector('.goal-preview-title')`, `${tag}: the empty preview`, 5000);
            check(`${tag}: an empty goal previews as untitled with nothing written`, /Untitled goal/.test(await ev(`document.querySelector('.goal-preview-title').textContent`)) && /Nothing written yet/.test(await ev(`document.querySelector('.goal-preview').textContent`)) && /Not set yet/.test(await ev(`document.querySelector('.goal-preview').textContent`)));
            await ev(`document.querySelector('.goal-preview-toggle').click(); true`);
            check(`${tag}: Edit goes back to the writing`, (await ev(`document.querySelector('.goal-preview').hidden`)) === true && (await ev(`document.querySelector('.goal-main').hidden`)) === false && (await ev(`document.querySelector('.goal-preview-toggle').textContent`)) === 'Preview');

            // written: Markdown-lite drawn as the page draws it
            await set('goal-new-title', 'Customers import a CSV'); await set('goal-new-description', MD); await set('goal-new-done', 'A customer sees every row in under a minute');
            await ev(`document.querySelector('.goal-preview-open').click(); true`);
            await waitFor(`!document.querySelector('.goal-preview').hidden && !!document.querySelector('.goal-preview .goal-md')`, `${tag}: the preview`, 5000);
            let p = await inspect('.goal-preview .goal-md');
            check(`${tag}: bold, italic, list, code and link are drawn`, p.strong.includes('CSV') && p.em.includes('only') && p.li === 2 && p.code.includes('coral import') && p.hrefs.some(x => /^https:\/\/example\.com\/docs/.test(x)), JSON.stringify(p));
            check(`${tag}: no image, script, handler or javascript: link, and nothing ran`, p.imgs === 0 && p.scripts === 0 && !p.handlers && p.hrefs.every(x => !/^javascript:/i.test(x)) && p.pwned === 0, JSON.stringify(p));
            check(`${tag}: the preview says the title, the state, the driver and done when`, /Customers import a CSV/.test(await ev(`document.querySelector('.goal-preview-title').textContent`)) && /Proposed/.test(await ev(`document.querySelector('.goal-preview-state').textContent`)) && /Driver: Orchestrator/.test(await ev(`document.querySelector('.goal-preview-meta').textContent`)) && /under a minute/.test(await ev(`document.querySelector('.goal-preview').textContent`)));
            check(`${tag}: nothing scrolls sideways`, (await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)) <= 0 && (await ev(`(() => { const d = document.querySelector('dialog.goal-editor'); return d.scrollWidth - d.clientWidth; })()`)) <= 1);
            if (fs === 16) await shot(`preview-${w}`);
            await ev(`document.querySelector('.goal-preview-toggle').click(); true`);
            check(`${tag}: back in Edit the words are as they were`, (await ev(`document.getElementById('goal-new-description').value`)) === MD);
            await ev(`document.querySelector('dialog.goal-editor').close(); true`);

            // the goal's own page draws the same description the same way
            await Page.navigate({ url: BASE + `/team/${B}/goals/${G}` }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`window.__pwned = 0; document.documentElement.style.fontSize = '${fs}px'; true`);
            await waitFor(`!!document.querySelector('#team-panel-goals .goals-facts dd .goal-md')`, `${tag}: the goal page's description`, 15000);
            p = await inspect('#team-panel-goals .goals-facts dd .goal-md');
            check(`${tag}: the goal page draws bold, list, code and link`, p.strong.includes('CSV') && p.li === 2 && p.code.includes('coral import') && p.hrefs.some(x => /^https:\/\/example\.com\/docs/.test(x)), JSON.stringify(p));
            check(`${tag}: and nothing from the text runs or is drawn as HTML`, p.imgs === 0 && p.scripts === 0 && !p.handlers && p.hrefs.every(x => !/^javascript:/i.test(x)) && p.pwned === 0, JSON.stringify(p));
        }
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'the New goal screen, the Preview and the goal page:\n  ' + problems.join('\n  '));
    console.log('PASS the New goal screen: the Preview and the goal page draw the description as Markdown-lite, safely');
})().catch(e => { console.error(e); process.exit(1); });
