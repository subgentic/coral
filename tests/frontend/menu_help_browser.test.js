// The sidebar's team and agent menus say what each item does (#15466, the Operator's ask), failing first. Each item is described by a line a screen reader reads on focus (aria-describedby); at 1280 px a mouse or the keyboard shows the line of the item
// under it in the menu's footer; on a touch screen (a coarse pointer, no hover) every item shows its line under its label and there is no footer. The wording is the approved list (Orchestrator, #15466), from the server code: Sleep, Wake, ResetTeam, KillTeam, Delete team.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `menuhelp-${Date.now() % 100000}`;
const TEAM_WORDS = {
    'Add Agent': 'Adds another agent to this team. The agents already running are not touched.',
    'Sleep Team': "Stops every agent's terminal and pauses the board. Chats, files, tasks and goals stay; Wake Team continues each conversation.",
    'Save as Template': "Saves this team's agents, instructions and settings as a template to launch again. Chats, messages and goals are not saved.",
    'More': "Shows the team's other actions.",
    'Reset team (clear context)': 'Stops each agent and starts it again from its first instructions in a new chat, so its context is cleared. Old chats stay in History; the board, tasks, goals and files are kept.',
    'Stop team': "Ends every agent's process in the team now. Chats stay in History; the board, tasks and goals are kept. A Hermes agent's conversation is deleted with it.",
    'Remove team': 'Deletes the team for good: its messages, tasks, goals, members, reminders, settings and more; the dialog lists everything. Chats stay in History and files are not touched. Only when no agent is running.',
};
const AGENT_WORDS = {
    'Restart, same settings': 'Starts a fresh conversation with the same settings; the instructions are sent again.',
    'Restart with changes': 'Starts a fresh conversation with the settings you choose; the instructions are sent again.',
    'Sleep': 'Stops the terminal. The chat and files stay; Wake continues the conversation.',
    'Stop session': 'Ends its process now. Its chat stays in History.',
};

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const run = async (width, mobile) => {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: false });
            await Emulation.setEmulatedMedia({ features: [{ name: 'pointer', value: mobile ? 'coarse' : 'fine' }, { name: 'hover', value: mobile ? 'none' : 'hover' }] }); // a touch screen: the sidebar's own layout is the desktop's, the pointer is what changes
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
            await seed(ev, TEAM); await openTeam(ev, waitFor, TEAM); await settle(400);
            for (const [kind, prefix, words] of [['team', 'More actions for ' + TEAM, TEAM_WORDS], ['agent', 'More actions for Orchestrator', AGENT_WORDS]]) {
                await ev(`window.closeSidebarKebabs && window.closeSidebarKebabs(); true`);
                const sel = await ev(`(() => { const A = window.__na; const t = [...document.querySelectorAll('[aria-haspopup="menu"][aria-controls]')].filter(A.vis).find(x => A.name(x).startsWith(${JSON.stringify(prefix)})); if (!t) return null; t.id = 'mh-toggle-' + ${JSON.stringify(kind)}; return '#' + t.id; })()`);
                if (!sel) { problems.push(`${mobile ? 'touch' : 'mouse'} ${width}px: no "${prefix}" button; toggles: ` + await ev(`[...document.querySelectorAll('[aria-haspopup="menu"][aria-controls]')].map(x => window.__na.name(x).slice(0, 30) + (window.__na.vis(x) ? '' : ' (hidden)')).join(' | ')`)); continue; }
                await ev(`document.querySelector(${JSON.stringify(sel)}).click(); true`);
                await waitFor(`!!document.getElementById(document.querySelector(${JSON.stringify(sel)}).getAttribute('aria-controls')).querySelector('.menu-help-foot')`, 'the menu is described', 4000).catch(() => problems.push(`${mobile ? 'touch' : 'mouse'} ${width}px ${kind}: opening the menu did not describe its items`));
                await settle(300);
                const got = await ev(`(() => { const t = document.querySelector(${JSON.stringify(sel)}), m = document.getElementById(t.getAttribute('aria-controls')); if (m.classList.contains('team-menu-more')) return null; const more = m.querySelector('.team-menu-more'); if (more) { more.hidden = false; }
                    const out = {}; for (const i of m.querySelectorAll('.overflow-menu-item')) { const l = i.textContent.trim().replace(/\\s+/g, ' ').replace(/ needs Launch$/, '').replace('…', '').toLowerCase(); const d = document.getElementById(i.getAttribute('aria-describedby') || ''); const r = d && d.getBoundingClientRect(); out[l] = d ? { text: d.textContent, shown: r.width > 0 && r.height > 0 } : null; }
                    const f = m.querySelector('.menu-help-foot'); return { items: out, foot: f ? { shown: f.getClientRects().length > 0 } : null }; })()`);
                if (!got) continue;
                for (const [label, words_] of Object.entries(words)) {
                    const g = got.items[label.toLowerCase()];
                    if (!g) { if (kind === 'team' || label !== 'Sleep') problems.push(`${mobile ? 'touch' : 'mouse'} ${width}px ${kind}: "${label}" has no description (${Object.keys(got.items).join(' | ')})`); continue; }
                    if (g.text !== words_) problems.push(`${mobile ? 'touch' : 'mouse'} ${width}px ${kind}: "${label}" says "${g.text}", not "${words_}"`);
                    if (mobile && !g.shown) problems.push(`${mobile ? 'touch' : 'mouse'} ${width}px ${kind}: on a phone "${label}" does not show its line`);
                    if (!mobile && g.shown) problems.push(`${mobile ? 'touch' : 'mouse'} ${width}px ${kind}: "${label}" shows its line inline on a desktop (it belongs in the footer)`);
                }
                if (mobile && got.foot && got.foot.shown) problems.push(`${mobile ? 'touch' : 'mouse'} ${width}px ${kind}: the footer is shown on a phone`);
                if (!mobile) {
                    if (!got.foot || !got.foot.shown) problems.push(`${mobile ? 'touch' : 'mouse'} ${width}px ${kind}: no footer`);
                    else {
                        const first = Object.keys(words).find(l => got.items[l.toLowerCase()]);
                        const ok = await ev(`(() => { const t = document.querySelector(${JSON.stringify(sel)}), m = document.getElementById(t.getAttribute('aria-controls')), i = [...m.querySelectorAll('.overflow-menu-item')].find(i => i.textContent.trim().replace(/\\s+/g, ' ').toLowerCase().startsWith(${JSON.stringify(first.toLowerCase())})); if (i) i.focus(); return i ? true : [...m.querySelectorAll('.overflow-menu-item')].map(i => i.textContent.trim()).join('|'); })()`);
                        if (ok !== true) { problems.push(`${mobile ? 'touch' : 'mouse'} ${width}px ${kind}: no item to focus for "${first}": ${ok}`); continue; }
                        await settle(100);
                        const foot = await ev(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); return document.getElementById(t.getAttribute('aria-controls')).querySelector('.menu-help-foot').textContent; })()`);
                        if (foot !== words[first]) problems.push(`${mobile ? 'touch' : 'mouse'} ${width}px ${kind}: focus on "${first}" shows "${foot}" in the footer`);
                    }
                }
            }
        };
        await run(1280, false);
        // A phone (390 px wide: the sidebar's menus are drawn in the phone's own list, hidden here): the lines are drawn under each label and there is no footer. The menus are described by the module itself, as a tap would.
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM); await openTeam(ev, waitFor, TEAM); await settle(400);
        const phone = await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'menu_help.js'); const out = { lines: 0, wrong: [], foot: [] };
            for (const menu of document.querySelectorAll('.sidebar-kebab-menu')) { m.describe(menu); for (const i of menu.querySelectorAll('.overflow-menu-item[aria-describedby]')) { const d = document.getElementById(i.getAttribute('aria-describedby')); out.lines++; if (getComputedStyle(d).display !== 'block') out.wrong.push(m.labelOf(i) + ': ' + getComputedStyle(d).display); }
                const f = menu.querySelector('.menu-help-foot'); if (f && getComputedStyle(f).display !== 'none') out.foot.push('shown'); }
            return out; })()`);
        if (!phone.lines) problems.push('phone: no item was described');
        if (phone.wrong.length) problems.push('phone: lines not drawn under their labels: ' + phone.wrong.slice(0, 4).join(', '));
        if (phone.foot.length) problems.push('phone: the footer is shown');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('menu_help_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
