// The list of agents this computer cannot use yet in New agent (#12364, the operator's screenshot: names, statuses and actions in ragged columns, "Found but not used" one word a line, a technical paragraph).
// One row per CLI, three aligned columns (name, a status chip, one action); a CLI found and not used says why in one short line with the agent's name as a link, the steps behind Why?; nothing is clipped or
// broken word by word at 1280 and 390 px.
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { install: installNA, stubModels, stubCliChecks } = require('./helpers/new_agent');

const NOTE = (bin, type) => `Found but not used: ~/.local/bin/${bin} is in an agent's working folder: the agent "Security Reviewer" works in ~. Archive that agent (an asleep one counts too) or restart it in a project folder, then check again, so a launch refuses it. Install it somewhere else, or set its path in Settings > CLI paths (the setting cli_path_${type}).`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [], check = (ok, what) => { if (!ok) problems.push(what); };
    const settle = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the list settles over a frame or two
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev);
            await stubModels(ev); await stubCliChecks(ev, ['codex', 'opencode', 'hermes'], [], []);
            await ev(`(() => { const R = window.fetch; window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (url.pathname === '/api/system/cli-check') { const t = url.searchParams.get('type'), note = { agy: ${JSON.stringify(NOTE('agy', 'agy'))}, pi: ${JSON.stringify(NOTE('pi', 'pi'))} }[t];
                    if (note) return Promise.resolve(new Response(JSON.stringify({ agent_type: t, found: false, status: 'missing', refused: "in an agent's working folder", install_note: note }), { status: 200, headers: { 'content-type': 'application/json' } })); }
                return R(u, o); }; return true; })()`);
            await ev(`window.__coralLive = null; (async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; st.liveSessions = [{ session_id: 'sr1', name: 'coral-sr1', display_name: 'Security Reviewer', board_subscriber_id: 'Security Reviewer', agent_type: 'claude', server: 'local' }]; return true; })()`);
            await ev(`(async () => { await window.showLaunchModal(); const c = document.querySelector('#launch-step-chooser [data-arg="agent"]'); if (c && c.getClientRects().length) c.click(); return true; })()`);
            await waitFor(`!!document.getElementById('launch-dir') && document.getElementById('launch-dir').getClientRects().length > 0`, at + 'the folder step', 8000);
            await ev(`(() => { const i = document.getElementById('launch-dir'); if (!i.value) { i.value = '/tmp'; i.dispatchEvent(new Event('input', { bubbles: true })); } document.getElementById('launch-agent-next').click(); document.getElementById('launch-agent-next').click(); return true; })()`);
            await waitFor(`document.getElementById('launch-agent-pick') && document.getElementById('launch-agent-pick').dataset.probed === '1'`, at + 'the agent list', 10000);
            await waitFor(`document.querySelectorAll('#launch-agent-pick .provider-entry').length >= 4`, at + 'the rows of the list', 10000);
            await settle(500);
            const m = await ev(`(() => { const g = document.getElementById('launch-agent-pick'), rows = [...g.querySelectorAll('.provider-entry')], box = e => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
                const clipped = e => e.scrollWidth > e.clientWidth + 1;
                return { n: rows.length, names: rows.map(r => r.querySelector('.provider-name').textContent), chips: rows.map(r => r.querySelector('.provider-chip').textContent),
                    nameL: rows.map(r => box(r.querySelector('.provider-name')).l), chipL: rows.map(r => box(r.querySelector('.provider-chip')).l), actR: rows.map(r => box(r.querySelector('.provider-action')).r),
                    actT: rows.map(r => box(r.querySelector('.provider-action')).t), nameT: rows.map(r => box(r.querySelector('.provider-name')).t),
                    chipH: rows.map(r => box(r.querySelector('.provider-chip')).h), clippedChip: rows.filter(r => clipped(r.querySelector('.provider-chip'))).length, over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    actions: rows.map(r => (r.querySelector('.provider-action a, .provider-action button') || {}).textContent || ''), lines: rows.map(r => (r.querySelector('.provider-why-line') || {}).textContent || ''), lineAgent: rows.map(r => !!r.querySelector('.provider-why-line .agent-link')),
                    whyOpen: rows.map(r => r.querySelector('.provider-why') ? r.querySelector('.provider-why').open : null), whySummary: rows.map(r => (r.querySelector('.provider-why summary') || {}).textContent || ''), steps: rows.map(r => (r.querySelector('.provider-steps') || {}).textContent || ''), listW: box(g.querySelector('.provider-list')) }; })()`);
            const same = a => a.every(v => Math.abs(v - a[0]) <= 1);
            check(m.n === 5 && m.names.join() === 'Codex,Antigravity,Pi,OpenCode,Hermes', at + 'one row per CLI that cannot be used: ' + JSON.stringify(m.names));
            check(m.chips.join() === 'Not installed,Not used,Not used,Not installed,Not installed', at + 'a short status chip each: ' + JSON.stringify(m.chips));
            check(same(m.nameL) && same(m.chipL), at + 'the names share one column and the chips another: ' + JSON.stringify({ names: m.nameL, chips: m.chipL }));
            if (!mobile) check(same(m.actR), at + 'the actions end in one column: ' + JSON.stringify(m.actR));
            else check(m.actT.every((t, i) => t > m.nameT[i]), at + 'on a phone the action sits under the name and chip: ' + JSON.stringify({ a: m.actT, n: m.nameT }));
            check(m.chipH.every(v => v >= 14 && v <= 36) && m.clippedChip === 0, at + 'no chip is broken over lines or clipped: ' + JSON.stringify(m.chipH));
            check(m.over <= 0, at + 'no sideways page scroll: ' + m.over);
            check(m.actions.join('|') === 'Install Codex|Choose a path|Choose a path|Install OpenCode|Install Hermes', at + 'one action each: ' + JSON.stringify(m.actions));
            check(/^Not used: ~\/\.local\/bin\/agy is inside Security Reviewer's working folder \(~\)\.$/.test(m.lines[1]) && m.lineAgent[1] === true, at + 'the reason is one short line, the agent a link: ' + JSON.stringify([m.lines[1], m.lineAgent[1]]));
            check(m.whyOpen[1] === false && m.whySummary[1] === 'Why?' && /Archive Security Reviewer/.test(m.steps[1]) && /Settings > CLI paths/.test(m.steps[1]) && !/cli_path_agy|so a launch refuses it/.test(m.lines[1]), at + 'the steps are behind Why?, in plain steps: ' + JSON.stringify([m.whyOpen[1], m.steps[1]]));
            // Why? opens the steps; Choose a path opens Settings at the CLI paths
            await ev(`document.querySelector('#launch-agent-pick .provider-entry.is-refused .provider-why summary').click(); true`); await settle(200);
            check(await ev(`document.querySelector('#launch-agent-pick .provider-entry.is-refused .provider-why').open === true && document.querySelector('#launch-agent-pick .provider-entry.is-refused .provider-steps').getClientRects().length > 0`), at + 'Why? opens the steps');
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`);
        }
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exitCode = 1; } else console.log('PASS the CLI status list: aligned rows, short chips, one reason line, steps behind Why?');
})().catch(e => { console.error(e); process.exitCode = 1; });
