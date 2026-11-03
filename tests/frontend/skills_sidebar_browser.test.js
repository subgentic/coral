// The Skills page has the app's left sidebar (#12997, the Operator: "Skill should have our left sidebar"; "Skills can be Imported, Agent Created, Coral Skills"): the folders All skills, Imported, Agent created (what
// waits on approval said on it, "1 of 2", in red) and Coral skills with their counts, a search of the table, the selected folder in the address (/skills/agent-created) so a reload keeps it, the status filter
// and the pending skill's notice still working. A skill's source is on its record (publisher_kind). A phone has no sidebar: the folders are a strip at the top of the page. 1280, 390 and 390 at 200% text, both themes.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const mk = (n, name, kind, status, extra = {}) => ({ id: String(n).repeat(32), name, version: 1, digest: String(n).repeat(64), description: `${name} does a thing.`, status, has_scripts: false, not_reviewable: false, publisher_kind: kind, publisher_agent: kind === 'agent' ? 'Backend Dev' : '', publisher_team: kind === 'agent' ? 'alpha' : '', file_count: 1, created_at: '2026-11-02T09:00:00Z', decided_at: '', ...extra });
const ROWS = [mk(1, 'release-notes', 'operator', 'approved'), mk(2, 'md-skill', 'operator', 'approved'), mk(3, 'db-review', 'agent', 'pending'), mk(4, 'pdf-forms', 'agent', 'approved'), mk(5, 'working-in-a-coral-team', 'coral', 'approved')];
const STUB = `(() => { const R = window.fetch; const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })); const rows = ${JSON.stringify(ROWS)};
    window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin), p = url.pathname, m = (o.method || 'GET').toUpperCase();
        if (p === '/api/skills' && m === 'GET') { const st = url.searchParams.get('status'); return json({ skills: st ? rows.filter(r => r.status === st) : rows }); }
        const one = rows.find(r => p === '/api/skills/' + r.id); if (one && m === 'GET') return json({ skill: one, files: [{ path: 'SKILL.md', size: 90, kind: 'instructions', sha256: '9'.repeat(64) }], contents: { 'SKILL.md': '# ' + one.name }, warnings: [], hosts: [] });
        return R(u, o); }; })();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const problems = []; const check = (l, c, d) => { if (!c) problems.push(`${l}${d !== undefined ? ': ' + d : ''}`); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const names = () => ev(`[...document.querySelectorAll('#skills-view tr.dt-row')].map(r => r.querySelector('td').textContent.trim().slice(0, 90))`);
    const folders = sel => ev(`[...document.querySelectorAll(${JSON.stringify(sel)} + ' .view-list-item')].filter(b => b.getClientRects().length).map(b => ({ key: b.dataset.key, text: b.textContent.replace(/\\s+/g, ' ').trim(), current: b.getAttribute('aria-current') === 'true', alert: !!b.querySelector('.view-list-alert') }))`);
    const load = async (url, fs, theme) => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings'); await ev(`document.documentElement.style.fontSize = '${fs}px'; document.documentElement.setAttribute('data-theme', '${theme}'); true`); await waitFor(`document.querySelectorAll('#skills-view tr.dt-row').length >= 1`, `${url}: the table`, 10000); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile, fs] of [[1280, 900, false, 16], [390, 844, true, 16], [390, 844, true, 32]]) for (const theme of ['dark', 'light']) {
            const tag = `${w} px ${fs === 32 ? '200% text' : '100%'} ${theme}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await load('/skills', fs, theme);
            const host = mobile ? '#skills-view' : '#skills-nav-list';
            let f = await folders(host);
            check(`${tag}: the four folders with their counts, Agent created saying what waits`, JSON.stringify(f.map(x => x.text)) === JSON.stringify(['All skills5', 'Imported2', 'Agent created1 of 2', 'Coral skills1']), JSON.stringify(f));
            check(`${tag}: Agent created's count is red while one waits, All is the open one`, f.find(x => x.key === 'agent-created').alert && f.find(x => x.key === 'all').current, JSON.stringify(f));
            if (!mobile) { check(`${tag}: the sidebar is the Skills pane, on screen`, (await ev(`(() => { const p = document.querySelector('.sidebar-pane[data-pane="skills"]'); return !!p && !p.hidden && p.getClientRects().length > 0; })()`)) === true); check(`${tag}: and the search is there`, (await ev(`!!document.getElementById('skills-search') && document.getElementById('skills-search').getClientRects().length > 0`)) === true); }
            else check(`${tag}: a phone has no sidebar: the folders are the page's strip`, (await ev(`!document.querySelector('.sidebar-pane[data-pane="skills"]') || document.querySelector('.sidebar-pane[data-pane="skills"]').getClientRects().length === 0`)) === true && f.length === 4);
            check(`${tag}: the whole store is listed`, (await names()).length === 5, JSON.stringify(await names()));
            if (mobile) { // the Operator's note on #12997: a phone's rows run edge to edge like the Inbox lists (no bordered box, a 16 px inner inset, a divider under each row)
                const edge = await ev(`(() => { const b = document.querySelector('#skills-view .dt-box'), r = b.getBoundingClientRect(), cs = getComputedStyle(b), row = b.querySelector('tr.dt-row'), btn = row && row.querySelector('.dt-mail-open, button'), tr = btn && btn.getBoundingClientRect(); const rows = [...b.querySelectorAll('tr.dt-row')]; return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, borderL: cs.borderLeftWidth, radius: cs.borderTopLeftRadius, mail: b.classList.contains('dt-mail-on'), rowsMail: rows.every(x => x.classList.contains('dt-mailed')), textLeft: btn ? Math.round(btn.querySelector('.dt-mail-title, .dt-name-text, span') ? btn.querySelector('.dt-mail-title, .dt-name-text, span').getBoundingClientRect().left : tr.left) : null, dividers: rows.slice(0, -1).every(x => [x, x.querySelector('td')].some(e => e && (parseFloat(getComputedStyle(e).borderBottomWidth) > 0 || parseFloat(getComputedStyle(e).borderTopWidth) > 0 || getComputedStyle(e).boxShadow !== 'none')) || (x.nextElementSibling && [x.nextElementSibling, x.nextElementSibling.querySelector('td')].some(e => e && parseFloat(getComputedStyle(e).borderTopWidth) > 0))), sortbar: !!b.querySelector('.dt-sortbar') && b.querySelector('.dt-sortbar').getClientRects().length > 0 }; })()`);
                check(`${tag}: the table runs edge to edge (no bordered inset box)`, edge.left <= 0 && edge.right >= edge.vw - 4 && edge.borderL === '0px' && edge.radius === '0px', JSON.stringify(edge));
                check(`${tag}: the rows are the shared mail rows with a divider, no Sort row, text inset at least 16 px`, edge.mail && edge.rowsMail && edge.dividers && !edge.sortbar && edge.textLeft >= 16, JSON.stringify(edge));
            }
            // Imported
            await ev(`document.querySelector(${JSON.stringify(host + ' .view-list-item[data-key="imported"]')}).click(); true`);
            await waitFor(`document.querySelectorAll('#skills-view tr.dt-row').length === 2`, `${tag}: Imported`, 6000);
            check(`${tag}: Imported lists the imported ones and the address says so`, (await names()).every(n => /release-notes|md-skill/.test(n)) && (await ev(`location.pathname`)) === '/skills/imported', JSON.stringify([await names(), await ev(`location.pathname`)]));
            // Agent created, then a reload keeps it
            await ev(`document.querySelector(${JSON.stringify(host + ' .view-list-item[data-key="agent-created"]')}).click(); true`);
            await waitFor(`document.querySelectorAll('#skills-view tr.dt-row').length === 2`, `${tag}: Agent created`, 6000);
            check(`${tag}: Agent created lists the two agents' skills, pending one included`, (await names()).some(n => /db-review/.test(n)) && (await names()).some(n => /pdf-forms/.test(n)) && (await ev(`location.pathname`)) === '/skills/agent-created');
            await load('/skills/agent-created', fs, theme);
            f = await folders(host);
            check(`${tag}: a reload on /skills/agent-created keeps the folder`, (await names()).length === 2 && f.find(x => x.key === 'agent-created').current, JSON.stringify([await names(), f]));
            // the status filter still works inside a folder, and the pending skill's notice
            await ev(`(() => { const s = document.querySelector('#skills-view select[aria-label="Show"]'); s.value = 'pending'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('#skills-view tr.dt-row').length === 1`, `${tag}: Pending in Agent created`, 6000);
            check(`${tag}: the Show filter still narrows a folder (pending only)`, /db-review/.test((await names())[0]));
            f = await folders(host);
            check(`${tag}: and the folders' counts do not move with it`, f.find(x => x.key === 'all').text === 'All skills5', JSON.stringify(f));
            await ev(`document.querySelector('#skills-view tr.dt-row').click(); true`);
            await waitFor(`!!document.querySelector('#skills-view .skills-banner')`, `${tag}: the pending skill's notice`, 6000);
            check(`${tag}: the pending skill's notice is there`, /Read it before you approve it/.test(await ev(`document.querySelector('#skills-view .skills-banner').innerText`)));
            if (!mobile) check(`${tag}: and the sidebar is still there with the folder open`, (await folders('#skills-nav-list')).length === 4);
            // Coral skills, All
            await load('/skills', fs, theme);
            await ev(`document.querySelector(${JSON.stringify(host + ' .view-list-item[data-key="coral-skills"]')}).click(); true`);
            await waitFor(`document.querySelectorAll('#skills-view tr.dt-row').length === 1`, `${tag}: Coral skills`, 6000);
            check(`${tag}: Coral skills lists the built-in one`, /working-in-a-coral-team/.test((await names())[0]));
            await ev(`document.querySelector(${JSON.stringify(host + ' .view-list-item[data-key="all"]')}).click(); true`);
            await waitFor(`document.querySelectorAll('#skills-view tr.dt-row').length === 5`, `${tag}: All again`, 6000);
            check(`${tag}: All is /skills again`, (await ev(`location.pathname`)) === '/skills');
            // search (the sidebar's box)
            if (!mobile) { await ev(`document.getElementById('skills-search').focus(); true`); await Input.insertText({ text: 'pdf' }); await waitFor(`document.querySelectorAll('#skills-view tr.dt-row').length === 1`, `${tag}: the search`, 6000); check(`${tag}: the search narrows the table`, /pdf-forms/.test((await names())[0])); await ev(`document.getElementById('skills-search').value = ''; document.getElementById('skills-search').dispatchEvent(new Event('input', { bubbles: true })); true`); }
            check(`${tag}: nothing scrolls sideways`, (await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)) <= 0);
            if (theme === 'dark' && fs === 16) await shot(`skills-sidebar-${w}`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Skills sidebar:\n  ' + problems.join('\n  '));
    console.log('PASS the Skills page has its sidebar: folders, counts, the address, search, the filter and the notice; a strip on a phone');
})().catch(e => { console.error(e); process.exit(1); });
