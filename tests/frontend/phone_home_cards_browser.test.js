// The phone's Agents page in Google Chat's style (#11096, slice A): under 601 px the page's top bar is the list header's first row (menu, a round search pill, the account button), under it the title with two chips (N need you, N working;
// pressing one filters the list, again clears it), and the agents as cards: a 48 px round avatar in the team's colour with the agent's initial, the state as a dot on its corner, the name, the short time and a two-line preview (the goal, or
// "No messages yet"), no border, the one that needs you in bold. 390 px with touch, 100% and 200% text, light and dark; 700 px keeps the sidebar's row. Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
        const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (d) { require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } };
    const SEED = `(() => { const rows = [['Orchestrator', 'team-a', { waiting_for_input: true, summary: 'Wire the access log into the dialog' }], ['UI/UX', 'team-a', { working: true, summary: 'The tab strip after the control is reviewed' }], ['Docs Writer', 'docs', { summary: '' }]];
        for (const [n, team] of rows) window.__m.add(n, 'A', 2, { sleeping: false, session_id: n + '-id', board_project: team }); return true; })()`;
    const box = e => `(() => { const b = ${e}.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; })()`;
    const overlap = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1;
    const open = async (w, fs, theme) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`${SEED}; true`);
        await waitFor(`(window.__qaState.liveSessions || []).length >= 3`, 'the agents', 10000);
        await ev(`(async () => { const s = await import((window.__coralStatic || '/static/') + 'state.js'); const by = { 'Orchestrator': { waiting_for_input: true, summary: 'Wire the access log into the dialog', staleness_seconds: 120 }, 'UI/UX': { working: true, summary: 'The tab strip after the control is reviewed', staleness_seconds: 5400 }, 'Docs Writer': { staleness_seconds: 200000 } }; for (const r of s.state.liveSessions) Object.assign(r, by[r.name] || {}); const r = await import((window.__coralStatic || '/static/') + 'render.js'); r.renderLiveSessions(s.state.liveSessions); return true; })()`);
        await ev(`document.documentElement.style.fontSize = '${fs}px'; document.documentElement.setAttribute('data-theme', '${theme}'); true`);
        await waitFor(`document.querySelectorAll('#mobile-session-list .session-group-item').length >= 3 && !!document.querySelector('#mobile-agent-list .phone-chips')`, `${w}@${fs}: the cards`, 10000);
        await waitFor(`document.querySelector('#mobile-session-list .session-group-item .session-avatar').getBoundingClientRect().width === 48`, `${w}@${fs}: the card styles`, 6000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [fs, theme] of [[16, 'light'], [16, 'dark'], [32, 'light']]) {
            await open(390, fs, theme);
            const tag = `390@${fs} ${theme}`;
            { // the pill filters agents by name; the line under it sends the same words to the chats' search (the Mobile Beta Tester's "0 of 6 agents" for words from a chat)
                await ev(`(() => { const i = document.querySelector('#mobile-agent-list .mobile-search-input'); i.value = 'build'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
                await waitFor(`!document.getElementById('agent-search-all-chats').hidden`, `${tag}: the all-chats line appears`, 4000);
                const pb = await ev(box(`document.querySelector('#mobile-agent-list .mobile-search-input')`)), ab = await ev(box(`document.getElementById('agent-search-all-chats')`));
                assert.ok(ab.w > 0 && ab.t >= pb.b - 1 && ab.r <= 390 + 0.5 && /Search all chats for .build./.test(await ev(`document.getElementById('agent-search-all-chats').textContent`)), `${tag}: "Search all chats for build" sits under the pill: ` + JSON.stringify({ pb, ab }));
                await ev(`(() => { const i = document.querySelector('#mobile-agent-list .mobile-search-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
                await waitFor(`document.getElementById('agent-search-all-chats').hidden`, `${tag}: the line goes with the words`, 4000);
            }
            assert.equal(await ev(`getComputedStyle(document.querySelector('header.top-bar')).display`), 'none', `${tag}: the page's top bar is the list header's first row`);
            { // a card's kebab: its whole 44 px hit area is inside the card (it hung past the right edge, QA Reviewer 2's nit on #11143)
                const k = await ev(`(() => { const T = ${require('./helpers/touch_area').TOUCH_AREA}; return [...document.querySelectorAll('#mobile-session-list .session-group-item')].map(li => { const a = T(li.querySelector('.sidebar-kebab-btn')), c = li.getBoundingClientRect(); return { area: [Math.round(a.l - c.left), Math.round(c.right - a.r)], w: Math.round(a.w), inside: a.l >= c.left - 0.5 && a.r <= c.right + 0.5 && a.t >= c.top - 0.5 && a.b <= c.bottom + 0.5, over: Math.round(a.r - c.right) }; }); })()`);
                assert.ok(k.length >= 3 && k.every(x => x.w >= 44 && x.inside), `${tag}: every card's kebab hit area (44 px) is inside the card: ` + JSON.stringify(k));
            }
            const menu = await ev(box(`document.querySelector('#mobile-agent-list .phone-menu-btn')`)), pill = await ev(box(`document.querySelector('#mobile-agent-list .mobile-search-input')`)), acct = await ev(box(`document.querySelector('#mobile-agent-list .phone-account-btn')`));
            assert.ok(menu.w >= 44 && menu.h >= 44 && acct.w >= 44 && acct.h >= 44 && pill.h >= 44, `${tag}: menu, search pill and account are 44 px targets: ` + JSON.stringify({ menu, pill, acct }));
            assert.ok(Math.abs((menu.t + menu.b) / 2 - (pill.t + pill.b) / 2) <= 3 && Math.abs((acct.t + acct.b) / 2 - (pill.t + pill.b) / 2) <= 3, `${tag}: one row: ` + JSON.stringify({ menu, pill, acct }));
            assert.ok(menu.r <= pill.l && pill.r <= acct.l && acct.r <= 390, `${tag}: menu, pill and account side by side, inside the screen`);
            assert.match(await ev(`document.querySelector('#mobile-agent-list .mobile-search-input').placeholder`), /Search agents and messages/, `${tag}: the pill says what it searches`);
            const chips = await ev(`[...document.querySelectorAll('#mobile-agent-list .phone-chip')].filter(c => !c.hidden).map(c => c.textContent.trim())`);
            assert.deepEqual(chips, ['1 need you', '1 working'], `${tag}: the chips count the feed`);
            const cards = await ev(`[...document.querySelectorAll('#mobile-session-list .session-group-item')].map(li => { const q = s => li.querySelector(s), r = e => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; }, av = q('.session-avatar'), dot = q('.session-dot'), nm = q('.session-label'), tm = q('.session-time'), pv = q('.session-preview'), cs = getComputedStyle(li);
                return { name: nm.textContent.trim(), avatar: r(av), avW: Math.round(av.getBoundingClientRect().width), initial: av.textContent, color: getComputedStyle(av).backgroundColor, dot: r(dot), nameBox: r(nm), time: tm.textContent.trim(), timeBox: r(tm), preview: pv.textContent.trim(), previewShown: getComputedStyle(pv).display !== 'none', border: cs.borderTopWidth, radius: parseFloat(cs.borderTopLeftRadius), h: Math.round(li.getBoundingClientRect().height), weight: getComputedStyle(nm.querySelector('.session-label-name') || nm).fontWeight, w: Math.round(li.getBoundingClientRect().width) }; })`);
            assert.equal(cards.length, 3, `${tag}: three cards`);
            for (const c of cards) {
                assert.ok(c.avW === 48 && c.initial === c.name[0].toUpperCase(), `${tag}: ${c.name}: a 48 px avatar with the initial: ` + JSON.stringify(c));
                assert.ok(c.dot.l >= c.avatar.l + 24 && c.dot.t >= c.avatar.t + 24 && c.dot.r <= c.avatar.r + 8 && c.dot.b <= c.avatar.b + 8, `${tag}: ${c.name}: the state dot sits on the avatar's lower corner: ` + JSON.stringify({ dot: c.dot, avatar: c.avatar }));
                assert.ok(c.previewShown && c.preview.length > 0, `${tag}: ${c.name}: a preview line: ` + JSON.stringify(c));
                assert.ok(c.border === '0px' && c.radius >= 12 && c.h >= 72, `${tag}: ${c.name}: a borderless rounded card, at least 72 px: ` + JSON.stringify(c));
                assert.ok(!overlap(c.nameBox, c.timeBox) && c.timeBox.r <= c.w + 8 + 8, `${tag}: ${c.name}: the name and the time do not overlap: ` + JSON.stringify(c));
            }
            const byName = Object.fromEntries(cards.map(c => [c.name, c]));
            assert.ok(Number(byName['Orchestrator'].weight) >= 600 && Number(byName['UI/UX'].weight) < 600, `${tag}: the agent that needs you is bold: ` + JSON.stringify([byName['Orchestrator'].weight, byName['UI/UX'].weight]));
            assert.equal(byName['Docs Writer'].preview, 'No messages yet', `${tag}: no summary: No messages yet`);
            assert.deepEqual([byName['Orchestrator'].time, byName['UI/UX'].time, byName['Docs Writer'].time], ['2m', '1h', '2d'], `${tag}: the short times`);
            assert.notEqual(byName['Orchestrator'].color, byName['Docs Writer'].color, `${tag}: a team's colour: another team, another colour`);
            assert.equal(byName['Orchestrator'].color, byName['UI/UX'].color, `${tag}: one team, one colour`);
            assert.ok(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), `${tag}: nothing scrolls sideways`);
            await shot(`phone-home-${theme}-${fs}`);
            if (fs === 16 && theme === 'light') {
                await ev(`document.querySelector('[data-phone-chip="needs_input"]').click(); true`);
                await waitFor(`document.querySelectorAll('#mobile-session-list .session-group-item').length === 1 && document.querySelector('[data-phone-chip="needs_input"]').getAttribute('aria-pressed') === 'true'`, `${tag}: the need-you chip filters to that agent`, 6000);
                await ev(`document.querySelector('[data-phone-chip="needs_input"]').click(); true`);
                await waitFor(`document.querySelectorAll('#mobile-session-list .session-group-item').length === 3`, `${tag}: and again clears it`, 6000);
                await ev(`document.querySelector('#mobile-agent-list .phone-menu-btn').click(); true`);
                await waitFor(`!document.getElementById('nav-more-menu').hidden && document.querySelectorAll('#nav-more-menu .nav-more-item').length > 1`, `${tag}: the menu button opens the menu`, 4000);
                await ev(`document.querySelector('#mobile-agent-list .phone-menu-btn').click(); true`);
            }
        }
        // a wider screen keeps the sidebar's row: no avatar, no time, no preview
        await Emulation.setDeviceMetricsOverride({ width: 700, height: 844, deviceScaleFactor: 1, mobile: true });
        await waitFor(`getComputedStyle(document.querySelector('.session-avatar')).display === 'none'`, '700 px: the card parts go', 6000);
        const wide = await ev(`['.session-avatar', '.session-time', '.session-preview'].map(s => { const e = document.querySelector('#mobile-session-list ' + s) || document.querySelector(s); return e ? getComputedStyle(e).display : 'absent'; })`);
        assert.deepEqual(wide, ['none', 'none', 'none'], '700 px: the sidebar row, without the card parts: ' + JSON.stringify(wide));
        console.log('PASS the phone Agents page is Google Chat cards');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
