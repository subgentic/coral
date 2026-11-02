// The skills list of New team and New agent on a phone (#12515, #12503 item 6): at 390 px, after 'Choose from N skills' opens, the search box fills the row and stays inside the dialog, each skill's name and
// its description are on separate lines (no 'creating-coral-skills v1How to write...' run together), nothing runs past the right edge, and the ticks are a comfortable size. New agent has the same disclosure,
// in its Advanced section. The skills route is stood in with the three starter skills' real names. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const SKILLS = [
    { id: '1'.repeat(32), name: 'creating-coral-skills', version: 1, description: 'How to write a skill for Coral agents: the file layout, the front matter and how to test it.', status: 'approved', has_scripts: false, not_reviewable: false },
    { id: '2'.repeat(32), name: 'working-in-a-coral-team', version: 1, description: 'The board, tasks, files for review, asking and waiting, from the agent docs.', status: 'approved', has_scripts: false, not_reviewable: false },
    { id: '3'.repeat(32), name: 'creating-a-coral-automation', version: 1, description: 'A workflow and a scheduled job, handed to the Operator, who creates them.', status: 'approved', has_scripts: true, not_reviewable: false },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(async () => {
            const real = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href);
                if (p.pathname === '/api/skills' && p.searchParams.get('status') === 'approved') return json({ skills: ${JSON.stringify(SKILLS)} });
                return real(u, o); };
            await window.showLaunchModal(); window.hideLaunchModal(); return true; })()`);
        const measure = host => ev(`(() => { const h = document.getElementById('${host}'), d = h.querySelector('details'); if (!d) return { noDisclosure: true };
            if (!d.open) d.querySelector('summary').click();
            const vw = innerWidth, q = s => [...h.querySelectorAll(s)], r = e => e.getBoundingClientRect();
            const rows = q('.skills-pick-label').map(l => { const n = l.querySelector('.skills-pick-name'), ds = l.querySelector('.skills-pick-desc'), b = l.querySelector('input'); return { nameBottom: Math.round(r(n).bottom), descTop: Math.round(r(ds).top), descRight: Math.round(r(ds).right), tick: Math.round(r(b).width) }; });
            return { vw, searchRight: Math.round(r(h.querySelector('.skills-pick-search')).right), searchW: Math.round(r(h.querySelector('.skills-pick-search')).width), hostW: Math.round(r(h).width), rows, scrollW: document.documentElement.scrollWidth }; })()`);
        const check = (what, m) => {
            assert.ok(!m.noDisclosure, `${what}: the skills sit in a disclosure`);
            assert.ok(m.scrollW <= m.vw, `${what}: the page does not scroll sideways: ${m.scrollW} > ${m.vw}`);
            assert.ok(m.searchRight <= m.vw - 8, `${what}: the search box ends inside the screen: ${JSON.stringify(m)}`);
            assert.ok(m.searchW >= m.hostW - 2, `${what}: the search box fills the row: ${m.searchW} of ${m.hostW}`);
            for (const x of m.rows) {
                assert.ok(x.descTop >= x.nameBottom - 1, `${what}: the description is below the name, not beside it: ${JSON.stringify(x)}`);
                assert.ok(x.descRight <= m.vw - 8, `${what}: the description stays inside the screen: ${JSON.stringify(x)}`);
                assert.ok(x.tick >= 20, `${what}: the tick is at least 20 px: ${x.tick}`);
            }
        };

        await ev(`window.showLaunchModal(); window._selectLaunchType('team'); true`);
        await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none' && !document.getElementById('team-skills-row').hidden`, 'the team step with its skills row', 8000);
        const team = await measure('team-skills-host');
        await new Promise(r => setTimeout(r, 300)); // sleep-ok: the opened list is laid out
        await shot('skills-team-390');
        check('New team', await measure('team-skills-host'));
        void team;
        await ev(`window.hideLaunchModal(); true`);

        await ev(`window.showLaunchModal(); window._selectLaunchType('agent'); true`);
        await waitFor(`getComputedStyle(document.getElementById('launch-step-agent')).display !== 'none' && !document.getElementById('launch-skills-row').hidden`, 'the agent step with its skills row', 8000);
        const agent = await ev(`(() => { const h = document.getElementById('launch-skills-host'); const s = h.querySelector('details > summary'); return { has: !!s, text: s && s.textContent, shown: !!s && s.getClientRects().length > 0, section: (document.getElementById('launch-skills-row').closest('[role=tabpanel], .settings-pane, .sd-extra') || {}).id || null }; })()`);
        assert.ok(agent.has && /Choose from 3 skills/.test(agent.text), 'New agent has the same disclosure: ' + JSON.stringify(agent));
        console.log('agent skills disclosure: ' + JSON.stringify(agent));
    } finally { await client.close(); }
    console.log('PASS the skills list fits a phone in New team and New agent has the disclosure');
})().catch(e => { console.error(e); process.exit(1); });
