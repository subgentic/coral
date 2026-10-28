// The Automations lists on a phone say what they are (Mobile pass 19, #10267, #10275), at 390 and 320 px: (1) New job, New workflow and Build with Agent are buttons with their words (a "+" and a robot said nothing to a
// person looking at them) and every one is 44 px tall and on the screen; (2) the Jobs list marks a paused job Paused beside its name, which a phone's list needs because its Next column, where the chip is, has gone;
// (3) a long workflow name wraps at its hyphens and spaces and is not cut mid-word with an ellipsis. At 1280 px the words are there as before and the name's row is one line. A stubbed server. Drives Chrome over CDP
// through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const STUB = `(() => {
        const real = window.fetch; const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        const inn = h => new Date(Date.now() + h * 3600000).toISOString();
        const base = { description: '', timezone: 'UTC', agent_type: 'claude', repo_path: '/work/project', base_branch: 'main', prompt: 'Tidy.', enabled: 1, max_duration_s: 3600, cleanup_worktree: 0, flags: '', consecutive_failures: 0, last_run: null };
        const jobs = [{ ...base, id: 1, name: 'summarize-the-day', cron_expr: '0 18 * * 1-5', next_fire_at: inn(30) }, { ...base, id: 2, name: 'weekly-cleanup', cron_expr: '0 9 * * 1', enabled: 0, next_fire_at: null }];
        const wfs = [{ id: 5, name: 'summarise-the-weekly-metrics-report', description: '', enabled: 1, steps: [{ name: 'A' }] }, { id: 6, name: 'daily-motivation-message-generator', description: '', enabled: 1, steps: [{ name: 'A' }] }];
        window.fetch = (u, o) => {
            const url = String(u), method = (o && o.method) || 'GET';
            if (method === 'GET' && /\\/api\\/scheduled\\/jobs$/.test(url)) return json({ jobs });
            if (method === 'GET' && /\\/api\\/workflows$/.test(url)) return json({ workflows: wfs });
            if (/\\/api\\/workflows\\/\\d+\\/runs/.test(url) || /\\/api\\/scheduled\\/jobs\\/\\d+\\/runs/.test(url)) return json({ runs: [], total: 0 });
            return real(u, o);
        };
        return true; })()`;
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true], [320, 568, true]]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${w}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`window.openAutomationsFolder('jobs'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view button.dt-primary').length === 2`, `${w}: the two jobs`, 10000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the toolbar draws
            // (1) the create button says its words, and is a 44 px target on the screen
            const acts = async () => ev(`[...document.querySelectorAll('.automations-act')].filter(b => b.getClientRects().length > 0).map(b => { const r = b.getBoundingClientRect(); return { seen: b.innerText.replace(/\\s+/g, ' ').trim(), name: b.getAttribute('aria-label'), w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.left), r: Math.round(r.right) }; })`);
            let a = await acts();
            check(a.length === 1 && /New job/.test(a[0].seen), `Jobs: the create button says New job in words (it shows ${JSON.stringify(a.map(x => x.seen))})`);
            check(a.every(x => x.h >= (mobile ? 44 : 0) && x.l >= 0 && x.r <= w), `Jobs: each create button is 44 px tall and on the screen ${JSON.stringify(a)}`);
            // (2) a paused job says Paused beside its name; the active one does not
            const rows = await ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].map(r => ({ name: r.querySelector('.dt-primary').textContent.trim(), paused: [...r.querySelectorAll('.chip')].some(c => c.textContent.trim() === 'Paused' && c.getClientRects().length > 0) }))`);
            check(rows.length === 2 && rows.find(r => r.name === 'weekly-cleanup').paused === true && rows.find(r => r.name === 'summarize-the-day').paused === false, `Jobs: only the paused job shows Paused (${JSON.stringify(rows)})`);
            // workflows
            await ev(`window.openAutomationsFolder('workflows'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view button.dt-primary').length === 2`, `${w}: the two workflows`, 10000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the toolbar draws
            a = await acts();
            check(a.length === 2 && a.some(x => /Build with Agent/.test(x.seen)) && a.some(x => /New workflow/.test(x.seen)), `Workflows: Build with Agent and New workflow say their words (they show ${JSON.stringify(a.map(x => x.seen))})`);
            check(a.every(x => x.h >= (mobile ? 44 : 0) && x.l >= 0 && x.r <= w), `Workflows: each create button is 44 px tall and on the screen ${JSON.stringify(a)}`);
            // (3) a long name wraps at its words (narrow) or fits (wide), never an ellipsis mid-word
            const names = await ev(`[...document.querySelectorAll('#group-table-view button.dt-primary')].map(b => { const cs = getComputedStyle(b); return { t: b.textContent.trim(), cut: b.scrollWidth > b.clientWidth + 1, ellipsis: cs.textOverflow === 'ellipsis' && cs.whiteSpace === 'nowrap', h: Math.round(b.getBoundingClientRect().height) }; })`);
            if (mobile) check(names.every(n => !n.cut && !n.ellipsis), `Workflows: a long name wraps, it is not cut: ${JSON.stringify(names)}`);
            else check(names.every(n => n.h <= 50), `Workflows: at 1280 a name is one line: ${JSON.stringify(names)}`);
        }
    } finally { await Page.disable().catch(() => {}); }
    assert.deepEqual(problems, [], 'the Automations lists on a phone:\n  ' + problems.join('\n  '));
    console.log('PASS the Automations lists say their words, mark a paused job, and wrap a long name');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
