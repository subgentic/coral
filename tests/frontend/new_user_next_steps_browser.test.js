// New-user fixes from Mobile Beta Tester's v2.0.8 phone walkthrough (#11336, #11334): (1) an empty team Board has one next step, a button that asks its lead to plan the first task and starts the message in the box;
// (2) the folder of a team made after the first agent is offered like the first agent's (the person's recent folders are only ones Coral made), a fresh one beside it; (3) the amber no-password banner is one
// short line on a phone with Set a password and Dismiss; (4) plain words in the task and goal forms and the team's members line. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const { install: installNT, openNewTeam } = require('./helpers/new_team');
const { install: installNA, openNewAgent } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;

const TEAM = `qa-next-steps-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const problems = [];
    const check = (ok, what) => { if (!ok) problems.push(what); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        // (1) the empty Board
        for (const [label, w, h, mobile] of [['1280 px', 1280, 800, false], ['390 px', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM); if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM).catch(() => {});
            await ev(`(() => { const R = window.fetch; window.fetch = (u, o) => String(u).includes('/messages/all') ? Promise.resolve(new Response(JSON.stringify({ messages: [], total: 0, before_count: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })) : R(u, o); return true; })()`); // a board nothing was posted on: the seeded one holds the system lines of its goals and tasks
            await goTab(ev, settle, 'Board'); await waitFor(`!!document.querySelector('#mb-messages .mb-empty-board')`, `${label}: the empty board`, 10000).catch(() => {});
            if (process.env.DBG) console.log('DBG', await ev(`(() => { const m = document.getElementById('mb-messages'); return JSON.stringify({ tab: (document.querySelector('[role=tab][aria-selected=true]') || {}).textContent, board: (document.getElementById('mb-board') || {}).style?.display, boardIn: document.getElementById('mb-board')?.parentElement?.id, html: m ? m.outerHTML.slice(0, 200) : null, panelHtml: (document.querySelector('#team-page-view [role=tabpanel]:not([hidden])') || {}).innerHTML?.slice(0, 500), rows: document.querySelectorAll('#team-panel-messages *').length, panel: (document.getElementById('team-panel-messages') || {}).innerText?.slice(0, 300) }); })()`));
            const b = await ev(`(() => { const e = document.querySelector('#mb-messages .mb-empty-board'); const btn = e && e.querySelector('.mb-empty-ask'); return { empty: !!e, text: e ? e.querySelector('p').textContent : null, btn: btn ? btn.textContent : null, btnShown: !!btn && btn.getClientRects().length > 0 }; })()`);
            check(b.empty && /^No messages on the board yet/.test(b.text || '') && /they call you the Operator\.$/.test(b.text || ''), `${label}: an empty board says so: ${JSON.stringify(b)}`);
            check(b.btnShown && /^(Ask .+ to plan the first task|Write the first message)$/.test(b.btn || ''), `${label}: and offers one action: ${JSON.stringify(b.btn)}`);
            if (b.btnShown) {
                const target = b.btn.replace(/^Ask (.+) to plan the first task$/, '$1');
                await ev(`document.querySelector('#mb-messages .mb-empty-ask').click(); true`); await settle(200);
                const c = await ev(`(() => { const x = document.getElementById('mb-post-input'); return { value: x.value, focused: document.activeElement === x, caret: x.selectionStart === x.value.length }; })()`);
                check(c.focused && c.caret && (/^Write/.test(b.btn) ? c.value === '' : c.value.startsWith('@' + target + ' ') && /plan the first task/.test(c.value)), `${label}: the button starts the message in the box and gives it the focus: ${JSON.stringify(c)}`);
            }
        }
        // (2) the team's folder after the first agent
        const f = await ev(`import(${S} + 'folder_suggestion.js').then(async m => { const br = await import(${S} + 'browser.js'); const mk = () => { const i = document.createElement('input'); i.dataset.coralRoot = '/home/someone'; return i; };
            const root = '/home/someone'; const only = m.onlyCoralMadeRecents(root, ['/home/someone/Coral/first-agent']), own = m.onlyCoralMadeRecents(root, ['/home/someone/Coral/first-agent', '/home/someone/work']), none = m.onlyCoralMadeRecents(root, []);
            br.recordRecentDir('/home/someone/Coral/first-agent'); const a = mk(); m.offerSuggestion(a, null, 'first-team', { afterCoralMade: true });
            const plain = mk(); m.offerSuggestion(plain, null, 'first-agent');
            br.recordRecentDir('/home/someone/Coral/first-team'); const c = mk(); m.offerSuggestion(c, null, 'first-team', { afterCoralMade: true });
            br.recordRecentDir('/home/someone/work'); const d = mk(); m.offerSuggestion(d, null, 'first-team', { afterCoralMade: true });
            return { only, own, none, team: a.value, plain: plain.value, second: c.value, withOwn: d.value }; })`);
        check(f.only === true && f.own === false && f.none === false, `only Coral-made recents are told apart from a person's own: ${JSON.stringify([f.only, f.own, f.none])}`);
        check(f.team === '/home/someone/Coral/first-team', `a team after the first agent is offered its own folder: ${f.team}`);
        check(f.plain === '', `the first-agent rule is as it was (a recent folder: nothing offered): ${JSON.stringify(f.plain)}`);
        check(f.second === '/home/someone/Coral/first-team-2', `and a fresh one when that name is taken: ${f.second}`);
        check(f.withOwn === '', `a person with a folder of their own is offered nothing: ${JSON.stringify(f.withOwn)}`);
        // (3) the banner
        for (const [w, theme, zoom] of [[390, 'light', 100], [390, 'dark', 100], [320, 'light', 100], [390, 'light', 200], [390, 'dark', 200], [320, 'light', 200]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); document.documentElement.style.fontSize = '${zoom}%'; const b = document.getElementById('local-auth-banner'); b.hidden = false; b.classList.remove('notice-error'); b.classList.add('notice-warn'); b.querySelector('[data-auth-state=off]').hidden = true; b.querySelector('[data-auth-state=nopw]').hidden = false; document.getElementById('local-auth-set-password').hidden = false; document.getElementById('local-auth-dismiss').hidden = false; true`); await settle(300);
            const g = await ev(`(() => { const b = document.getElementById('local-auth-banner'), r = b.getBoundingClientRect(), vis = e => e.getClientRects().length > 0 && e.getBoundingClientRect().width > 4, d = document.getElementById('local-auth-dismiss'), s = document.getElementById('local-auth-set-password'); return { h: Math.round(r.height), vh: innerHeight, shown: vis(d) && vis(s), text: b.textContent.replace(/\\s+/g, ' ').trim(), seen: [...b.querySelectorAll('[data-auth-state=nopw] > b, .local-auth-more')].map(e => Math.round(e.getBoundingClientRect().width)), col: Math.round(b.querySelector('.local-auth-banner-text').getBoundingClientRect().width) }; })()`);
            if (process.env.DBG) console.log('DBG3', w, theme, zoom, g.h, g.vh, g.col);
            if (process.env.DBG) console.log('DBG2', await ev(`(() => { const b = document.getElementById('local-auth-banner'); const m = b.querySelector('.local-auth-more'); const cs = getComputedStyle(b); const cs2 = getComputedStyle(b); return JSON.stringify({ bw: Math.round(b.getBoundingClientRect().width), pad: cs2.padding, gap: cs2.gap, more: !!m, moreW: m && Math.round(m.getBoundingClientRect().width), pos: m && getComputedStyle(m).position, wrap: cs.flexWrap, kids: [...b.children].map(e => { const c = getComputedStyle(e); return e.tagName + '[m' + c.margin + ' p' + c.padding + ']'; }).concat([...b.children].map(e => e.tagName + ':' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height))) }); })()`));
            check(g.shown && /No password is set/.test(g.text) && /a browser needs a password to sign in/.test(g.text), `${w} ${theme}: the banner says it, in words a screen reader has whole: ${JSON.stringify(g.text)}`);
            if (zoom === 100) check(g.h <= (w >= 390 ? 72 : 130), `${w} ${theme}: the banner is short (two lines at 320, where the words and both buttons do not fit), ${g.h} px of ${g.vh} (it was a quarter of the screen)`);
            else { check(g.h <= g.vh * 0.4, `${w} ${theme} at ${zoom}% text: the banner is at most 40% of the screen, ${g.h} px of ${g.vh}`); check(g.col >= 8 * 16 * 2 - 4, `${w} ${theme} at ${zoom}% text: the words keep a column of 8em, not a sliver: ${g.col} px`); }
        }
        // (5) the goal switch of the team's first task says its state in words (#11336: a newcomer "ticks" it, which turns it off)
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`import(${S} + 'team_launch_settings.js').then(m => { window.__tls = m; const h = document.createElement('div'); h.id = 'team-start-host'; document.body.append(h); m.mountTeamLaunchSettings(); return true; })`);
        await waitFor(`!!document.getElementById('team-goal-state')`, 'the goal state line', 8000);
        const gs = await ev(`(() => { const m = window.__tls;
            const st = () => { const e = document.getElementById('team-goal-state'); return e ? e.textContent : null; }, sw = document.getElementById('team-save-goal'), task = document.getElementById('team-goal');
            const out = { empty: st(), described: sw && sw.getAttribute('aria-describedby') };
            task.value = 'Build a thing'; task.dispatchEvent(new Event('input', { bubbles: true })); out.withTask = st();
            sw.click(); out.off = st(); out.read = m.readTeamLaunchSettings().save_goal;
            sw.click(); out.backOn = st(); out.readOn = m.readTeamLaunchSettings().save_goal; document.getElementById('team-start-host').remove(); return out; })()`);
        check(/^On: a first task/.test(gs.empty || ''), `the switch starts on and says so before a task is written: ${JSON.stringify(gs.empty)}`);
        check(gs.described === 'team-goal-state', `the switch is described by that line: ${gs.described}`);
        check(/^On: the first task will also be the team's goal/.test(gs.withTask || ''), `with a task written: ${JSON.stringify(gs.withTask)}`);
        check(/^Off: the first task will not be saved as a goal/.test(gs.off || '') && gs.read === false, `clicked once it says Off and sends no goal: ${JSON.stringify([gs.off, gs.read])}`);
        check(/^On: the first task will also/.test(gs.backOn || '') && gs.readOn === true, `clicked again it says On: ${JSON.stringify([gs.backOn, gs.readOn])}`);
        // (6) New Agent says Claude is not signed in, with how (#11336): a notice under the provider, Launch stays on, nothing for another provider
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.__signed = true; const R6 = window.fetch; window.fetch = (u, o) => String(u).includes('/api/system/status') ? Promise.resolve(new Response(JSON.stringify({ claude_signed_in: window.__signed }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : String(u).includes('/api/system/cli-check') && String(u).includes('type=pi') ? Promise.resolve(new Response(JSON.stringify(window.__pi), { status: 200, headers: { 'Content-Type': 'application/json' } })) : R6(u, o); window.__pi = { found: true, signed_in: false }; true`);
        await ev(`import(${S} + 'launch_signin_notice.js').then(async m => { const sl = await import(${S} + 'signin_line.js'); window.__sl = sl; const host = document.createElement('div'); host.id = 'sn-host'; host.innerHTML = '<form id="sn-form"><select class="acf-agent-type"><option value="claude">Claude</option><option value="codex">Codex</option><option value="pi">Pi</option></select></form><div id="sn-slot" class="launch-cli-slot"></div>'; document.body.append(host); sl.setClaudeSignedIn(true); m.mountLaunchSigninNotice({ slot: document.getElementById('sn-slot'), form: document.getElementById('sn-form'), server: 'local' }); return true; })`);
        const sn = () => ev(`(() => { const n = document.querySelector('#sn-host .launch-signin-notice'); const b = n && n.querySelector('button'), st = n && n.querySelector('.launch-signin-steps'); return n ? { shown: !n.hidden, text: n.textContent.replace(/\\s+/g, ' ').trim(), expanded: b.getAttribute('aria-expanded'), steps: !st.hidden } : null; })()`);
        let n0 = await sn();
        check(n0 && !n0.shown, `signed in: no notice: ${JSON.stringify(n0)}`);
        await ev(`window.__signed = false; window.__sl.setClaudeSignedIn(false); true`); n0 = await sn();
        check(n0.shown && /Claude isn't signed in on this computer\./.test(n0.text) && /How to sign in/.test(n0.text), `Claude not signed in: a notice with How to sign in: ${JSON.stringify(n0)}`);
        await ev(`document.querySelector('#sn-host .launch-signin-how').click(); true`); n0 = await sn();
        check(n0.expanded === 'true' && n0.steps && /run claude/.test(n0.text) && /Open terminal and Check again/.test(n0.text), `How to sign in opens the steps: ${JSON.stringify(n0)}`);
        await ev(`(() => { const x = document.querySelector('#sn-host select'); x.value = 'codex'; x.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); n0 = await sn();
        check(!n0.shown, `another provider: no notice about Claude: ${JSON.stringify(n0)}`);
        await ev(`(() => { const x = document.querySelector('#sn-host select'); x.value = 'claude'; x.dispatchEvent(new Event('change', { bubbles: true })); window.__signed = true; window.__sl.setClaudeSignedIn(true); return true; })()`); n0 = await sn();
        check(!n0.shown, `signed in again: the notice goes by itself: ${JSON.stringify(n0)}`);
        // Pi with no provider signed in (#11336, Pi Tester): the same notice, in Pi's words, from Pi's own sign-in probe; nothing when Pi is signed in or the probe cannot say
        const pick = name => ev(`(() => { const x = document.querySelector('#sn-host select'); x.value = ${JSON.stringify(name)}; x.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        const remount = async pi => { await ev(`window.__pi = ${JSON.stringify(pi)}; import(${S} + 'launch_signin_notice.js').then(m => { document.querySelector('#sn-host .launch-signin-notice')?.remove(); document.querySelector('#sn-host select').value = 'claude'; m.mountLaunchSigninNotice({ slot: document.getElementById('sn-slot'), form: document.getElementById('sn-form'), server: 'local' }); return true; })`); };
        await ev(`window.__signed = true; window.__sl.setClaudeSignedIn(true); true`);
        await remount({ found: true, signed_in: false }); await pick('pi');
        await waitFor(`(() => { const n = document.querySelector('#sn-host .launch-signin-notice'); return !!n && !n.hidden; })()`, 'the Pi notice', 6000).catch(() => {});
        n0 = await sn();
        check(n0 && n0.shown && /Pi isn't signed in to its default provider on this computer\./.test(n0.text), `Pi's default provider not signed in: a notice in Pi's words: ${JSON.stringify(n0)}`);
        await ev(`document.querySelector('#sn-host .launch-signin-how').click(); true`); n0 = await sn();
        check(n0.steps && /run pi, type \/login, choose how to sign in, then pick a provider/.test(n0.text) && /Pi shows No API key found for the provider and waits for you to sign in/.test(n0.text), `with Pi's own steps: ${JSON.stringify(n0)}`);
        await pick('codex'); n0 = await sn(); check(!n0.shown, `another provider: nothing: ${JSON.stringify(n0)}`);
        for (const [pi, what] of [[{ found: true, signed_in: true }, 'signed in'], [{ found: true, probe: 'ok' }, 'the CLI could not say'], [{ found: false }, 'Pi is not installed']]) {
            await remount(pi); await pick('pi'); await ev(`new Promise(r => setTimeout(r, 300))`); // sleep-ok: nothing appears; the probe answer is a resolved stub, a little time lets it land
            n0 = await sn(); check(n0 && !n0.shown, `Pi ${what}: no notice: ${JSON.stringify(n0)}`);
        }
        await ev(`document.getElementById('sn-host').remove(); true`);
        // (7) recent folders that are gone (#11336 item 9): the browser keeps them when the data folder is wiped; the dialogs drop them, and a person left with none is offered the first folder
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        const GONE = '/no-such-folder-for-coral-test', GONE2 = '/another/missing/one';
        const rc = await ev(`import(${S} + 'browser.js').then(async m => { m.recordRecentDir(${JSON.stringify(GONE2)}); m.recordRecentDir('/tmp'); m.recordRecentDir(${JSON.stringify(GONE)}); const before = m.getRecentDirs(); const changed = await m.pruneMissingRecents(); const again = await m.pruneMissingRecents(); const other = await m.pruneMissingRecents('box-b'); return { before, changed, after: m.getRecentDirs(), again, other }; })`);
        check(rc.changed === true && JSON.stringify(rc.after) === JSON.stringify(['/tmp']), `missing recents are dropped and an existing one kept: ${JSON.stringify(rc)}`);
        check(rc.again === false && rc.other === false, `nothing more to drop is false, and another server is not asked: ${JSON.stringify([rc.again, rc.other])}`);
        await ev(`import(${S} + 'browser.js').then(m => { m.recordRecentDir(${JSON.stringify(GONE)}); m.recordRecentDir('/tmp'); return true; })`);
        await installNT(ev); await openNewTeam(ev, waitFor);
        await waitFor(`!document.querySelector('#launch-team-dir-recents [data-dir=${JSON.stringify(GONE)}]')`, 'the missing folder dropped from the recent buttons', 8000).catch(() => {});
        const tb = await ev(`[...document.querySelectorAll('#launch-team-dir-recents button')].map(b => b.dataset.dir)`);
        check(JSON.stringify(tb) === JSON.stringify(['/tmp']), `New team shows only the recent folder that exists: ${JSON.stringify(tb)}`);
        const fresh = async recents => { // a returning person: a new page whose browser still holds these recent folders
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`import(${S} + 'browser.js').then(m => { for (const k of Object.keys(localStorage)) if (k.includes('coral-recent-dirs')) localStorage.removeItem(k); for (const d of ${JSON.stringify(recents)}) m.recordRecentDir(d); return true; })`);
        };
        await fresh([GONE]); await installNT(ev); await openNewTeam(ev, waitFor);
        await waitFor(`/\\/Coral\\/first-team/.test(document.getElementById('launch-team-dir').value)`, 'the first folder offered once the stale one is dropped', 8000).catch(() => {});
        const tf = await ev(`({ value: document.getElementById('launch-team-dir').value, buttons: document.querySelectorAll('#launch-team-dir-recents button').length })`);
        check(/\/Coral\/first-team$/.test(tf.value) && tf.buttons === 0, `a person left with only a missing folder is offered the first team's folder, no buttons: ${JSON.stringify(tf)}`);
        // the same for New agent's folder step
        await fresh(['/tmp', GONE]); await installNA(ev); await openNewAgent(ev, waitFor);
        await waitFor(`!document.querySelector('#launch-dir-recents [data-dir=${JSON.stringify(GONE)}]')`, 'the missing folder dropped from New agent', 8000).catch(() => {});
        const ab = await ev(`[...document.querySelectorAll('#launch-dir-recents button')].map(b => b.dataset.dir)`);
        check(JSON.stringify(ab) === JSON.stringify(['/tmp']), `New agent shows only the recent folder that exists: ${JSON.stringify(ab)}`);
        // (8) the no-password banner is not left behind the password dialog (#11336, Mobile Beta Tester): hidden while the dialog is open, back when it closes
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`(() => { const b = document.getElementById('local-auth-banner'); b.hidden = false; b.classList.remove('notice-error'); b.classList.add('notice-warn'); b.querySelector('[data-auth-state=off]').hidden = true; b.querySelector('[data-auth-state=nopw]').hidden = false; return true; })()`);
            const shown = () => ev(`(() => { const b = document.getElementById('local-auth-banner'); return b.getClientRects().length > 0 && getComputedStyle(b).display !== 'none'; })()`);
            check(await shown() === true, `${w} px: the banner shows with no dialog`);
            await ev(`import(${S} + 'password_ui.js').then(m => { m.showSetPasswordModal({ local: true }); return true; })`);
            await waitFor(`!!document.getElementById('set-password-modal')`, 'the password dialog', 6000);
            check(await shown() === false, `${w} px: the banner is hidden while the password dialog is open`);
            await ev(`document.getElementById('set-password-modal').remove(); true`);
            check(await shown() === true, `${w} px: and shows again when it is closed`);
        }
        // (9) "Operator" is explained where a newcomer meets it (#11336 item 7, option 2): the empty Board says agents call you the Operator, and an @Operator mention says "That is you" on hover, on a tap and in the words a screen reader reads
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        const mt = await ev(`import(${S} + 'board_message_text.js').then(m => { const host = document.createElement('div'); host.id = 'mn-host'; host.innerHTML = m.highlightMentionsHtml('<p>Please look, @Operator, and @Orchestrator too.</p>'); document.body.append(host); const self = host.querySelector('.mb-mention-self'), other = [...host.querySelectorAll('.mb-mention')].find(x => !x.classList.contains('mb-mention-self')); return { selfText: self && self.textContent, title: self && self.title, tab: self && self.tabIndex, role: self && self.getAttribute('role'), label: self && self.getAttribute('aria-label'), other: other && { title: other.title, tab: other.tabIndex, text: other.textContent } }; })`);
        check(mt.selfText === '@Operator' && mt.title === 'That is you' && mt.tab === 0 && mt.role === 'button' && mt.label === '@Operator, that is you', `the @Operator mention is told it is you, by title, by an accessible name (the text is unchanged) and by Tab: ${JSON.stringify(mt)}`);
        check(mt.other && mt.other.title === '' && mt.other.tab === -1 && mt.other.text === '@Orchestrator', `another mention is left as it was: ${JSON.stringify(mt.other)}`);
        const tip = () => ev(`(() => { const s = document.querySelector('#mn-host .mb-mention-self'); return { open: s.hasAttribute('data-tip-open'), expanded: s.getAttribute('aria-expanded'), shown: getComputedStyle(s, '::after').content }; })()`);
        let t0 = await tip(); check(!t0.open && !/That is you/.test(t0.shown), `closed to start: ${JSON.stringify(t0)}`);
        await ev(`document.querySelector('#mn-host .mb-mention-self').click(); true`); t0 = await tip();
        check(t0.open && t0.expanded === 'true' && /That is you/.test(t0.shown), `a tap opens the bubble (aria-expanded true): ${JSON.stringify(t0)}`);
        await ev(`document.body.click(); true`); t0 = await tip(); check(!t0.open, `a tap elsewhere closes it: ${JSON.stringify(t0)}`);
        await ev(`const sm = document.querySelector('#mn-host .mb-mention-self'); sm.focus(); sm.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); true`); t0 = await tip();
        check(t0.open, `Enter opens it from the keyboard: ${JSON.stringify(t0)}`);
        await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`); t0 = await tip(); check(!t0.open, `Escape closes it: ${JSON.stringify(t0)}`);
        await ev(`document.getElementById('mn-host').remove(); true`);
        // (4) plain words
        const root = require('node:path').join(__dirname, '..', '..', 'coral-go', 'pkg', 'frontend', 'static'), read = f => require('node:fs').readFileSync(require('node:path').join(root, f), 'utf8'); // the sources that write the words
        const t = read('task_create.js'), g = read('goals_view.js'), d = read('team_dialogs.js');
        const words = { draft: /Hold back as a draft/.test(t) && !/Create as draft/.test(t), order: /Order of work \(advanced\)/.test(t) && !/Workflow and prerequisites/.test(t), start: /Start once the tasks it waits for/.test(t) && !/Proceed when prerequisites/.test(t), driver: /Driver, the agent who looks after it \(optional\)/.test(g), orch: /The Orchestrator plans the work and hands tasks to the others/.test(d) };
        check(Object.values(words).every(Boolean), `plain words in the task form, the goal form and the members line: ${JSON.stringify(words)}`);
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'new-user next steps:\n  ' + problems.join('\n  '));
    console.log('PASS the empty Board has a next step, a team is offered its folder, the banner is one line, the jargon has plain words');
})().catch(e => { console.error(e); process.exit(1); });
