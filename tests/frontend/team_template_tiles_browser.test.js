// New team step 2: the built-in templates are tiles under "Start from a template" (#21023, the approved stage-1 mock #21017): name, two lines (what the team does, what you do) and the role count, three
// across on a desktop and one under the other on a phone. A tile and the select are one choice: a tile press fills the members and shows in the select, and the select's choice presses its tile. Blank team
// and saved templates stay in the select. The dialog is the real one (helpers/new_team.js). Shots with CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { install: installNT, N, T, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

const WANT = [
    ['Coding Team', 'Builds and reviews software: an orchestrator, developers, QA and security.', 'You describe the goal and approve the reviews.'],
    ['Consumer Research', 'Runs a study with a panel of simulated customers and reports what they said.', 'You set the question and read the findings.'],
    ['Dungeon Master', 'Runs a tabletop story: a narrator and the characters around it.', 'You play and steer the scene.'],
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const t = T(ev, waitFor);
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['desktop', 1440, 900, false], ['phone', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile, maxTouchPoints: 5 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installNT(ev); await stubModels(ev);
            await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
            await openNewTeam(ev, waitFor); await settle(400);
            await t.type('input', N.teamName, 'alpha'); await t.type('input', N.folder, '/work/payments-app');
            await t.click('button', N.next); await t.step(2); await settle(500);
            const read = () => ev(`(() => { const tiles = [...document.querySelectorAll('#team-template-tiles .team-tile')], sel = document.getElementById('team-template-select');
                return { tiles: tiles.map(b => { const r = b.getBoundingClientRect(), d = b.querySelector('.d'); return { name: b.querySelector('.nm')?.textContent, does: d && d.firstChild?.textContent, you: d?.querySelector('i')?.textContent, roles: b.querySelector('.m')?.textContent, pressed: b.getAttribute('aria-pressed'), l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, clipped: d ? d.scrollHeight > d.clientHeight + 1 : null, shown: b.offsetParent !== null && r.width > 100 && r.height > 40 }; }),
                    sel: sel.value, members: document.querySelectorAll('#team-agents-list .team-agent-row').length, vw: innerWidth }; })()`);
            const a = await read();
            if (a.tiles.length !== 3) { problems.push(`${label}: ${a.tiles.length} tiles, want the 3 built-in templates`); continue; }
            WANT.forEach(([name, does, you], i) => {
                const x = a.tiles[i];
                if (x.name !== name) problems.push(`${label}: tile ${i} is "${x.name}", want "${name}"`);
                if (x.does !== does) problems.push(`${label}: ${name} does-line is "${x.does}"`);
                if (x.you !== you) problems.push(`${label}: ${name} you-line is "${x.you}"`);
                if (!x.shown) problems.push(`${label}: the ${name} tile is not on screen`);
                if (x.clipped) problems.push(`${label}: ${name} description is cut`);
                if (x.r > a.vw + 1 || x.l < -1) problems.push(`${label}: ${name} runs off the screen`);
            });
            const same = (k) => a.tiles.every(x => Math.abs(x[k] - a.tiles[0][k]) < 2);
            if (mobile ? !(a.tiles[1].t >= a.tiles[0].b - 1 && a.tiles[2].t >= a.tiles[1].b - 1) : !same('t')) problems.push(`${label}: tiles are not ${mobile ? 'one under the other' : 'three across'}`);
            if (a.tiles.some(x => x.pressed !== 'false')) problems.push(`${label}: a tile is pressed before any choice`);
            if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/template-tiles-${label}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            // a tile press is the select's choice
            await ev(`document.querySelectorAll('#team-template-tiles .team-tile')[1].click(); true`); await settle(500);
            const b = await read();
            if (b.sel !== 'Consumer Research') problems.push(`${label}: the select shows "${b.sel}" after the Consumer Research tile`);
            if (b.tiles[1].pressed !== 'true' || b.tiles[0].pressed !== 'false') problems.push(`${label}: only the chosen tile is pressed ${JSON.stringify(b.tiles.map(x => x.pressed))}`);
            if (!/^\d+ roles$/.test(b.tiles[1].roles) || b.tiles[1].roles !== `${b.members} roles`) problems.push(`${label}: ${b.members} members filled, the tile says "${b.tiles[1].roles}"`);
            // the select's choice presses its tile; Blank team presses none
            await ev(`(() => { const s = document.getElementById('team-template-select'); s.value = 'Dungeon Master'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(500);
            const c = await read();
            if (c.tiles[2].pressed !== 'true' || c.tiles[1].pressed !== 'false') problems.push(`${label}: the select's choice does not press its tile ${JSON.stringify(c.tiles.map(x => x.pressed))}`);
            await ev(`(() => { const s = document.getElementById('team-template-select'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(400);
            const d = await read();
            if (d.tiles.some(x => x.pressed !== 'false')) problems.push(`${label}: Blank team leaves a tile pressed`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'New team template tiles:\n  ' + problems.join('\n  '));
    console.log('PASS the built-in templates are tiles with two lines and a role count, one choice with the select');
})().catch(e => { console.error(e); process.exit(1); });
