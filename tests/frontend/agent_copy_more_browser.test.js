// "Copy for an agent" lives in each page's More menu with its words (#15817, guidelines 4.2): Jobs and Workflows have no robot and no row of their own under the header (the table follows the toolbar at once), the
// More menu holds the item, and pressing it copies the line it copied before (the folder's line, then where in the docs to read). 1440 and 390, dark and light. Isolated dev server; the lists are stand-ins, the clipboard too.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = []; const check = (ok, what) => { if (!ok) problems.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, theme, mobile] of [['1440 dark', 1440, 900, 'dark'], ['1440 light', 1440, 900, 'light'], ['390 touch dark', 390, 844, 'dark', true], ['390 touch light', 390, 844, 'light', true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile }); await Emulation.setTouchEmulationEnabled({ enabled: !!mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => {
                const real = window.fetch; const base = { description: '', timezone: 'UTC', agent_type: 'claude', repo_path: '/work/p', base_branch: 'main', prompt: 'Do it.', enabled: 1, max_duration_s: 3600, cleanup_worktree: 0, flags: '', cron_expr: '0 * * * *' };
                const jobs = [{ ...base, id: 1, name: 'nightly-build' }, { ...base, id: 2, name: 'weekly-cleanup', enabled: 0 }];
                const wfs = [{ id: 1, name: 'release-train', description: '', steps: [], enabled: 1 }, { id: 2, name: 'triage', description: '', steps: [], enabled: 1 }];
                const json = o => Promise.resolve(new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o) => { const url = String(u && u.url ? u.url : u);
                    if (/\\/api\\/scheduled\\/jobs$/.test(url)) return json({ jobs });
                    if (/\\/api\\/workflows$/.test(url)) return json({ workflows: wfs });
                    if (/\\/api\\/(workflows|scheduled\\/jobs)\\/\\d+\\/runs/.test(url)) return json({ runs: [], total: 0 });
                    return real(u, o); };
                window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__copied.push(t); return Promise.resolve(); } }, configurable: true });
                document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); return true; })()`);
            await ev(`window.switchNavTab('automations'); true`);
            for (const folder of ['jobs', 'workflows']) {
                const at = `${label} ${folder}: `;
                await ev(`window.openAutomationsFolder(${JSON.stringify(folder)}); true`);
                await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 2 && !!document.querySelector('#group-table-view .page-header .page-header-more')`, `${at}the page with its header`, 12000);
                await ev(`${framesJs(3, 600)}`);
                const g = await ev(`(() => { const v = document.getElementById('group-table-view'), bar = v.querySelector('.page-header'), table = v.querySelector('table, .dt-table, .data-table'); const t = table ? table.getBoundingClientRect().top : 0, b = bar.getBoundingClientRect().bottom;
                    return { robots: v.querySelectorAll('.agent-copy').length, gap: Math.round(t - b), hasTable: !!table }; })()`);
                check(g.robots === 0, `${at}no robot button on the page (${g.robots})`);
                check(g.hasTable && g.gap >= 0 && g.gap < 30, `${at}the table follows the toolbar with no empty band (${g.gap}px)`);
                if (folder === 'workflows') await shot('copy-more-' + label.replace(/ /g, '-'));
                await ev(`document.querySelector('#group-table-view .page-header-more > button').click(); true`);
                await waitFor(`!!document.querySelector('.page-header-more-menu') && !document.querySelector('.page-header-more-menu').hidden`, `${at}More opens`, 4000);
                const items = await ev(`[...document.querySelectorAll('.page-header-more-menu [role="menuitem"]')].map(b => b.textContent.trim())`);
                check(items.length === 1 && items[0] === 'Copy for an agent', `${at}More holds Copy for an agent with its words (${JSON.stringify(items)})`);
                await ev(`document.querySelector('.page-header-more-menu [role="menuitem"]').click(); true`);
                await waitFor(`window.__copied.length >= 1`, `${at}the line is copied`, 6000);
                const text = await ev(`window.__copied.pop()`);
                check(new RegExp(`Coral\\u2019s scheduled ${folder} \\(the Automations tab\\)\\.[\\s\\S]*Docs: `).test(text), `${at}it copies the folder's line, then where to read (${JSON.stringify(text)})`);
            }
        }
    } finally { try { await client.close(); } catch (e) {} }
    assert.deepEqual(problems, [], 'Copy for an agent in More:\n  ' + problems.join('\n  '));
    console.log('PASS copy for an agent is in More');
})().catch(e => { console.error(e); process.exit(1); });
