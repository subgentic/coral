// Settings > Inbox, and the quiet line in Needs you (#12144, the Operator's design v6, slice 2): a group "Inbox" in Settings with a switch for each kind of optional item (all on by default), the included teams
// (all ticked), the time of the daily items (09:00), and a plain line that questions and decisions always reach you (no switch). Turning a kind off and a team off, then Save, sends exactly those values; what is saved
// is shown again on the next open. A team list that cannot be loaded says so with Retry and keeps the saved choice (not the words of an empty list). In the Needs you folder a switched-off kind is never silent: one quiet line says
// what was muted and opens the folder it is in, and a muted file more than a day old is named there ONCE. The Settings line has the same Show them. At 1440 and 390 px. CORAL_SCREENSHOT_DIR keeps pictures.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await sleep(350); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }; // sleep-ok: a picture waits for the paint
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`(() => { window.__puts = []; const real = window.fetch; const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
                const hex = c => c.repeat(64), at = i => new Date(Date.now() - i * 3600000).toISOString();
                const file = (c, name, extra) => ({ id: hex(c), name, uri: 'coral://artifacts/' + hex(c), digest: hex(c), available: true, tags: ['for review'], created_at: at(3), ...extra });
                window.__files = [file('a', 'plan.md'), file('b', 'release-notes.md', { kind: 'release', muted: true }), file('d', 'decisions.md', { kind: 'decided', muted: true }), file('e', 'old-notes.md', { muted: true, created_at: at(50) })];
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.href), m = (o.method || 'GET').toUpperCase();
                    if (url.pathname === '/api/settings' && m === 'PUT') { window.__puts.push(JSON.parse(o.body)); return json({ ok: true }); }
                    if (url.pathname !== '/api/board/projects' && url.pathname.endsWith('/api/board/projects')) return window.__remote === 'fail' ? json({ error: 'that computer did not answer' }, 502) : json((window.__remote || []).map(p => ({ project: p })));
                    if (url.pathname === '/api/board/projects') return window.__projects === 'fail' ? json({ error: 'could not read the boards' }, 500) : json((window.__projects || ['alpha', 'beta', 'gamma']).map(p => ({ project: p })));
                    if (/^\\/api\\/board\\/[a-z]+\\/artifacts$/.test(url.pathname) && url.searchParams.get('tag') === 'for review') return json({ artifacts: url.pathname.includes('/alpha/') ? window.__files : [], has_more: false });
                    return real(u, o); }; return true; })()`);
            await ev(`try { localStorage.removeItem('coral-muted-old-seen'); } catch (e) {} import(${S} + 'state.js').then(m => { m.state.settings = {}; return true; })`);
            await ev(`(async () => { await window.showSettingsModal(); return true; })()`);
            await waitFor(`!!document.getElementById('settings-inbox-release')`, 'the Inbox controls', 8000);
            await sleep(500); // sleep-ok: the team boxes are drawn from the boards the page just read; no event marks them done
            const view = () => ev(`(() => { const on = id => { const e = document.getElementById(id); return e ? e.checked : null; };
                const tab = document.getElementById('settings-tab-needs-you'), pane = document.getElementById('settings-pane-needs-you');
                return { tab: tab ? tab.textContent.replace(/\\s+/g, ' ').trim() : null, always: (document.getElementById('settings-inbox-always') || {}).textContent || '',
                    kinds: ['file', 'done', 'release', 'decided', 'digest'].map(k => on('settings-inbox-' + k)), time: (document.getElementById('settings-inbox-digest-time') || {}).value,
                    teams: [...document.querySelectorAll('#settings-inbox-teams input[data-team]')].map(b => [b.dataset.team, b.checked]), muted: (document.getElementById('settings-inbox-muted') || {}).textContent || '', paneIn: !!pane }; })()`);
            let v = await view();
            check(`${tag}: Settings has an Inbox group`, v.paneIn && /Inbox/.test(v.tab || ''), JSON.stringify(v.tab));
            check(`${tag}: questions and decisions are said to always reach you, with no switch of their own`, /always reach you/i.test(v.always) && !(await ev(`!!document.querySelector('#settings-pane-needs-you input[id*="question"], #settings-pane-needs-you input[id*="decision-always"]')`)), v.always);
            check(`${tag}: every kind is on by default`, JSON.stringify(v.kinds) === '[true,true,true,true,true]', JSON.stringify(v.kinds));
            check(`${tag}: all three teams are ticked, and the daily time is 09:00`, JSON.stringify(v.teams) === '[["alpha",true],["beta",true],["gamma",true]]' && v.time === '09:00', JSON.stringify([v.teams, v.time]));
            await ev(`import(${S} + 'settings_nav.js').then(m => m.openSettingsGroup('needs-you')).then(() => true)`); // the picture shows the Inbox group, not the one last open
            await shot(`settings-inbox-${w}`);
            // the teams cannot be loaded: not the words of an empty list, a way to try again, and the saved choice is kept
            const refill = async (projects, saved) => { await ev(`window.__projects = ${JSON.stringify(projects)}; import(${S} + 'settings_inbox.js').then(m => m.fillInboxSettings({ inbox_included_teams: ${JSON.stringify(saved)} })).then(() => true)`); await sleep(500); }; // sleep-ok: the team list is read from the boards just stubbed
            await refill('fail', '["alpha"]');
            const failed = await ev(`(() => { const h = document.getElementById('settings-inbox-teams'), f = h.querySelector('.settings-inbox-teams-failed'); return { text: f ? f.textContent.replace(/\\s+/g, ' ').trim() : null, retry: !!(f && f.querySelector('button')), boxes: h.querySelectorAll('input[data-team]').length, role: f && f.getAttribute('role') }; })()`);
            check(`${tag}: teams that could not be read say so, with Retry, and draw no box`, failed.text && /could not be loaded/.test(failed.text) && !/No teams yet/.test(failed.text) && failed.retry && failed.boxes === 0 && failed.role === 'alert', JSON.stringify(failed));
            check(`${tag}: and Save would send the saved choice unchanged`, (await ev(`import(${S} + 'settings_inbox.js').then(m => m.readInboxSettings({ inbox_included_teams: '["alpha"]' }).inbox_included_teams)`)) === '["alpha"]');
            await shot(`settings-inbox-teams-failed-${w}`);
            await refill([], 'all');
            const none = await ev(`(() => { const h = document.getElementById('settings-inbox-teams'); return { failed: !!h.querySelector('.settings-inbox-teams-failed'), text: h.textContent.trim() }; })()`);
            check(`${tag}: a genuinely empty list is another thing: it says there are no teams yet`, !none.failed && /No teams yet/.test(none.text), JSON.stringify(none));
            await refill('fail', '["alpha"]');
            await ev(`window.__projects = null; document.querySelector('#settings-inbox-teams .settings-inbox-teams-failed button').click(); true`);
            await sleep(500); // sleep-ok: Retry reads the boards again
            check(`${tag}: Retry draws the teams with the saved choice (alpha only)`, JSON.stringify(await view().then(x => x.teams)) === '[["alpha",true],["beta",false],["gamma",false]]');
            // UI Reviewer's MUST: an explicit saved choice stays explicit. alpha is included and online, beta is left out and offline (not drawn): every DRAWN box is ticked, and Save of an unrelated setting keeps ["alpha"]
            await refill(['alpha'], '["alpha"]');
            check(`${tag}: every drawn box ticked is not "all": a saved ["alpha"] stays ["alpha"]`, (await ev(`import(${S} + 'settings_inbox.js').then(m => m.readInboxSettings({ inbox_included_teams: '["alpha"]' }).inbox_included_teams)`)) === '["alpha"]');
            await refill(['alpha', 'beta'], '["alpha"]');
            check(`${tag}: ticking another box makes a list of its own, never "all"`, (await ev(`(() => { document.querySelector('#settings-inbox-teams input[data-team="beta"]').click(); return import(${S} + 'settings_inbox.js').then(m => m.readInboxSettings({ inbox_included_teams: '["alpha"]' }).inbox_included_teams); })()`)) === '["alpha","beta"]');
            await refill(['alpha', 'beta'], '["alpha"]');
            await ev(`document.querySelector('#settings-inbox-teams .settings-inbox-every').click(); true`);
            check(`${tag}: only the person's own choice of every team saves "all" (Include every team)`, (await ev(`import(${S} + 'settings_inbox.js').then(m => m.readInboxSettings({ inbox_included_teams: '["alpha"]' }).inbox_included_teams)`)) === 'all');
            await ev(`document.querySelector('#settings-inbox-teams input[data-team="beta"]').click(); true`);
            check(`${tag}: and a box changed by hand afterwards is a list again`, (await ev(`import(${S} + 'settings_inbox.js').then(m => m.readInboxSettings({ inbox_included_teams: '["alpha"]' }).inbox_included_teams)`)) === '["alpha"]');
            check(`${tag}: Include every team is still there after a box was changed by hand`, await ev(`!!document.querySelector('#settings-inbox-teams .settings-inbox-every')`));
            await ev(`document.querySelector('#settings-inbox-teams .settings-inbox-every').click(); true`);
            check(`${tag}: and takes the person back to every team without reopening Settings`, (await ev(`import(${S} + 'settings_inbox.js').then(m => m.readInboxSettings({ inbox_included_teams: '["alpha"]' }).inbox_included_teams)`)) === 'all');
            // the change listener is bound once, however often the teams are drawn again
            await ev(`(() => { const h = document.getElementById('settings-inbox-teams'); window.__changeBinds = 0; const orig = h.addEventListener; h.addEventListener = function (t, ...r) { if (t === 'change') window.__changeBinds++; return orig.call(this, t, ...r); }; return true; })()`);
            await refill(['alpha', 'beta'], '["alpha"]'); await refill(['alpha', 'beta'], '["alpha"]');
            check(`${tag}: the teams drawn again twice bind no second change listener`, (await ev(`window.__changeBinds`)) === 0);
            // another computer is managed from here: a failed read of it is a failure of the whole list (never a shorter list that Save would rewrite the choice from); when it answers its teams are drawn
            await ev(`import(${S} + 'state.js').then(m => { m.state.hub = true; m.state.servers = [{ id: 'srv2', name: 'srv2', status: 'online' }]; return true; })`);
            await ev(`window.__remote = 'fail'; true`);
            await refill(null, '["alpha","srv2:away"]');
            const part = await ev(`(() => { const h = document.getElementById('settings-inbox-teams'); return { failed: !!h.querySelector('.settings-inbox-teams-failed'), boxes: h.querySelectorAll('input[data-team]').length }; })()`);
            check(`${tag}: one computer that cannot be read fails the whole list: no partial boxes`, part.failed && part.boxes === 0, JSON.stringify(part));
            await ev(`window.__remote = ['delta']; true`);
            await refill(null, '["alpha","srv2:away"]');
            const drawn = await ev(`(() => ({ boxes: [...document.querySelectorAll('#settings-inbox-teams input[data-team]')].map(b => [b.dataset.team, b.checked]) }))()`);
            check(`${tag}: when it answers its teams are drawn too`, drawn.boxes.length === 4 && drawn.boxes.some(([t]) => /delta/.test(t)), JSON.stringify(drawn));
            check(`${tag}: a saved team that is not drawn now (its computer is away) stays in the choice`, (await ev(`import(${S} + 'settings_inbox.js').then(m => m.readInboxSettings({ inbox_included_teams: '["alpha","srv2:away"]' }).inbox_included_teams)`)) === '["alpha","srv2:away"]');
            await ev(`import(${S} + 'state.js').then(m => { m.state.hub = false; m.state.servers = []; return true; })`);
            await ev(`window.__remote = null; true`);
            await refill(null, 'all');
            // turn Release summaries off and untick gamma, set the time, Save
            await ev(`(() => { const set = (id, f) => { const e = document.getElementById(id); f(e); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
                set('settings-inbox-release', e => { e.checked = false; }); set('settings-inbox-digest-time', e => { e.value = '07:30'; });
                const g = document.querySelector('#settings-inbox-teams input[data-team="gamma"]'); g.checked = false; g.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await ev(`(async () => { await window.applySettings(); return true; })()`);
            await sleep(600); // sleep-ok: the save is stubbed and answers at once; the toast and redraw follow
            const put = await ev(`window.__puts[window.__puts.length - 1] || null`);
            check(`${tag}: Save sends the switch, the teams and the time as chosen`, put && put.inbox_kind_release === false && put.inbox_kind_file === true && put.inbox_digest_time === '07:30' && put.inbox_included_teams === '["alpha","beta"]', JSON.stringify(put && Object.fromEntries(Object.entries(put).filter(([k]) => k.startsWith('inbox_')))));
            await ev(`window.__puts.length = 0; true`);

            // the Needs you folder: the quiet line for what the switches keep out
            await ev(`window.hideSettingsModal && window.hideSettingsModal(); true`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await ev(`import(${S} + 'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true)`);
            await waitFor(`!!document.querySelector('.inbox-muted-line')`, 'the quiet Muted line', 8000);
            const line = await ev(`(() => { const p = document.querySelector('.inbox-muted-line'); return { text: p.textContent.replace(/\\s+/g, ' ').trim(), btn: !!p.querySelector('button') }; })()`);
            check(`${tag}: a switched-off kind is never silent: one quiet line says what was muted, and a muted file more than a day old is named once`, /^Muted by your settings: 1 file for review, 1 release summary, 1 decision made for you\. 1 muted file is more than a day old: old-notes\.md\. Show them$/.test(line.text) && line.btn, JSON.stringify(line));
            await shot(`needs-you-muted-line-${w}`);
            const count = await ev(`import(${S} + 'inbox_reviews.js').then(m => ({ unread: m.unreadReviewItems().length, muted: m.mutedReviewItems().length }))`);
            check(`${tag}: the muted files are not counted, and are kept`, count.unread === 1 && count.muted === 3, JSON.stringify(count));
            await ev(`document.querySelector('.inbox-muted-line button').click(); true`);
            await sleep(400); // sleep-ok: the folder switch redraws over a frame or two
            check(`${tag}: Show them opens the folder they are in (Artifacts)`, await ev(`!!document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="artifacts"][aria-current="true"]')`));

            // Settings has the same line and the same way to them
            await ev(`(async () => { await window.showSettingsModal(); await import(${S} + 'settings_nav.js').then(m => m.openSettingsGroup('needs-you')); await import(${S} + 'settings_inbox.js').then(m => m.drawMutedLine()); return true; })()`);
            await sleep(400); // sleep-ok: the pane draws over a frame or two
            const sline = await ev(`(() => { const p = document.getElementById('settings-inbox-muted'); return { shown: !!p && !p.hidden, text: p ? p.textContent.replace(/\\s+/g, ' ').trim() : '', btn: !!(p && p.querySelector('button')) }; })()`);
            check(`${tag}: the Settings line says what was muted in the last 7 days, with Show them`, sline.shown && /^Muted in the last 7 days: 1 file for review, 1 release summary, 1 decision made for you\. Show them$/.test(sline.text) && sline.btn, JSON.stringify(sline));
            await ev(`document.getElementById('settings-inbox-muted').scrollIntoView({ block: 'center' }); true`);
            await shot(`settings-inbox-muted-${w}`);
            await ev(`document.querySelector('#settings-inbox-muted button').click(); true`);
            await sleep(500); // sleep-ok: the dialog closes and the folder switches
            check(`${tag}: its Show them closes Settings and opens Artifacts`, await ev(`!document.getElementById('settings-modal') || document.getElementById('settings-modal').hidden || getComputedStyle(document.getElementById('settings-modal')).display === 'none'`) && await ev(`!!document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="artifacts"][aria-current="true"]')`));
            // once: a new visit (the page loaded again) does not name the day-old file again; the line still says what is muted
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`(() => { const real = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
                const hex = c => c.repeat(64), at = i => new Date(Date.now() - i * 3600000).toISOString();
                const file = (c, name, extra) => ({ id: hex(c), name, uri: 'coral://artifacts/' + hex(c), digest: hex(c), available: true, tags: ['for review'], created_at: at(3), ...extra });
                const files = [file('a', 'plan.md'), file('e', 'old-notes.md', { muted: true, created_at: at(50) })];
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.href);
                    if (url.pathname === '/api/board/projects') return json([{ project: 'alpha' }]);
                    if (url.pathname === '/api/board/alpha/artifacts' && url.searchParams.get('tag') === 'for review') return json({ artifacts: files, has_more: false });
                    if (url.pathname === '/api/board/alpha/artifacts') return json({ artifacts: [], has_more: false });
                    return real(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await ev(`import(${S} + 'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true)`);
            await waitFor(`!!document.querySelector('.inbox-muted-line')`, 'the quiet line on the next visit', 8000);
            const again = await ev(`document.querySelector('.inbox-muted-line').textContent.replace(/\\s+/g, ' ').trim()`);
            check(`${tag}: the day-old file is named once: the next visit says only what is muted`, /^Muted by your settings: 1 file for review\. Show them$/.test(again), again);
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Settings > Inbox checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
