// The skills picker lists each skill once, at its newest version (#15890, the design review's LA6: "using-coral v1, v2 and v3" were three rows among 14). The approved list is stood in with several versions of
// two skills and one single-version skill; New agent shows three rows (newest version each, in the order the names first appear), the summary counts three, ticking one sends the newest version's id, and an older
// version never shows. At 1440 and at 390 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const id = n => String(n).repeat(32).slice(0, 32);
const S = (n, name, version, extra) => ({ id: id(n), name, version, description: name + ' does its thing.', status: 'approved', has_scripts: false, not_reviewable: false, ...extra });
// the older versions come first and last on purpose: the newest is picked by number, not by position
const SKILLS = [S(1, 'using-coral', 1), S(2, 'using-coral', 3), S(3, 'working-in-a-coral-team', 2), S(4, 'db-review', 1), S(5, 'using-coral', 2), S(6, 'working-in-a-coral-team', 1), S(7, 'working-in-a-coral-team', 3)];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, mobile] of [[1440, false], [390, true]]) {
            const at = `${width}px: `;
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`(async () => {
                window.__reqs = [];
                const real = window.fetch; const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href), m = o.method || 'GET';
                    if (p.pathname === '/api/skills' && p.searchParams.get('status') === 'approved') return json({ skills: ${JSON.stringify(SKILLS)} });
                    if (m === 'POST' && p.pathname === '/api/sessions/launch') { window.__reqs.push({ body: JSON.parse(o.body) }); return json({ session_name: 'launched-1', session_id: 'sid-1' }); }
                    if (p.pathname === '/api/filesystem/is-git') return json({ is_git: true });
                    return real(u, o); };
                await window.showLaunchModal(); window.hideLaunchModal();
                return true; })()`);
            await ev(`window.showLaunchModal(); window._selectLaunchType('agent'); true`);
            await waitFor(`!document.getElementById('launch-skills-row').hidden && document.querySelectorAll('#launch-skills-host .skills-pick').length > 0`, at + 'the skills row', 8000);
            const rows = await ev(`Array.from(document.querySelectorAll('#launch-skills-host .skills-pick .skills-pick-name')).map(e => e.textContent.trim())`);
            assert.deepEqual(rows, ['using-coral v3', 'working-in-a-coral-team v3', 'db-review v1'], at + 'one row per skill at its newest version: ' + JSON.stringify(rows));
            assert.equal(await ev(`document.querySelector('#launch-skills-host .skills-pick-summary').textContent.trim()`), 'Choose from 3 skills', at + 'the summary counts the skills, not the versions');
            await ev(`document.querySelector('#launch-skills-host input[type=checkbox][value="${id(2)}"]').click(); true`);
            await ev(`(() => { const e = document.getElementById('launch-dir'); e.value = '/work/repo'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await ev(`document.querySelector('#launch-step-agent [data-on-click="m-launch-session"]').click(); true`);
            await waitFor(`window.__reqs.length > 0`, at + 'the launch', 8000);
            assert.deepEqual(await ev(`window.__reqs[0].body.skills`), [id(2)], at + 'the ticked row is the newest version\'s id');
            console.log('PASS ' + at + 'each skill once, newest version, counted once, its id sent');
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
