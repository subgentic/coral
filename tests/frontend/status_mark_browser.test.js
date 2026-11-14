// One status mark for every list (design guidelines 4.5, #15813): a shape and a word, the word in the text's colour and never blue, the shape the state's colour. Shown first in Jobs' Last run: a run that is running (green dot), passed
// (grey check), failed (red cross), stopped or waiting to start (hollow grey dot). The six states of the component (green dot, amber triangle, hollow grey dot, moon, check, cross) are told apart in dark and light, at 1440 px, 390 px
// and 200% text, and with colours off (forced-colors): six different shapes, and the word in the same colour as the text. A stubbed server for the Jobs list; the gallery draws statusMark itself.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, what) => { if (!ok) problems.push(what); };
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => {
            const real = window.fetch; const ago = h => new Date(Date.now() - h * 3600000).toISOString();
            const base = { description: '', timezone: 'UTC', agent_type: 'claude', repo_path: '/work/p', base_branch: 'main', prompt: 'Do it.', enabled: 1, max_duration_s: 3600, cleanup_worktree: 0, flags: '', cron_expr: '0 * * * *' };
            const jobs = [
                { ...base, id: 1, name: 'run-job', last_run: { id: 11, status: 'running', started_at: ago(0.1) } },
                { ...base, id: 2, name: 'passed-job', last_run: { id: 12, status: 'completed', started_at: ago(2), finished_at: ago(2) } },
                { ...base, id: 3, name: 'failed-job', last_run: { id: 13, status: 'failed', error_msg: 'step 2 (Test) failed: exit code 3', started_at: ago(3), finished_at: ago(3) } },
                { ...base, id: 4, name: 'stopped-job', last_run: { id: 14, status: 'killed', started_at: ago(4), finished_at: ago(4) } },
                { ...base, id: 5, name: 'queued-job', last_run: { id: 15, status: 'pending', started_at: ago(0.01) } },
                { ...base, id: 6, name: 'new-job' },
            ];
            const json = o => Promise.resolve(new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u && u.url ? u.url : u);
                if (/\\/api\\/scheduled\\/jobs$/.test(url)) return json({ jobs });
                if (/\\/api\\/workflows$/.test(url)) return json({ workflows: [] });
                if (/\\/api\\/scheduled\\/jobs\\/\\d+\\/runs/.test(url)) return json({ runs: [], total: 0 });
                return real(u, o); };
            return true; })()`);
        await ev(`window.switchNavTab('automations'); import(${S} + 'scheduler.js').then(m => m.refreshJobs()).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length >= 6`, 'the Jobs list', 12000);
        const EXPECT = { 'run-job': ['working', 'Running'], 'passed-job': ['done', 'Passed'], 'failed-job': ['failed', 'Failed'], 'stopped-job': ['idle', 'Stopped'], 'queued-job': ['idle', 'Waiting to start'] };
        for (const theme of ['dark', 'light']) {
            await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`);
            const rows = await ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].map(r => { const c = r.querySelector('td[data-key="last-run"]'), m = c && c.querySelector('.status-mark'); return { name: r.querySelector('.dt-primary')?.textContent.trim(), text: c ? c.textContent.replace(/\\s+/g, ' ').trim() : null, state: m && m.dataset.state, word: m && m.querySelector('.status-word').textContent, chip: c ? c.querySelectorAll('.dt-chip').length : 0, shape: m && !!m.querySelector('svg.status-shape path') }; })`);
            for (const [name, [state, word]] of Object.entries(EXPECT)) { const r = rows.find(x => x.name === name); check(r && r.state === state && r.word === word && r.shape && r.chip === 0, `${theme}: ${name} Last run is the ${state} mark with the word "${word}" (and no chip): ${JSON.stringify(r)}`); }
            check((rows.find(x => x.name === 'new-job') || {}).text === 'Never run', `${theme}: a job never run says Never run`);
            if (theme === 'dark') await shot('status-mark-jobs-1440-dark');
        }
        await ev(`document.documentElement.setAttribute('data-theme', 'dark'); true`);
        // The component's six states, drawn by statusMark itself, in a gallery on the page.
        const gallery = async () => ev(`(async () => { const m = await import(${S} + 'status_mark.js'); document.getElementById('sm-gallery')?.remove(); const g = document.createElement('div'); g.id = 'sm-gallery'; g.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999;background:var(--bg-secondary);padding:12px;display:flex;flex-direction:column;gap:8px;max-width:calc(100vw - 16px);box-sizing:border-box'; for (const s of Object.keys(m.STATUS)) { const row = document.createElement('div'); row.style.color = 'var(--text-secondary)'; row.append(m.statusMark(s)); g.append(row); } document.body.append(g);
            const rgb = v => { const p = document.createElement('i'); p.style.color = v; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; };
            const out = [...g.querySelectorAll('.status-mark')].map(mk => ({ state: mk.dataset.state, word: mk.querySelector('.status-word').textContent, d: mk.querySelector('path').getAttribute('d'), shape: getComputedStyle(mk.querySelector('.status-shape')).color, wordColor: getComputedStyle(mk.querySelector('.status-word')).color, box: mk.querySelector('.status-shape').getBoundingClientRect().width, root: parseFloat(getComputedStyle(document.documentElement).fontSize), right: mk.getBoundingClientRect().right }));
            return { out, vw: innerWidth, tokens: { success: rgb('var(--success)'), warning: rgb('var(--warning)'), muted: rgb('var(--text-muted)'), error: rgb('var(--error)'), text: rgb('var(--text-primary)') } }; })()`);
        const isBlue = c => { const m = /rgb\((\d+), (\d+), (\d+)/.exec(c); if (!m) return false; const [r, g, b] = m.slice(1).map(Number); return b > r + 30 && b > g + 10; };
        const WANT = { working: ['Working', 'success'], waiting: ['Waiting on you', 'warning'], idle: ['Idle', 'muted'], sleeping: ['Sleeping', 'muted'], done: ['Done', 'muted'], failed: ['Failed', 'error'] };
        const modes = [['1440 px dark', 1440, 900, false, 'dark', ''], ['1440 px light', 1440, 900, false, 'light', ''], ['390 px dark', 390, 844, true, 'dark', ''], ['390 px light', 390, 844, true, 'light', ''], ['1440 px 200% text', 1440, 900, false, 'dark', '200%'], ['390 px 200% text', 390, 844, true, 'dark', '200%']];
        for (const [label, w, h, mobile, theme, zoom] of modes) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
            const g = await gallery();
            check(new Set(g.out.map(x => x.d)).size === 6, `${label}: six different shapes`);
            for (const x of g.out) {
                const [word, tok] = WANT[x.state];
                check(x.word === word, `${label}: ${x.state} says "${word}" (${x.word})`);
                check(x.shape === g.tokens[tok], `${label}: the ${x.state} shape is the ${tok} colour (${x.shape} vs ${g.tokens[tok]})`);
                check(x.wordColor === g.tokens.text && !isBlue(x.wordColor) && !isBlue(x.shape), `${label}: the ${x.state} word is the text colour and nothing is blue (${x.wordColor}, ${x.shape})`);
                check(Math.abs(x.box - 0.75 * x.root) < 0.5 && x.right <= g.vw, `${label}: the ${x.state} mark is 12 px (more with the text at 200%) and inside the screen (${x.box} at ${x.root}, ${x.right} of ${g.vw})`);
            }
            if (label === '1440 px dark' || label === '390 px light' || label === '390 px 200% text') await shot('status-mark-gallery-' + label.replace(/ /g, '-'));
        }
        await ev(`document.documentElement.style.fontSize = ''; document.documentElement.setAttribute('data-theme', 'dark'); true`);
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        // Colours off: forced-colors keeps the shapes apart, and shape and word share one colour.
        await Emulation.setEmulatedMedia({ features: [{ name: 'forced-colors', value: 'active' }] });
        const forced = await gallery();
        check(new Set(forced.out.map(x => x.d)).size === 6, 'forced-colors: six different shapes');
        check(forced.out.every(x => x.shape === x.wordColor), 'forced-colors: shape and word are one colour, so the shape alone tells the state: ' + JSON.stringify(forced.out.map(x => [x.state, x.shape, x.wordColor])));
        await shot('status-mark-gallery-forced-colors');
        await Emulation.setEmulatedMedia({ features: [{ name: 'forced-colors', value: 'none' }] });
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'The status mark:\n  ' + problems.join('\n  '));
    console.log('PASS one status mark: Jobs Last run and the six states');
})().catch(e => { console.error(e); process.exit(1); });
