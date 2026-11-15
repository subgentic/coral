// One row in every sidebar (#15820, Design A2): Inbox, Automations, Skills and Analytics each list their rows as a glyph, the name and (where there is a number) a grey count, with the glyphs on the same
// vertical line (every glyph one the shipped font holds), and Analytics names its sections (Spend, Team, Work) as the others do. The glyph is decoration: a row's text is still only its name. 1440 px, dark and light; shots go to CORAL_SCREENSHOT_DIR.
const fs = require('node:fs');
const path = require('node:path');
const SUBSET = new Set(fs.readFileSync(path.join(__dirname, 'fixtures', 'material-icons.names.txt'), 'utf8').split('\n').filter(Boolean)); // the glyph font is a subset: a name outside it draws as its letters
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const TABS = [['hub-inbox', 'Inbox'], ['automations', 'Automations'], ['skills', 'Skills'], ['tokens', 'Analytics']];
// where a row's glyph is and what the row says, whichever way the list is drawn (the shared view list, or Analytics' own buttons with a drawn glyph)
const ROWS = `(() => { const pane = [...document.querySelectorAll('.sidebar-pane')].find(p => !p.hidden && p.getClientRects().length); if (!pane) return null;
    const vis = e => e.getClientRects().length > 0;
    const items = [...pane.querySelectorAll('.view-list-item, #cost-nav-list .row-btn')].filter(vis);
    return { pane: pane.dataset.pane, icons: items.map(b => b.classList.contains('view-list-item') ? (b.querySelector('.view-list-icon') || {}).dataset?.icon : b.dataset.icon).filter(Boolean), heads: [...pane.querySelectorAll('.view-list-title')].filter(vis).map(h => h.textContent.trim()), rows: items.map(b => {
        const vl = b.classList.contains('view-list-item'), icon = vl ? b.querySelector('.view-list-icon') : null, cs = getComputedStyle(b, '::before');
        const glyph = vl ? !!icon : (b.dataset.icon && cs.content && cs.content !== 'none' && cs.content !== 'normal' && cs.content !== '""') ? true : false;
        const left = vl ? (icon ? Math.round(icon.getBoundingClientRect().left * 10) / 10 : null) : Math.round((b.getBoundingClientRect().left + parseFloat(getComputedStyle(b).paddingLeft)) * 10) / 10;
        const count = b.querySelector('.view-list-count'), name = (b.querySelector('.view-list-name') || b).textContent.trim();
        return { name, glyph, left, text: b.textContent.trim().replace(/\\s+/g, ' '), count: count ? count.textContent.trim() : null, countColor: count ? getComputedStyle(count).color : null, nameColor: getComputedStyle(vl ? b.querySelector('.view-list-name') : b).color, top: Math.round(b.getBoundingClientRect().top) };
    }) }; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
        for (const theme of ['dark', 'light']) {
            await ev(`import((window.__coralStatic || '/static/') + 'settings_core.js').then(m => m.applyTheme('${theme}')).then(() => true)`);
            const lefts = {};
            for (const [tab, name] of TABS) {
                const at = `${theme} ${name}: `;
                await ev(`window.switchNavTab('${tab}'); true`);
                await waitFor(`(() => { const p = [...document.querySelectorAll('.sidebar-pane')].find(p => !p.hidden && p.getClientRects().length); return !!p && p.dataset.pane === '${tab}' && p.querySelectorAll('.view-list-item, #cost-nav-list .row-btn').length >= 3; })()`, `${at}the sidebar's rows`, 15000);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: the glyph font and the counts settle
                const r = await ev(ROWS);
                const rows = r.rows.filter(x => x.name !== 'Advanced');
                check(rows.length >= 3 && rows.every(x => x.glyph), `${at}every row has a glyph: ${JSON.stringify(rows.filter(x => !x.glyph).map(x => x.name))}`);
                check(name !== 'Analytics' || rows.every(x => x.text === x.name), `${at}an Analytics row's text is its name (the glyph is drawn, not written): ${JSON.stringify(rows.filter(x => x.text !== x.name).map(x => x.text))}`);
                check(r.icons.every(i => SUBSET.has(i) || /^(cli:|saved-bookmark)/.test(i)), `${at}every glyph is in the shipped font: ${JSON.stringify(r.icons.filter(i => !SUBSET.has(i) && !/^(cli:|saved-bookmark)/.test(i)))}`);
                const ls = [...new Set(rows.map(x => x.left))]; check(ls.length === 1, `${at}the glyphs are on one line: ${JSON.stringify(ls)}`); lefts[name] = ls[0];
                if (name === 'Analytics') check(['Spend', 'Team', 'Work'].every(h => r.heads.includes(h)), `${at}Analytics names its sections: ${JSON.stringify(r.heads)}`);
                else check(r.heads.length >= 1, `${at}the sections are named: ${JSON.stringify(r.heads)}`);
                await shot(`sidebar-rows-${name.toLowerCase()}-${theme}`);
                if (tab !== 'hub-inbox') { // the collapsed rail: an icon per row, the open one marked (the Inbox's own rail is pinned by inbox_rail_search_browser)
                    await ev(`document.querySelector('.layout').classList.add('sidebar-collapsed'); true`);
                    await waitFor(`document.querySelectorAll('#sidebar-rail-${tab} .sidebar-rail-folder').length >= 3 && [...document.querySelectorAll('#sidebar-rail-${tab} .sidebar-rail-folder')].every(b => b.getClientRects().length > 0)`, `${at}the collapsed rail shows an icon per row`, 8000);
                    const rail = await ev(`[...document.querySelectorAll('#sidebar-rail-${tab} .sidebar-rail-folder')].map(b => ({ label: b.getAttribute('aria-label'), glyph: b.querySelector('.view-list-icon').textContent, current: b.getAttribute('aria-current') === 'page', w: Math.round(b.getBoundingClientRect().width) }))`);
                    check(rail.length === rows.length || name === 'Analytics', `${at}the rail has a button per row: ${rail.length} for ${rows.length}`);
                    check(rail.filter(x => x.current).length === 1, `${at}the rail marks the open one: ${JSON.stringify(rail.filter(x => x.current).map(x => x.label))}`);
                    check(rail.every(x => SUBSET.has(x.glyph) && x.label), `${at}every rail glyph is in the font and every button is named: ${JSON.stringify(rail.filter(x => !SUBSET.has(x.glyph) || !x.label))}`);
                    await shot(`sidebar-rail-${name.toLowerCase()}-${theme}`);
                    await ev(`document.querySelector('.layout').classList.remove('sidebar-collapsed'); true`);
                }
            }
            const all = [...new Set(Object.values(lefts))]; check(all.length === 1, `${theme}: the four sidebars put their glyphs on one line: ${JSON.stringify(lefts)}`);
        }
        // a phone (390 px): the lists with their glyphs still fit the screen (no sideways scroll), shots of each
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
        for (const theme of ['dark', 'light']) {
            await ev(`import((window.__coralStatic || '/static/') + 'settings_core.js').then(m => m.applyTheme('${theme}')).then(() => true)`);
            for (const [tab, name] of TABS.filter(t => t[0] !== 'hub-inbox')) {
                await ev(`window.switchNavTab('${tab}'); true`);
                if (tab === 'tokens') { await waitFor(`!!document.querySelector('.cost-phone-back') || [...document.querySelectorAll('#cost-nav-list .row-btn')].some(b => b.getClientRects().length)`, `390 ${theme} ${name}: Overview or the list`, 15000); await ev(`(() => { const b = document.querySelector('.cost-phone-back'); if (b && b.getClientRects().length) b.click(); return true; })()`); } // on a phone Analytics opens a view: the way back shows the list
                await waitFor(`[...document.querySelectorAll('.view-list-item, #cost-nav-list .row-btn')].filter(b => b.getClientRects().length).length >= 3`, `390 ${theme} ${name}: the list`, 15000);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: the glyph font and the counts settle
                check(await ev(`document.documentElement.scrollWidth <= window.innerWidth`), `390 ${theme} ${name}: the page does not scroll sideways`);
                await shot(`sidebar-rows-${name.toLowerCase()}-390-${theme}`);
            }
        }
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('sidebar_rows_15820_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
