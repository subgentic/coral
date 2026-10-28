// The Link team dialog by keyboard and screen reader (#9892, the pass on #9888): opened from the team's menu by keys (kebab, Enter, arrows, Enter); the focus goes to the dialog's title once the links are in (it sat on Close at the bottom), stays inside the dialog while
// Tab goes round (the rows' Revoke buttons, the form, Close), and Escape returns it to the team's menu button (it fell to the page); Revoke asks with Back focused (the safe answer, not the destructive button), Escape in the question goes back to the list with the keyboard on
// that row's Revoke, Back does the same, and a done revoke or link is said (a status) with the keyboard on the list's heading, not lost; each Revoke is named for its team, computer, direction and state; at 200% text the avatar circle grows with the text and nothing runs
// off the dialog; on a phone every row fits and the Revoke is a 44 px target. The same stubbed Hub routes as team_link_dialog_browser. 1280 and 390 px; CORAL_SCREENSHOT_DIR saves pictures.
// (the first lines below are the stubs of team_link_dialog_browser)
// The Link team dialog (#9888, slice 1, to the pictures the operator approved): "Link team..." in a team's menu after Team settings, only when the Hub's account field team_link_dialog is true; the dialog
// for links to teams on other computers (the Hub's relay routes, stubbed here: the page calls only those, checked at run time); Both ways is the default and is sent explicitly; each direction is its own row
// with its own Revoke (Not delivered and Old-style included); the Not delivered sentence is coral-hub Security's exact one; no View-only or offline computer and no named (non-generated) team is offered;
// a refusal and a rate limit are said in our words. 1280 and 390 px; CORAL_SCREENSHOT_DIR saves the pictures. Isolated dev server; run_cdp_suites.mjs finds it by name.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const SENTENCE = "That team isn't on that computer (it may have been deleted). Revoke this link, and link the team again if it was re-created.";
const OWN = '@s-own/b-aaaaaaaaaa';
const SERVERS = [{ id: 's-own', label: 'This Mac', online: true, effective_mode: 'launch' }, { id: 's-two', label: 'Studio Mac', online: true, effective_mode: 'interact' }, { id: 's-view', label: 'Viewer', online: true, effective_mode: 'view' }, { id: 's-off', label: 'Sleeping', online: false, effective_mode: 'launch' }, { id: 's-old', label: 'Old Mac', online: true, effective_mode: 'interact' }, { id: 's-low', label: 'Low Mac', online: true, effective_mode: 'interact' }];
const LINKS = [
    { id: 11, src_server_id: 's-two', src_team: 'b-bbbbbbbbbb', dst_server_id: 's-own', dst_team: 'b-aaaaaaaaaa', src_team_label: 'nightly', notice: { source: 'delivered', target: 'delivered' } },
    { id: 12, src_server_id: 's-own', src_team: 'b-aaaaaaaaaa', dst_server_id: 's-two', dst_team: 'b-bbbbbbbbbb', dst_team_label: 'nightly', notice: { source: 'unavailable', target: 'delivered' } },
    { id: 13, src_server_id: 's-two', src_team: 'b-cccccccccc', dst_server_id: 's-own', dst_team: 'b-aaaaaaaaaa', src_team_label: 'build-bots', notice: { source: 'delivered', target: 'not_delivered' } },
    { id: 14, src_server_id: 's-two', src_team: 'b-eeeeeeeeee', dst_server_id: 's-own', dst_team: 'b-aaaaaaaaaa', src_team_label: 'old-team', notice: { source: 'delivered', target: 'delivered' }, legacy: true },
    { id: 15, src_server_id: 's-x', src_team: 'b-xxxxxxxxxx', dst_server_id: 's-y', dst_team: 'b-yyyyyyyyyy', notice: { source: 'delivered', target: 'delivered' } },
];
const PROJECTS = [{ project: 'b-dddddddddd', board_label: 'research-crew' }, { project: 'legacy_board', board_label: 'legacy' }];
const ALLOWED = [/^GET \/api\/sessions\/live$/, /^GET \/api\/relay\/links$/, /^POST \/api\/relay\/links$/, /^DELETE \/api\/relay\/links\/\d+$/, /^GET \/api\/servers$/, /^GET \/api\/remote\/[\w-]+\/api\/board\/projects$/, /^GET \/api\/account$/];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const dlg = (js) => ev(`(() => { const d = document.getElementById('team-link-dialog'); return ${js}; })()`);
    const click = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`(() => {
                window.__calls = []; window.__post = { status: 200 }; window.__links = ${JSON.stringify(LINKS)};
                const real = window.fetch.bind(window);
                const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
                window.fetch = async (url, opt = {}) => {
                    const u = String(url), m = (opt.method || 'GET').toUpperCase(), path = u.split('?')[0];
                    const hubby = /^\\/api\\/(relay\\/|servers$|remote\\/|account$)/.test(path);
                    if (!hubby) return real(url, opt);
                    window.__calls.push(m + ' ' + path + (opt.body ? ' ' + opt.body : ''));
                    if (path === '/api/account') return json(200, { team_link_dialog: window.__flag === true });
                    if (path === '/api/relay/links' && m === 'GET') return json(200, { links: window.__links, relay_artifacts_available: true, relay_artifacts_enabled: true });
                    if (path === '/api/relay/links' && m === 'POST') return json(window.__post.status, window.__post.status === 200 ? { ok: true } : { error: window.__post.code || 'not_found' });
                    if (/^\\/api\\/relay\\/links\\/\\d+$/.test(path) && m === 'DELETE') { window.__links = window.__links.filter(l => String(l.id) !== path.split('/').pop()); return json(200, { ok: true }); }
                    if (path === '/api/servers') return json(200, { servers: window.__localRow ? [...${JSON.stringify(SERVERS)}, { id: 'local', label: 'Here', online: false, effective_mode: 'launch' }] : ${JSON.stringify(SERVERS)} });
                    if (/^\\/api\\/remote\\/[\\w-]+\\/api\\/board\\/projects$/.test(path)) return json(200, ${JSON.stringify(PROJECTS)});
                    return json(404, {});
                };
                return true; })()`);



            const KEYS = { Tab: [9, 'Tab'], Enter: [13, 'Enter'], Escape: [27, 'Escape'], ArrowDown: [40, 'ArrowDown'] };
            const key = async (k, shift) => { const [code, name] = KEYS[k]; const text = k === 'Enter' ? '\r' : undefined; const mods = shift ? 8 : 0; await client.Input.dispatchKeyEvent({ type: text ? 'keyDown' : 'rawKeyDown', key: k, code: name, windowsVirtualKeyCode: code, text, modifiers: mods }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: name, windowsVirtualKeyCode: code, modifiers: mods }); await new Promise(r => setTimeout(r, 150)); }; // sleep-ok: the key's handlers run
            const settle = () => new Promise(r => setTimeout(r, 300)); // sleep-ok: the dialog is drawn
            const act = () => ev(`(() => { const e = document.activeElement; return e ? { tag: e.tagName, id: e.id || '', cls: String(e.className || ''), label: (e.getAttribute('aria-label') || e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90), inDialog: !!e.closest('#team-link-dialog'), linkId: e.dataset ? e.dataset.linkId || '' : '' } : null; })()`);
            const kebab = `document.querySelector('.session-board-card .sidebar-kebab-btn')`;
            const check = (ok, msg) => { if (!ok) problems.push(`${label}: ${msg}`); };
            const reopen = async () => { if (await dlg('d && d.open')) return; await ev(`window.showTeamLinkDialog('alpha', {}); true`); await waitFor(`!!document.querySelector('#team-link-dialog .team-link-row')`, `${label}: the links again`, 8000); await settle(); }; // a step that closed the dialog does not stop the steps after it
            const fx = async (sel, nth = 0) => { await reopen(); const ok = await ev(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${nth}]; if (!e) return false; e.focus(); return true; })()`); if (!ok) problems.push(`${label}: no ${sel} to focus`); return ok; };
            await ev(`(() => { window.switchNavTab('agents'); window._coralSetLiveSessions([{ session_id: 'a-dev', name: 'dev-1', agent_type: 'claude', working_directory: '/tmp/alpha', sleeping: false, board_project: 'alpha', display_name: 'Frontend Dev' }]); window.__flag = true; window.__localRow = true; return true; })()`); // the item is for a team on the viewer's own computer: the account lists it (#9888)
            await waitFor(`document.querySelectorAll('.session-board-card').length >= 1`, 'the team card', 10000);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_link_flag.js'); await m.initTeamLinkFlag(); return true; })()`);
            await waitFor(`[...document.querySelectorAll('.session-board-card .sidebar-kebab-menu button[data-on-click]')].some(b => b.dataset.onClick === 'team-link')`, 'the Link team item', 6000);
            await ev(`window.__realLink = window.showTeamLinkDialog; window.showTeamLinkDialog = (b, o) => window.__realLink(${JSON.stringify(OWN)}, { ...(o || {}), cloud: true, board: b }); true`); // the item's call, with this test's team in the Hub's words
            const openByKeys = async () => {
                await ev(`${kebab}.focus(); true`); await key('Enter');
                for (let i = 0; i < 14; i++) { if (/Link team/.test((await act()).label)) break; await key('ArrowDown'); }
                const onItem = (await act()).label; await key('Enter');
                await waitFor(`!!document.querySelector('#team-link-dialog .team-link-row')`, `${label}: the links`, 8000); await settle();
                return onItem;
            };
            check(/Link team/.test(await openByKeys()), 'the menu item Link team... is reached by the arrows and opened with Enter');
            // 1. where the keyboard starts and Tab goes round, inside the dialog
            const first = await act(); check(first.inDialog && first.id === 'team-link-title', `the focus starts on the dialog's title once the links are in (it was on Close): ${JSON.stringify(first)}`);
            const seq = []; for (let i = 0; i < 12; i++) { await key('Tab'); seq.push(await act()); }
            check(seq.every(a => a.inDialog || a.tag === 'BODY'), 'Tab never lands on a control of the page behind (a modal; the one stop on the document is the browser\'s own wrap): ' + JSON.stringify(seq.filter(a => !a.inDialog && a.tag !== 'BODY').slice(0, 2)));
            const order = seq.map(a => /^Revoke/.test(a.label) ? 'revoke' : a.id === 'team-link-computer' ? 'computer' : a.id === 'team-link-team' ? 'team' : a.id === 'team-link-direction' ? 'direction' : /^Link$/.test(a.label) ? 'link' : /^Close$/.test(a.label) ? 'close' : '?');
            check(order.slice(0, 9).join() === 'revoke,revoke,revoke,revoke,computer,team,direction,link,close', 'Tab goes through the rows\' Revoke buttons, then the form, then Close: ' + order.join());
            // 2. each Revoke is named for its link
            const names = await dlg(`[...d.querySelectorAll('.team-link-revoke')].map(b => b.getAttribute('aria-label'))`);
            check(names[0] === 'Revoke the link with nightly on Studio Mac, May message this team, Active' && /Not delivered$/.test(names[2]) && /Old-style, create again$/.test(names[3]), 'each Revoke is named for the team, the computer, the direction and the state: ' + JSON.stringify(names));
            // 3. Revoke asks with Back focused; Escape goes back to the row's Revoke
            await fx('#team-link-dialog .team-link-revoke', 1); const rid = (await act()).linkId;
            await key('Enter'); await settle(); const c1 = await act();
            check(c1.inDialog && /team-link-back/.test(c1.cls), `Revoke's question starts with Back focused, not the destructive button: ${JSON.stringify(c1)}`);
            await key('Escape'); await settle(); const c2 = await act();
            check(await dlg('d.open') && c2.inDialog && /team-link-revoke/.test(c2.cls) && c2.linkId === rid, `Escape in the question goes back to the list with the keyboard on that row's Revoke (the dialog stays open): open=${await dlg('d.open')} ${JSON.stringify(c2)}`);
            await fx('#team-link-dialog .team-link-revoke', 1); await key('Enter'); await settle(); await fx('#team-link-dialog .team-link-back'); await key('Enter'); await settle(); const c3 = await act();
            check(c3.inDialog && /team-link-revoke/.test(c3.cls) && c3.linkId === rid, `Back puts the keyboard on that row's Revoke: ${JSON.stringify(c3)}`);
            // 4. a done revoke is said, and the keyboard stays in the dialog
            await fx('#team-link-dialog .team-link-revoke', 1); await key('Enter'); await settle(); await fx('#team-link-dialog .team-link-go'); await key('Enter'); await new Promise(r => setTimeout(r, 700)); // sleep-ok: the call and the list
            const c4 = await act(), live = await dlg(`(d.querySelector('[role=status]') || {}).textContent || ''`);
            check(c4.inDialog && !!c4.id || c4.inDialog && /team-link-h/.test(c4.cls), `after a revoke the keyboard is on the list's heading, not lost: ${JSON.stringify(c4)}`);
            check(/^Revoked the link with .+ on .+\./.test(live), `a done revoke is said in a status: ${JSON.stringify(live)}`);
            // 5. a done link is said too
            await fx('#team-link-dialog .team-link-link'); await key('Enter'); await settle(); const c5 = await act();
            check(c5.inDialog && /team-link-go/.test(c5.cls), `Link's question starts on its own button (a link is not destructive): ${JSON.stringify(c5)}`);
            await key('Enter'); await new Promise(r => setTimeout(r, 700)); // sleep-ok: the call and the list
            const live2 = await dlg(`(d.querySelector('[role=status]') || {}).textContent || ''`), c6 = await act();
            check(/^Linked .+ on .+\./.test(live2) && c6.inDialog, `a done link is said and the keyboard stays in the dialog: ${JSON.stringify([live2, c6])}`);
            // the same sentence twice is announced twice: the status is emptied before it is set again (a live region says only what changes)
            await ev(`window.__liveSeen = []; const st = document.querySelector('#team-link-dialog [role=status]'); new MutationObserver(() => window.__liveSeen.push(st.textContent)).observe(st, { childList: true, characterData: true, subtree: true }); true`);
            for (let i = 0; i < 2; i++) { await fx('#team-link-dialog .team-link-link'); await key('Enter'); await settle(); await fx('#team-link-dialog .team-link-go'); await key('Enter'); await new Promise(r => setTimeout(r, 700)); } // sleep-ok: the call and the list
            const seen = await ev('window.__liveSeen'), sentences = seen.filter(t => /^Linked /.test(t));
            check(sentences.length >= 2 && sentences[0] === sentences[1] && seen.slice(seen.indexOf(sentences[0]), seen.lastIndexOf(sentences[1])).includes(''), `the same sentence said twice is emptied between, so a screen reader says it twice: ${JSON.stringify(seen)}`);
            // 6. 200% text: the circle grows, nothing runs off the dialog
            await ev(`document.documentElement.style.fontSize = '32px'; true`); await settle();
            const big = await dlg(`(() => { const r = d.getBoundingClientRect(), av = d.querySelector('.team-link-avatar'); const wide = [...d.querySelectorAll('*')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > r.right + 1).map(e => String(e.className || e.tagName).slice(0, 30)); return { avatar: av ? Math.round(av.getBoundingClientRect().width) : 0, wide, hscroll: d.scrollWidth > d.clientWidth + 1 }; })()`);
            await shot(`team-link-keyboard-200-${label}`);
            check(big.avatar >= 24 && big.wide.length === 0 && !big.hscroll, `at 200% the avatar circle grows with the text (24 px or more) and nothing runs off the dialog: ${JSON.stringify(big)}`);
            await ev(`document.documentElement.style.fontSize = ''; true`); await settle();
            if (mobile) { const t = await dlg(`(() => { const r = d.getBoundingClientRect(); return { fits: r.left >= 0 && r.right <= innerWidth, revoke: Math.round(d.querySelector('.team-link-revoke').getBoundingClientRect().height) }; })()`); check(t.fits && t.revoke >= 44, `on a phone the dialog fits and Revoke is a 44 px target: ${JSON.stringify(t)}`); }
            // 7. Escape closes and returns the keyboard to the team's menu button
            await key('Escape'); await settle(); const e2 = await act();
            check(!(await dlg('d.open')), 'Escape closes the dialog'); check(/More actions for alpha/.test(e2.label), `Escape returns the keyboard to the team's menu button (it fell to the page): ${JSON.stringify(e2)}`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Link team dialog by keyboard and screen reader:\n  ' + problems.join('\n  '));
    console.log('PASS the Link team dialog by keyboard and screen reader');
})().catch(e => { console.error(e); process.exit(1); });
