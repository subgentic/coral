// One shared look for a folded section (#5683): the summaries of Team settings' "Edit presets" and the prompt texts, Health's "Reviews and
// automatic rules" and the Agent Team dialog's "More template options" were four copies of the same few rules (cursor, weight, size, colour,
// padding, the gap when open, a 44 px line on touch). They share .disclosure now, with --dz-* variables where they differ. This holds that
// nothing moved: each summary's computed style, closed and open, with a fine pointer and a coarse one, is what it was before.
// CAPTURE=1 prints the values instead of checking them. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

// Captured before the shared .disclosure rule: the change must leave every value as it was.
const EXPECTED = {
  "edit presets | coarse | closed": {
    "color": "rgb(240, 240, 242)",
    "cursor": "pointer",
    "display": "flex",
    "h": 44,
    "margin": "0px 0px 0px 0px",
    "minHeight": "44px",
    "padding": "2px 0px 2px 0px",
    "size": "13px",
    "w": 834,
    "weight": "600"
  },
  "edit presets | coarse | open": {
    "color": "rgb(240, 240, 242)",
    "cursor": "pointer",
    "display": "flex",
    "h": 44,
    "margin": "0px 0px 10px 0px",
    "minHeight": "44px",
    "padding": "2px 0px 2px 0px",
    "size": "13px",
    "w": 834,
    "weight": "600"
  },
  "edit presets | fine | closed": {
    "color": "rgb(240, 240, 242)",
    "cursor": "pointer",
    "display": "list-item",
    "h": 20,
    "margin": "0px 0px 0px 0px",
    "minHeight": "auto",
    "padding": "2px 0px 2px 0px",
    "size": "13px",
    "w": 834,
    "weight": "600"
  },
  "edit presets | fine | open": {
    "color": "rgb(240, 240, 242)",
    "cursor": "pointer",
    "display": "list-item",
    "h": 20,
    "margin": "0px 0px 10px 0px",
    "minHeight": "auto",
    "padding": "2px 0px 2px 0px",
    "size": "13px",
    "w": 834,
    "weight": "600"
  },
  "prompt text | coarse | closed": {
    "color": "rgb(160, 160, 168)",
    "cursor": "pointer",
    "display": "flex",
    "h": 44,
    "margin": "0px 0px 0px 0px",
    "minHeight": "44px",
    "padding": "0px 0px 0px 0px",
    "size": "12px",
    "w": 834,
    "weight": "600"
  },
  "prompt text | coarse | open": {
    "color": "rgb(160, 160, 168)",
    "cursor": "pointer",
    "display": "flex",
    "h": 44,
    "margin": "0px 0px 4px 0px",
    "minHeight": "44px",
    "padding": "0px 0px 0px 0px",
    "size": "12px",
    "w": 834,
    "weight": "600"
  },
  "prompt text | fine | closed": {
    "color": "rgb(160, 160, 168)",
    "cursor": "pointer",
    "display": "flex",
    "h": 15,
    "margin": "0px 0px 0px 0px",
    "minHeight": "0px",
    "padding": "0px 0px 0px 0px",
    "size": "12px",
    "w": 834,
    "weight": "600"
  },
  "prompt text | fine | open": {
    "color": "rgb(160, 160, 168)",
    "cursor": "pointer",
    "display": "flex",
    "h": 15,
    "margin": "0px 0px 4px 0px",
    "minHeight": "0px",
    "padding": "0px 0px 0px 0px",
    "size": "12px",
    "w": 834,
    "weight": "600"
  }
};

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const TEAM = 'dz-styles-' + Date.now().toString(36);
    const out = {};
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        const sub = await ev(`fetch('/api/board/${TEAM}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-session' }) }).then(r => r.status)`);
        assert.ok(sub < 300);
        await ev(`import((window.__coralStatic || '/static/') + 'team_working_mode.js').then(m => m.showTeamWorkingMode(${JSON.stringify(TEAM)}, { page: (document.getElementById('qa-ts-host') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'qa-ts-host', style: 'position:fixed;inset:0;display:flex;z-index:50;background:var(--bg-primary)' }))) })); true`);
        await waitFor(`!!document.querySelector('#team-settings-workspace .sv[data-ready]') && !!document.querySelector('#team-settings-workspace .settings-tab[data-section=health]')`, 'Team settings', 15000);
        await ev(`document.querySelector('#team-settings-workspace .settings-tab[data-section=prompts]').click(); true`);
        await waitFor(`!!document.querySelector('.prompt-inspection-folded')`, 'the prompt texts', 15000);
        const STYLE = sel => `(() => { const s = document.querySelector(${JSON.stringify(sel)}); const c = getComputedStyle(s); const r = s.getBoundingClientRect();
            const box = k => k.map(p => c[p]).join(' '); return { cursor: c.cursor, weight: c.fontWeight, size: c.fontSize, color: c.color, padding: box(['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']), margin: box(['marginTop', 'marginRight', 'marginBottom', 'marginLeft']), display: c.display, minHeight: c.minHeight, w: Math.round(r.width), h: Math.round(r.height) }; })()`;
        const SUMMARIES = {
            'edit presets': { tab: 'workflow', sel: '.preset-editor > summary', det: '.preset-editor' },
            'prompt text': { tab: 'prompts', sel: '.prompt-inspection-folded > summary', det: '.prompt-inspection-folded' },
        };
        for (const [coarse] of [[false], [true]]) {
            await Emulation.setTouchEmulationEnabled({ enabled: coarse });
            for (const [name, s] of Object.entries(SUMMARIES)) {
                await ev(`document.querySelector('#team-settings-workspace .settings-tab[data-section=${s.tab}]').click(); true`);
                await waitFor(`!!document.querySelector(${JSON.stringify(s.sel)})`, name, 10000);
                for (const open of [false, true]) {
                    await ev(`document.querySelector(${JSON.stringify(s.det)}).open = ${open}; true`);
                    await new Promise(r => setTimeout(r, 60)); // sleep-ok: a style recalculation after a toggle; there is no event for it
                    out[`${name} | ${coarse ? 'coarse' : 'fine'} | ${open ? 'open' : 'closed'}`] = await ev(STYLE(s.sel));
                }
            }
        }
        // (the team dialog's "More template options" disclosure became a More menu in the three-step dialog, #7407: it is not a disclosure any more)
        await ev(`window.hideLaunchModal(); true`);
        if (process.env.CAPTURE) { console.log('CAPTURED ' + JSON.stringify(out)); throw new Error('captured'); }
        assert.ok(EXPECTED, 'EXPECTED is filled');
        // w and h depend on the text and the panel, not on the rules: compare them too (a padding or a size that moved moves them)
        // (a width within a few pixels is the panel's scrollbar, not a rule: the 'prompt text' summaries became flex with a fold arrow in the prompt inspection cut, #5987)
        for (const k of Object.keys(out)) if (EXPECTED[k] && Math.abs(out[k].w - EXPECTED[k].w) <= 8) out[k].w = EXPECTED[k].w;
        // On Windows the system font's line is a pixel taller (16 where Linux and macOS measure 15): a font's metrics, not a rule that moved.
        if (process.platform === 'win32') for (const k of Object.keys(out)) if (EXPECTED[k] && Math.abs(out[k].h - EXPECTED[k].h) <= 1) out[k].h = EXPECTED[k].h;
        assert.deepEqual(out, EXPECTED);
        console.log(`   ✓ ${Object.keys(out).length} summaries, closed and open, fine and coarse: the same as before the shared class`);
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e.message === 'captured' ? '' : e); process.exit(1); });
