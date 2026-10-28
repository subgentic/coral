// Draft harness for the internal Agent List Compact spec (items 1-19). Written against the
// spec's selectors before #150 lands; moved into tests/frontend and registered
// in run.sh once the implementation is in the tree. Uses the same isolation
// pattern as agent_bar_tweaks.test.js (pre-navigation fetch + WebSocket stub).
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
const { TOUCH_AREA } = require('./helpers/touch_area');
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);
const results = []; const check = (l, c, d) => { const v = c ? 'PASS' : 'FAIL'; results.push(v); console.log(`[${v}] ${l}${d !== undefined ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const U = () => require('crypto').randomUUID();
const A = U(), B = U(), C = U(), D = U(), E = U(), F = U();
const SESSIONS = [
  { name: 'coral-go', display_name: 'Lead Dev', agent_type: 'claude', session_id: A, summary: 'Refactoring the store layer', context_pct: 87, context_window: 1000000, working: true, working_directory: '/repo/coral-go', branch: 'feat/x', board_project: 'ui-team', board_job_title: 'Lead', token_input: 1200, token_output: 3400 },
  { name: 'coral-go', display_name: '', auto_name: 'Auto Bot', agent_type: 'claude', session_id: B, summary: '', first_prompt: 'Please fix the flaky websocket reconnect test', context_pct: 42, waiting_for_input: true, working_directory: '/repo/coral-go', board_project: 'ui-team' },
  { name: 'coral-go', display_name: '', agent_type: 'claude', session_id: C, summary: '', first_prompt: '', context_pct: null, context_window: null, not_started: true, working_directory: '/repo/coral-go', board_project: 'ui-team' },
  { name: 'coral-go', display_name: 'Sleeper', agent_type: 'claude', session_id: D, summary: 'Waiting for the next batch', sleeping: true, status: 'Sleeping', working_directory: '/repo/coral-go', board_project: 'ui-team' },
  { name: 'coral-go', display_name: '', agent_type: 'terminal', session_id: E, summary: '', first_prompt: '', context_pct: 0, working_directory: '/repo/coral-go' },
  { name: 'other-proj', display_name: 'Zed', agent_type: 'claude', session_id: F, summary: 'Writing docs', context_pct: 12, working_directory: '/repo/other-proj' },
];
const ORDER = SESSIONS.map(s => s.session_id).join(',');
const STUB = `
  window.__fixture = ${JSON.stringify(SESSIONS)}; window.__sendCalls = [];
  (function(){ const Real = window.WebSocket; function Dead(u){ this.url=String(u); this.readyState=0; } Dead.prototype.send=function(){}; Dead.prototype.close=function(){}; Dead.prototype.addEventListener=function(){}; Dead.prototype.removeEventListener=function(){};
    function W(u,p){ if (/\\/ws\\/coral(\\?|$)/.test(String(u))) return new Dead(u); return p===undefined? new Real(u): new Real(u,p); } W.prototype=Real.prototype; W.CONNECTING=0; W.OPEN=1; W.CLOSING=2; W.CLOSED=3; window.WebSocket=W; })();
  window.__origFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => { const u=String(url); const path=u.replace(/^https?:\\/\\/[^/]+/,'').split('?')[0]; const m=((opts&&opts.method)||'GET').toUpperCase();
    const json=(b)=>Promise.resolve(new Response(JSON.stringify(b),{status:200,headers:{'Content-Type':'application/json'}}));
    if (path==='/api/sessions/live' && m==='GET') return json(window.__fixture);
    if (m!=='GET') { window.__sendCalls.push({path, body: opts && opts.body}); return json({ok:true}); }
    return window.__origFetch(url, opts); };`;
async function run() {
  const client = await CDP({ port: CDP_PORT }); const { Page, Runtime, Emulation } = client;
  await Promise.all([Page.enable(), Runtime.enable()]);
  await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
  const exceptions = []; Runtime.exceptionThrown(e => exceptions.push(((e.exceptionDetails || {}).exception || {}).description || 'exception'));
  const ev = async (x) => { const r = await Runtime.evaluate({ expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
  // Condition waits (#3118). Soft: on timeout they return and the next check() reports what is wrong.
  const { waitFor, waitStable, nextFrame } = require('./helpers/wait').bind((x) => ev(x));
  const until = (expression, what, timeout = 5000) => waitFor(expression, what, { soft: true, timeout });
  const boot = async (w, h, mobile) => { await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await until(`typeof window._coralSetLiveSessions === 'function'`, 'the app hooks', 10000); // Agent summaries are off by default (a server-side setting) and sleeping agents sit behind an
    // "N sleeping" row; this suite is about the two-line rows, so turn summaries on and expand the sleepers.
    await ev(`(async () => { await window.__origFetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ show_session_summary: true }) }); await (await import((window.__coralStatic||'/static/')+'modals.js')).loadSettings(); return true; })()`);
    await ev(`localStorage.setItem('coral-group-by-team','false'); localStorage.setItem('coral-sleeping-expanded:coral-go','true'); localStorage.setItem('coral-sleeping-expanded:ui-team','true'); window.switchNavTab('agents'); window._coralSetLiveSessions(JSON.parse(JSON.stringify(window.__fixture))); true`);
    // A late startup load can re-render the list: go on once the rendered rows hold still.
    await waitStable(`[...document.querySelectorAll('#live-sessions-list .session-group-item, #mobile-session-list .session-group-item')].map(li => li.dataset.sessionId + ':' + li.getAttribute('aria-label')).join()`, 'the fixture rows', 300).catch(() => {}); };
  const rows = () => ev(`Array.from(document.querySelectorAll('#live-sessions-list .session-group-item')).map(li => { const q = s => li.querySelector(s); const cs = el => el ? getComputedStyle(el) : null; const r = li.getBoundingClientRect();
    return { sid: li.dataset.sessionId, h: r.height, tabindex: li.getAttribute('tabindex'), role: li.getAttribute('role'), aria: li.getAttribute('aria-label'), current: li.getAttribute('aria-current'),
      avatar: !!q('.agent-avatar'), ctxBar: !!q('.session-context-bar'), dirChip: !!q('.agent-dir-chip'), inlineStatus: !!q('.session-inline-status'), activity: !!q('.session-activity-text'),
      dot: !!q('.session-dot'), identity: (q('.session-label')||{}).textContent, identityTitle: q('.session-label') ? q('.session-label').getAttribute('title') : null,
      pills: Array.from(li.querySelectorAll('.session-attention-pill, .session-ctx-pill')).map(p => p.textContent.trim()), goal: q('.session-goal') ? q('.session-goal').textContent.replace(/\\s+/g,' ').trim() : null, goalTitle: q('.session-goal') ? q('.session-goal').getAttribute('title') : null,
      kebabFirst: (() => { window.closeSidebarKebabs(); const kb = q('.sidebar-kebab-btn'); if (kb) window.toggleSidebarKebab(kb); /* a row's menu is drawn when it opens (#4611) */ const m = q('.sidebar-kebab-menu'); const f = m ? Array.from(m.children).find(c => c.matches('.overflow-menu-item')) : null; const t = f ? f.textContent.trim() : null; window.closeSidebarKebabs(); return t; })(),
      padding: cs(li).padding, hasUuidText: li.textContent.includes(li.dataset.sessionId) }; })`);
  const guard = await require('./helpers/settings_guard').guardSettings(); // the settings this suite changes are put back in its finally (#4849)
  try {
    await boot(1440, 900, false);
    let R = await rows(); const by = Object.fromEntries(R.map(r => [r.sid, r]));
    check('1 every row is one line, 36px ±1, with or without a goal (the goal is in the hover tip, #9686)', R.every(r => Math.abs(r.h - 36) <= 1) && R.every(r => r.goal === null), JSON.stringify({ A: by[A].h, E: by[E].h, goals: R.map(r => r.goal) }));
    check('1 no avatar / context bar / dir chip / inline status / activity text in rows', R.every(r => !r.avatar && !r.dirChip && !r.inlineStatus && !r.activity) && R.filter(r => r.ctxBar).length === 0, JSON.stringify(R.map(r => [r.avatar, r.ctxBar, r.dirChip, r.inlineStatus, r.activity])));
    check('2 the line = dot + D1 identity (+one chip) + kebab; the identity has no native title (the hover tip names it, #9822) and no row shows a uuid', R.every(r => r.dot) && by[B].identity.trim() === 'Auto Bot' && by[A].identityTitle === null && R.every(r => !r.hasUuidText), JSON.stringify({ b: by[B].identity, at: by[A].identityTitle }));
    check('2 attention rows show exactly one text pill (Needs input / Check terminal)', by[B].pills.filter(p => /Needs input|Check terminal|Stuck/.test(p)).length === 1 && by[C].pills.filter(p => /Check terminal/.test(p)).length === 1 && by[A].pills.filter(p => /Needs input|Check terminal|Stuck/.test(p)).length === 0, JSON.stringify({ B: by[B].pills, C: by[C].pills, A: by[A].pills }));
    check('12/D-C no row draws a context pill, at 87% or at 42% or unknown: context fill is not an action (UI/UX, #9686); a high one still rings the dot (159 below)', R.every(r => !r.pills.some(p => /^ctx/.test(p))), JSON.stringify({ A: by[A].pills, B: by[B].pills, C: by[C].pills }));
    check('19/D-E sleeping row is one line too (36px, no goal line); its summary stays in the hover tip', by[D].goal === null && Math.abs(by[D].h - 36) <= 1, JSON.stringify({ goal: by[D].goal, h: by[D].h }));
    check('D-F rows are focusable list items, not buttons, with aria-label identity + state', R.every(r => (r.tabindex === '0' || r.tabindex === '-1') && r.role !== 'button') && R.filter(r => r.tabindex === '0').length === 1 && /^Auto Bot, Needs input$/.test(by[B].aria || '') && /^Sleeper, Sleeping$/.test(by[D].aria || ''), JSON.stringify({ B: by[B].aria, D: by[D].aria, roles: R.map(r => r.role) }));
    check('14 Open Agent Tab is still the first kebab item', by[A].kebabFirst === 'Open Agent Tab', by[A].kebabFirst);
    check('11 order preserved (no-sort)', R.map(r => r.sid).join(',') === ORDER);
    // headers
    const hdr = await ev(`(() => { const t = document.querySelector('#live-sessions-list .session-board-card .session-board-header, #live-sessions-list .session-board-card > [class*="header"]'); const f = document.querySelector('#live-sessions-list .session-group-header'); const rect = el => el ? el.getBoundingClientRect().height : null; return { teamH: rect(t), teamText: t ? t.textContent.replace(/\\s+/g,' ').trim() : null, teamCount: !!(t && t.querySelector('.session-group-count')), teamDir: !!document.querySelector('#live-sessions-list .board-card-dir, #live-sessions-list .board-card-branch-line, #live-sessions-list .team-token-usage'), folderH: rect(f), folderCount: !!(f && f.querySelector('.session-group-count')), folderDir: !!(f && (f.querySelector('.group-dir-line') || /\\//.test(f.textContent))) }; })()`);
    check('3 team header = name + count, 32px (28 plus its 24px collapse button, #5989), no dir/branch/token text', hdr.teamCount && !hdr.teamDir && hdr.teamH !== null && Math.abs(hdr.teamH - 32) <= 2, JSON.stringify(hdr));
    check('3 folder header = name + count, 24px', hdr.folderCount && hdr.folderH !== null && Math.abs(hdr.folderH - 24) <= 2 && !hdr.folderDir, JSON.stringify(hdr));
    // tooltip
    const tip = await ev(`(() => { const t = typeof window.buildSessionTooltip === 'function' ? window.buildSessionTooltip(window.__fixture[2]) : (document.querySelector('#live-sessions-list [data-session-id="${C}"]').getAttribute('title') || ''); return String(t); })()`);
    const tipText = tip.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    check('12 tooltip has no Context row while the context is unknown (#9999: a word that says nothing is not a fact)', !/Context/i.test(tipText), tipText.slice(0, 120));
    const tipA = await ev(`(() => { const t = typeof window.buildSessionTooltip === 'function' ? window.buildSessionTooltip(window.__fixture[0]) : ''; return String(t); })()`);
    const tipAText = tipA.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const tipBText = String(await ev(`window.buildSessionTooltip(window.__fixture[1])`)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    check('12 the hover tip is where the context is read: 87% of 1.0M for A, 42% for B, no row for C (the number is right)', /Context:?\s*87%/.test(tipAText) && /Context:?\s*42%/.test(tipBText) && !/Context/i.test(tipText), JSON.stringify({ A: (tipAText.match(/Context[^A-Z]*/) || [''])[0], B: (tipBText.match(/Context[^A-Z]*/) || [''])[0] }));
    check('2 the goal in the tip carries no uuid (moved from the row\'s goal title, #9686)', !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(tipAText + tipBText + tipText) && /Goal:?\s*Refactoring the store layer/.test(tipAText), tipAText.slice(0, 200));
    check('4 tooltip has Context/Tokens/Branch/Last action rows for a known session', /Context:?\s*87%/.test(tipAText) && /Tokens/.test(tipAText) && /Branch/.test(tipAText) && /Last action/.test(tipAText), tipAText.slice(0, 160));
    // tooltip layout (operator screenshot): the value column must never touch the label column
    const tipGap = await ev(`(() => { const html = window.buildSessionTooltip(window.__fixture[0]); const host = document.createElement('div'); host.className = 'session-tooltip'; host.style.cssText = 'position:fixed;left:40px;top:40px;display:block;visibility:hidden'; host.innerHTML = html; document.body.appendChild(host);
      const rows = Array.from(host.querySelectorAll('.facts-row')).map(tr => { const l = tr.querySelector('dt'), v = tr.querySelector('dd'); if (!l || !v) return null; const lr = document.createRange(); lr.selectNodeContents(l); const vr = document.createRange(); vr.selectNodeContents(v); const lrect = lr.getBoundingClientRect(), vrect = vr.getBoundingClientRect(); return { label: l.textContent.trim(), gap: Math.round((vrect.left - lrect.right) * 10) / 10, wrap: getComputedStyle(l).whiteSpace }; }).filter(Boolean);
      const out = { rows, width: host.getBoundingClientRect().width }; host.remove(); return out; })()`);
    check('tooltip: every label/value pair keeps a >= 12px gap and labels do not wrap', tipGap.rows.length >= 4 && tipGap.rows.every(r => r.gap >= 12 && r.wrap === 'nowrap') && tipGap.width <= 420, JSON.stringify(tipGap));
    // keyboard: Enter selects, Space no scroll, actions excluded
    await ev(`document.querySelector('#live-sessions-list [data-session-id="${B}"]').focus(); true`);
    await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until(`document.querySelector('#live-sessions-list [data-session-id="${B}"]')?.getAttribute('aria-current') === 'true' && /Auto Bot/.test(document.getElementById('session-name').textContent)`, 'row B selected');
    check('7 Enter on a focused row selects it (aria-current + header identity)', await ev(`document.querySelector('#live-sessions-list [data-session-id="${B}"]').getAttribute('aria-current') === 'true' && /Auto Bot/.test(document.getElementById('session-name').textContent)`));
    // Enter on a row opens the agent's chat and puts the keyboard in its message box (the heading on a phone, #10410): focus is somewhere real after the list's re-render, never lost to the page
    check('13 focus survives the re-render triggered by selection: Enter takes it to the chat (#10410)', await ev(`document.activeElement && (document.activeElement.id === 'command-input' || (document.activeElement.dataset && document.activeElement.dataset.sessionId === '${B}'))`));
    // a real mouse click on a row that is not the open one puts the cursor in the composer, as it always did (#9794); the Enter above left focus on its row (13). It goes through window.selectLiveSession (mobile.js wraps it: the wrapper once dropped the options).
    const clickPt = await ev(`(() => { const r = document.querySelector('#live-sessions-list [data-session-id="${C}"]').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }; })()`);
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: clickPt.x, y: clickPt.y }); await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: clickPt.x, y: clickPt.y, button: 'left', clickCount: 1 }); await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: clickPt.x, y: clickPt.y, button: 'left', clickCount: 1 });
    await until(`document.querySelector('#live-sessions-list [data-session-id="${C}"]')?.getAttribute('aria-current') === 'true'`, 'row C selected by a click');
    await ev(`new Promise(r => setTimeout(r, 500))`); // sleep-ok: a late focus move (the list's redraw) would have landed by now
    check('13b a mouse click on a row puts the cursor in the composer', await ev(`document.activeElement && document.activeElement.id === 'command-input'`), await ev(`document.activeElement.id + '|' + (document.activeElement.dataset || {}).sessionId`));
    await ev(`document.querySelector('#live-sessions-list [data-session-id="${B}"]').focus(); true`); // back to row B for the checks that follow
    await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until(`document.querySelector('#live-sessions-list [data-session-id="${B}"]')?.getAttribute('aria-current') === 'true'`, 'row B selected again');
    const scrollBefore = await ev(`document.getElementById('live-sessions-list').scrollTop`);
    await client.Input.dispatchKeyEvent({ type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await waitStable(`document.getElementById('live-sessions-list').scrollTop`, 'the list scroll position', 200).catch(() => {}); // a Space scroll is smooth: give it frames to show
    check('16 Space on a row does not scroll the list', (await ev(`document.getElementById('live-sessions-list').scrollTop`)) === scrollBefore);
    await ev(`window.__sendCalls = []; const sp = document.querySelector('#live-sessions-list [data-session-id="${C}"] .sidebar-kebab-btn'); sp.focus(); true`);
    await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await nextFrame(); // the key handler runs synchronously; a row selection would show by the next frame
    check('14 Enter on a row\'s own kebab button acts on the button, not row selection (the goal sparkle is gone, #9686)', await ev(`document.querySelector('#live-sessions-list [data-session-id="${B}"]').getAttribute('aria-current') === 'true'`)); await ev(`window.closeSidebarKebabs(); true`);
    // the context moved to the agent page's header line (#9686): the number is right, and it follows a state tick
    const hdrCtx = () => ev(`(document.getElementById('apd-context') || {}).textContent || ''`);
    await until(`/ctx 42%/.test((document.getElementById('apd-context') || {}).textContent || '')`, 'the Details context');
    check('12 the selected agent\'s header line says its context (B: ctx 42%)', /ctx 42%/.test(await hdrCtx()), await hdrCtx());
    await ev(`window._coralHandleWsMessage({ type: 'coral_diff', changed: [${JSON.stringify({ ...SESSIONS[1], context_pct: 91 })}] }); true`);
    await until(`/ctx 91%/.test((document.getElementById('apd-context') || {}).textContent || '')`, 'the Details context follows');
    check('12 and it follows a state tick (B: ctx 91%), with no pill on the row', /ctx 91%/.test(await hdrCtx()) && (await ev(`!document.querySelector('#live-sessions-list [data-session-id="${B}"] .session-ctx-pill')`)), await hdrCtx());
    // rename/state tick updates aria-label in place
    await ev(`window._coralHandleWsMessage({ type: 'coral_diff', changed: [${JSON.stringify({ ...SESSIONS[1], display_name: 'Renamed Bot', waiting_for_input: false, working: true })}] }); true`); await nextFrame();
    R = await rows(); const b2 = R.find(r => r.sid === B);
    check('13 aria-label tracks rename + state tick', /^Renamed Bot, Working$/.test(b2.aria || '') && b2.pills.length === 0, JSON.stringify({ aria: b2.aria, pills: b2.pills }));
    check('11 order preserved after state flips', R.map(r => r.sid).join(',') === ORDER);
    // team details disclosure (consolidated into Team view)
    // the team kebab's Team view is the team page on its Agents tab (#7453, #7457)
    const td = await ev(`(async () => { const item = Array.from(document.querySelectorAll('#live-sessions-list .session-board-card .overflow-menu-item')).find(b => /Team (details|view)/i.test(b.textContent)); if (!item) return { item: false }; item.click(); await new Promise(r => { const end = Date.now() + 3000; (function f() { const p = document.getElementById('team-page-view'); (p && getComputedStyle(p).display !== 'none') || Date.now() > end ? r() : setTimeout(f, 20); })(); }); const pg = document.getElementById('team-page-view'); const tab = document.getElementById('team-tab-agents'); return { item: true, open: !!pg && getComputedStyle(pg).display !== 'none', agents: !!tab && tab.getAttribute('aria-selected') === 'true', labelled: !!document.querySelector('#team-page-view [role=tablist][aria-label]'), text: pg ? pg.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160) : '' }; })()`);
    check('18 Team view opens from the team kebab: the team page, on its Agents tab', td.item && td.open && td.agents && td.labelled, JSON.stringify(td));
    check('18 the team page text has no uuid/tmux/path leakage beyond the directory field', !/[0-9a-f]{8}-[0-9a-f]{4}-|claude-|terminal-/.test(td.text), td.text);
    await ev(`window.exitTeamPage({ force: true }); window.switchNavTab('agents'); true`); await nextFrame();
    // ── #155 hierarchy: indentation, alignment, typography, contrast ──────
    await ev(`localStorage.setItem('coral-group-by-team','true'); window._coralSetLiveSessions(JSON.parse(JSON.stringify(window.__fixture))); true`); await nextFrame();
    const HIER = `(() => {
      const lum = (rgb) => { const c = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
      const parse = (s) => { let m = s.match(/rgba?\\(([^)]+)\\)/); if (m) { const p = m[1].split(',').map(x => parseFloat(x)); return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; } m = s.match(/color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?\\)/); if (m) return { rgb: [m[1], m[2], m[3]].map(v => parseFloat(v) * 255), a: m[4] === undefined ? 1 : parseFloat(m[4]) }; return null; };
      const bgOf = (el) => { let e = el; const layers = []; while (e) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } e = e.parentElement; } let base = [20, 24, 30]; for (let i = layers.length - 1; i >= 0; i--) { const l = layers[i]; base = base.map((b, k) => l.rgb[k] * l.a + b * (1 - l.a)); } return base; };
      const contrast = (el) => { const fg = parse(getComputedStyle(el).color); const bg = bgOf(el); const f = fg.rgb.map((v, k) => v * fg.a + bg[k] * (1 - fg.a)); const L1 = lum(f), L2 = lum(bg); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); };
      const textX = (el) => { if (!el) return null; const r = document.createRange(); r.selectNodeContents(el); const rects = r.getClientRects(); return rects.length ? rects[0].left : el.getBoundingClientRect().left; };
      const list = document.getElementById(LIST_ID); const groups = [];
      for (const h of list.querySelectorAll('.board-card-header, .session-group-header')) {
        const labelEl = h.querySelector('.group-name-line, .session-group-name, .group-name') || h;
        const container = h.classList.contains('board-card-header') ? h.closest('.session-board-card') : null;
        let rows = container ? Array.from(container.querySelectorAll('.session-group-item')) : [];
        if (!container) { let n = h.nextElementSibling; while (n && !n.matches('.session-group-header, .session-board-card')) { if (n.matches('.session-group-item')) rows.push(n); else rows.push(...n.querySelectorAll('.session-group-item')); n = n.nextElementSibling; } }
        const hcs = getComputedStyle(labelEl);
        groups.push({ headerX: textX(labelEl), headerWeight: parseInt(hcs.fontWeight, 10), headerColor: hcs.color, rows: rows.map(li => { const name = li.querySelector('.session-label'), goal = li.querySelector('.session-goal'), dot = li.querySelector('.session-dot'), pill = li.querySelector('.session-attention-pill'); const ncs = getComputedStyle(name);
          return { h: li.getBoundingClientRect().height, dotX: dot ? dot.getBoundingClientRect().left : null, nameX: textX(name), goalX: goal ? textX(goal) : null, weight: parseInt(ncs.fontWeight, 10), color: ncs.color, nameContrast: contrast(name), goalContrast: goal ? contrast(goal) : null, sleeping: li.classList.contains('sleeping') || /Sleeping/.test(li.getAttribute('aria-label') || ''), active: li.classList.contains('active'), attention: li.classList.contains('needs-attention') || !!pill, pillText: pill ? pill.textContent.trim() : null, pillTransform: pill ? getComputedStyle(pill).textTransform : null, pillContrast: pill ? contrast(pill) : null }; }) });
      }
      return groups;
    })()`;
    const hier = await ev(HIER.replace('LIST_ID', JSON.stringify('live-sessions-list')));
    const hrows = hier.flatMap(g => g.rows.map(r => ({ ...r, headerX: g.headerX, headerWeight: g.headerWeight, headerColor: g.headerColor })));
    check('155 child name starts >= 12px right of its group header label (team and folder groups)', hrows.length >= 4 && hrows.every(r => r.nameX - r.headerX >= 12), JSON.stringify(hrows.map(r => +(r.nameX - r.headerX).toFixed(1))));
    check('155 no row has a goal line and the dot sits left of the name', hrows.every(r => r.goalX === null && r.dotX < r.nameX), JSON.stringify(hrows.map(r => [r.goalX, +(r.nameX - r.dotX).toFixed(1)])));
    check('155 headers are the strongest text: header weight >= 600, child names are the sidebar row style 400 (#9926) and not the header colour', hier.every(g => g.headerWeight >= 600) && hrows.filter(r => !r.active).every(r => r.weight === 400) && hrows.filter(r => !r.active && !r.attention).length >= 2 && hrows.filter(r => !r.active && !r.attention).every(r => r.color !== r.headerColor), JSON.stringify({ headers: hier.map(g => [g.headerWeight, g.headerColor]), names: hrows.map(r => [r.weight, r.color]) }));
    const SEL = `(() => { const li = document.querySelector('#live-sessions-list .session-group-item.active'); if (!li) return null; const probe = document.createElement('div'); probe.style.background = 'var(--bg-hover)'; document.body.appendChild(probe); const hover = getComputedStyle(probe).backgroundColor; probe.remove(); const cs = getComputedStyle(li); return { bg: cs.backgroundColor, hover, shadow: cs.boxShadow, current: li.classList.contains('list-row-current') }; })()`;
    const sel = await ev(SEL);
    check('9311 the selected agent row is the hover surface with the accent bar (.list-row-current), not an accent tile', !!sel && sel.current && sel.bg === sel.hover && /inset/.test(sel.shadow), JSON.stringify(sel));
    check('155 contrast: names >= 4.5:1 (AA; the sidebar row colour is the secondary text, #9926), goal lines >= 4.5:1', hrows.every(r => r.nameContrast >= 4.5 && (r.goalContrast === null || r.goalContrast >= 4.5)), JSON.stringify(hrows.map(r => [+r.nameContrast.toFixed(2), r.goalContrast === null ? null : +r.goalContrast.toFixed(2)])));
    const pills = hrows.filter(r => r.pillText);
    check('155 attention pill: sentence-case label, no uppercase transform, contrast >= 4.5:1', pills.length >= 1 && pills.every(r => /^(Needs input|Check terminal|Stuck)$/.test(r.pillText) && r.pillTransform !== 'uppercase' && r.pillContrast >= 4.5), JSON.stringify(pills.map(r => [r.pillText, r.pillTransform, +r.pillContrast.toFixed(2)])));
    check('155 every row is 36px (one line, #9686)', hrows.every(r => Math.abs(r.h - 36) <= 1), JSON.stringify(hrows.map(r => r.h)));
    // ── #159 status dot: an idle agent's is grey (it was hidden until #9784), its slot is reserved, no layout shift on state ticks ──
    await ev(`localStorage.setItem('coral-group-by-team','false'); window._coralSetLiveSessions(JSON.parse(JSON.stringify(window.__fixture))); true`); await nextFrame();
    const DOTS = (listId) => `(() => Object.fromEntries(Array.from(document.querySelectorAll('#' + ${JSON.stringify('LIST')} + ' .session-group-item')).map(li => { const d = li.querySelector('.session-dot'); const n = li.querySelector('.session-label'); const cs = d ? getComputedStyle(d) : null; const r = d ? d.getBoundingClientRect() : null; const range = document.createRange(); range.selectNodeContents(n); const nx = range.getClientRects()[0].left;
      const shown = !!cs && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05 && cs.display !== 'none' && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(cs.backgroundColor);
      return [li.dataset.sessionId, { cls: d ? d.className : null, shown, slotW: r ? r.width : 0, display: cs ? cs.display : null, nameX: nx, dotX: r ? r.left : null, aria: li.getAttribute('aria-label') }]; })))()`.replace('LIST', listId);
    let dots = await ev(DOTS('live-sessions-list'));
    check('159 an idle agent draws its grey dot (the row always has a state, look check #9773 item 1) in the same reserved slot (width >= 6px)', /stale/.test(dots[F].cls || '') && dots[F].shown && dots[F].slotW >= 6 && dots[F].display !== 'none', JSON.stringify(dots[F]));
    check('159 meaningful dots stay visible: working (+ctx-high), needs-input, check-terminal', dots[A].shown && /working/.test(dots[A].cls) && dots[B].shown && dots[C].shown, JSON.stringify({ A: dots[A].cls, B: dots[B].cls, C: dots[C].cls }));
    check('159 the dot is decoration: aria-label still carries the idle state', /, Idle$/.test(dots[F].aria || ''), dots[F].aria);
    check('159 name x is identical for hidden-dot and visible-dot rows in the same layout (slot preserved)', Math.abs((dots[F].nameX - dots[F].dotX) - (dots[A].nameX - dots[A].dotX)) <= 1, JSON.stringify({ F: [dots[F].dotX, dots[F].nameX], A: [dots[A].dotX, dots[A].nameX] }));
    const nameXBefore = dots[F].nameX;
    await ev(`window._coralHandleWsMessage({ type: 'coral_diff', changed: [{ name: 'other-proj', agent_type: 'claude', session_id: '${F}', working: true }] }); true`); await nextFrame();
    dots = await ev(DOTS('live-sessions-list'));
    check('159 idle -> working tick shows the dot without shifting the name', dots[F].shown && Math.abs(dots[F].nameX - nameXBefore) <= 0.5, JSON.stringify({ shown: dots[F].shown, before: nameXBefore, after: dots[F].nameX }));
    await ev(`window._coralHandleWsMessage({ type: 'coral_diff', changed: [{ name: 'other-proj', agent_type: 'claude', session_id: '${F}', working: false }] }); true`); await nextFrame();
    // stuck and idle-at-high-context keep a visible dot; tooltip still exposes the idle state
    await ev(`window._coralHandleWsMessage({ type: 'coral_diff', changed: [{ name: 'other-proj', agent_type: 'claude', session_id: '${F}', stuck: true }] }); true`); await nextFrame();
    dots = await ev(DOTS('live-sessions-list'));
    check('159 stuck dot is visible', dots[F].shown && /stuck/.test(dots[F].cls), JSON.stringify(dots[F].cls));
    await ev(`window._coralHandleWsMessage({ type: 'coral_diff', changed: [{ name: 'other-proj', agent_type: 'claude', session_id: '${F}', stuck: false, context_pct: 91, context_window: 1000000 }] }); true`); await nextFrame();
    dots = await ev(DOTS('live-sessions-list'));
    check('159 idle row at >= 80% context keeps its (tinted) dot', dots[F].shown && /ctx-high/.test(dots[F].cls), JSON.stringify(dots[F].cls));
    await ev(`window._coralHandleWsMessage({ type: 'coral_diff', changed: [{ name: 'other-proj', agent_type: 'claude', session_id: '${F}', context_pct: 12 }] }); true`); await nextFrame();
    const idleTip = String(await ev(`window.buildSessionTooltip(window._coralGetLiveSessions().find(s => s.session_id === '${F}'))`)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    check('159 tooltip still exposes the state of a hidden-dot row', /State\s+Idle/i.test(idleTip), idleTip.slice(0, 80));
    check('exceptions none (desktop)', exceptions.length === 0, JSON.stringify(exceptions.slice(0, 2)));
    // phone
    await boot(390, 844, true);
    // the kebab is the button (not its wrapper), measured as what a finger hits: a 24 px box with a 44 px ::after (#9332)
    const m = await ev(`(() => { const li = document.querySelector('#mobile-session-list [data-session-id="${B}"]'); if (!li) return null; const q = s => li.querySelector(s); const k = q('.sidebar-kebab-btn'); const kr = k ? (${TOUCH_AREA})(k) : null; const goal = q('.session-goal'); return { h: li.getBoundingClientRect().height, avatar: !!q('.agent-avatar'), activity: !!q('.session-activity-text'), chip: [...li.querySelectorAll('.session-state-pill')].map(c => c.textContent.trim()), statusChip: !!q('.session-status-chip'), unread: !!q('.session-mobile-meta-pill'), kebab: kr ? [kr.w, kr.h] : null, goal: !!goal, banner: !!q('.session-mobile-banner-row') && getComputedStyle(q('.session-mobile-banner-row')).display !== 'none' }; })()`);
    const hierM = await ev(HIER.replace('LIST_ID', JSON.stringify('mobile-session-list')));
    const mrows = hierM.flatMap(g => g.rows.map(r => ({ ...r, headerWeight: g.headerWeight, headerColor: g.headerColor })));
    check('155 phone: names lighter than headers, no goal line (#9686)', mrows.length >= 3 && mrows.every(r => r.goalX === null) && mrows.every(r => r.weight <= 500 && (r.active || r.attention || r.color !== r.headerColor) && (r.goalContrast === null || r.goalContrast >= 4.5)), JSON.stringify(mrows.map(r => [r.goalX === null ? null : +(r.goalX - r.nameX).toFixed(1), r.weight, r.goalContrast === null ? null : +r.goalContrast.toFixed(2)])));
    const mdots = await ev(DOTS('mobile-session-list'));
    check('159 phone clone: the idle dot is drawn in its reserved slot, meaningful dots visible', mdots[F] && mdots[F].shown && mdots[F].slotW >= 6 && mdots[A].shown && mdots[B].shown && Math.abs((mdots[F].nameX - mdots[F].dotX) - (mdots[A].nameX - mdots[A].dotX)) <= 1, JSON.stringify({ F: mdots[F], A: mdots[A] && mdots[A].cls }));
    check('8 phone row: one flat 44px line, no avatar, no elapsed text, no goal, banner or status chip, one chip (Needs input), 44px kebab', m && !m.avatar && !m.activity && Math.abs(m.h - 44) <= 1 && !m.goal && !m.banner && !m.statusChip && m.chip.length === 1 && m.chip[0] === 'Needs input' && m.kebab && m.kebab[0] >= 44 && m.kebab[1] >= 44, JSON.stringify(m));
    await ev(`document.querySelector('#mobile-session-list [data-session-id="${B}"]').focus(); true`);
    await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until(`/Auto Bot|Renamed Bot/.test(document.getElementById('session-name').textContent)`, 'the phone row selected');
    check('14 cloned phone row: Enter selects (delegated handler survives cloneNode)', await ev(`/Auto Bot|Renamed Bot/.test(document.getElementById('session-name').textContent)`));
    check('14 cloned phone row: kebab first item is Open Agent Tab', await ev(`(() => { window.closeSidebarKebabs(); const kb = document.querySelector('#mobile-session-list [data-session-id="${B}"] .sidebar-kebab-btn'); if (kb) window.toggleSidebarKebab(kb); const m = document.querySelector('#mobile-session-list [data-session-id="${B}"] .sidebar-kebab-menu'); const f = m ? Array.from(m.children).find(c => c.matches('.overflow-menu-item')) : null; const t = f ? f.textContent.trim() : null; window.closeSidebarKebabs(); return t; })()`) === 'Open Agent Tab');
  } finally {
    await guard.restore().catch(e => console.error('settings restore: ' + (e && e.message)));
    await client.close();
  }
  const f = results.filter(v => v === 'FAIL').length; console.log(`\n${results.length - f}/${results.length} checks passed`); process.exit(f ? 1 : 0);
}
run().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
