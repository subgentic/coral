// Team settings' search is a compact box at the top right of the dialog's header (#16542, the Operator's ask, was #15874): about 240 to 280 px wide, on the title's row, with the
// "Only the Operator..." line still under the title (not beside it); on a phone (390 px) it goes under the title and fills the width. It still searches (a match is marked, the count is said).
// Real isolated board seeded by the team page helpers. 1440 and 390 px, dark and light; shots go to CORAL_SCREENSHOT_DIR.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, openSettings } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-tsh-${Date.now() % 100000}`;
const GEO = `(() => { const m = document.querySelector('.team-settings-modal'), r = e => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width) }; };
    const head = m.querySelector('.modal-header'), title = head.querySelector('h3'), input = m.querySelector('.tsg-search-input'), lead = m.querySelector('.sv-lead');
    return { inHeader: !!input && head.contains(input), head: r(head), title: r(title), input: input ? r(input) : null, lead: lead ? r(lead) : null, leadText: lead ? lead.textContent : null }; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const problems = [];
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, theme] of [[1440, 900, false, 'dark'], [1440, 900, false, 'light'], [390, 844, true, 'dark'], [390, 844, true, 'light']]) {
            const at = `${w} ${theme}: `, check = (ok, msg) => { if (!ok) problems.push(at + msg); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
            await ev(`import((window.__coralStatic || '/static/') + 'settings_core.js').then(m => m.applyTheme('${theme}')).then(() => true)`);
            await seed(ev, TEAM);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM); await settle(800);
            await openSettings(ev, settle);
            await waitFor(`!!document.querySelector('.team-settings-modal .tsg-search-input') && !!document.querySelector('.team-settings-modal .sv-lead')`, `${at}the dialog with its search`, 10000);
            await settle(500);
            const g = await ev(GEO);
            check(g.inHeader, 'the search box is in the dialog header');
            if (g.input) {
                if (!mobile) {
                    check(g.input.w >= 240 && g.input.w <= 280, `the box is compact, 240 to 280 px (${g.input.w})`);
                    check(g.input.t >= g.head.t && g.input.b <= g.head.b, `the box is on the header's row: ${JSON.stringify({ head: g.head, input: g.input })}`);
                    check(g.input.t < g.title.b && g.input.b > g.title.t, `the box is level with the title: ${JSON.stringify({ title: g.title, input: g.input })}`);
                    check(g.head.r - g.input.r >= 16 && g.head.r - g.input.r <= 40, `the box is at the header's right edge (${g.head.r - g.input.r} px in)`);
                } else {
                    check(g.input.t >= g.title.b - 1, `on a phone the box is under the title: ${JSON.stringify({ title: g.title, input: g.input })}`);
                    check(g.input.w >= g.head.w - 40, `on a phone the box fills the width (${g.input.w} of ${g.head.w})`);
                }
            }
            check(!!g.lead && g.lead.t >= g.head.b - 1 && /Only the Operator on this computer can change these\./.test(g.leadText || ''), `the "Only the Operator..." line stays under the title: ${JSON.stringify({ lead: g.lead, head: g.head })}`);
            // it still searches
            await ev(`(() => { const i = document.querySelector('.team-settings-modal .tsg-search-input'); i.focus(); i.value = 'health'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`!!document.querySelector('.team-settings-modal .tsg-search-status') && !document.querySelector('.team-settings-modal .tsg-search-status').hidden && /match/.test(document.querySelector('.team-settings-modal .tsg-search-status').textContent)`, `${at}the search says what matched`, 6000);
            check(await ev(`document.querySelectorAll('.team-settings-modal [data-match]').length > 0`), 'a matching row is marked');
            await shot(`team-settings-search-${w}-${theme}`);
            await ev(`(() => { const i = document.querySelector('.team-settings-modal .tsg-search-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        }
    } finally { try { await removeBoards(ev, [TEAM]); } catch (e) {} try { await client.close(); } catch (e) {} }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('team_settings_search_header_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
