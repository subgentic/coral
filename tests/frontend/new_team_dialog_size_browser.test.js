// The New team dialog never moves or resizes (#7407; UI/UX's final v4 doc ad146b3a, section 2 and the shared rules): one size for every step, every step-3 tab, with and without a template, with the worktree option on,
// with the remote address open, with the More menu open, and the Edit member dialog (and each of its tabs) is the same size and place. Desktop: 960 px wide and the smaller of 720 px and the
// screen minus 32 high; phone: a full-height sheet. Measured at 1280x800, 390x844 and 390x844 at 200% text. Written failing-first by QA (#7415); controls by role and name (helpers/new_team.js). Isolated dev server.
const assert = require('node:assert/strict');
const { execFileSync } = require('./helpers/child_process.js');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { install: installNT, M, N, T, openNewTeam, scenarios, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

const VIEWS = [['1280x800', 1280, 800, false, false], ['390x844', 390, 844, true, false], ['390x844 at 200% text', 390, 844, true, true]];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios(); const t = T(ev, waitFor);
    const gitDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'qa-team-git-')); execFileSync('git', ['init', '-q', gitDir]);
    const same = (a, b, what) => { assert.ok(a && b, `${what}: the dialog is open`); for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(a[k] - b[k]) <= 0.5, `${what}: dialog ${k} changed from ${a[k]} to ${b[k]}`); };
    const goSection = async (rx, name, within) => { const used = await ev(`(() => { const d = window.__nt.dlg(${within}); const tab = [...d.querySelectorAll('[role=tab]')].filter(window.__na.vis).find(x => window.__na.name(x) === ${JSON.stringify(name)}); if (tab) { tab.click(); return true; } const s = window.__nt.find(d, 'select', ${N.section}); if (!s) return false; const o = [...s.options].find(o => o.textContent.trim() === ${JSON.stringify(name)}); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); assert.ok(used, `a ${name} tab or section choice`); await settle(300); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile, big] of VIEWS) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNT(ev); await stubModels(ev);
            await ev(`document.documentElement.style.fontSize = ${big ? "'32px'" : "''"}; localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
            let base = null;
            await S.run(`${label}: New team has the fixed size (desktop 960 wide, min(720, screen - 32) high; phone: a full-height sheet) and the same rectangle on steps 1, 2 (blank and with a template) and 3`, async () => {
                await openNewTeam(ev, waitFor); await settle(400); base = await t.rect(); assert.ok(base, 'the New team dialog is open');
                const problem = mobile ? (Math.abs(base.h - h) <= 2 && base.w >= w - 24 ? '' : `phone: a full-height sheet (dialog ${base.w}x${base.h} in ${w}x${h})`) : (Math.abs(base.w - 960) <= 1 && Math.abs(base.h - Math.min(720, h - 32)) <= 1 ? '' : `desktop: 960 x min(720, ${h - 32}) (dialog is ${base.w}x${base.h})`);
                await t.type('input', N.teamName, 'alpha'); await t.type('input', N.folder, '/work/payments-app'); same(base, await t.rect(), 'step 1 filled');
                await t.click('button', N.next); await t.step(2); await settle(300); same(base, await t.rect(), 'step 2 blank');
                await t.pick(N.template, /Coding|\(\d+ members\)/); await settle(500); same(base, await t.rect(), 'step 2 with a template');
                await t.click('button', N.next); await t.step(3); await settle(300); same(base, await t.rect(), 'step 3');
                assert.equal(problem, '', problem);
            });
            await S.run(`${label}: every step-3 tab (Start, Workflow, Health check, Messaging) has the same rectangle, the footer is on screen, no sideways scroll`, async () => {
                assert.ok(base, 'step 3 reached');
                for (const n of N.tabs) { await goSection(N.section, n, N.team); same(base, await t.rect(), `tab ${n}`); }
                const b = await ev(`window.__nt.buttons(window.__nt.dlg(${N.team}))`); const l = b.find(x => N.launch.test(x.name)); assert.ok(l, 'Launch team is shown'); assert.ok(l.y + l.h <= h + 1, `the footer is on screen (Launch team bottom ${l.y + l.h} of ${h})`);
                assert.ok(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), 'no sideways scroll');
            });
            await S.run(`${label}: the worktree option and the remote address open in their reserved slot: step 1 does not move`, async () => {
                await ev(`window.hideLaunchModal && window.hideLaunchModal(); T.state.hub = true; T.state.cloud = false; T.state.serversKnown = true; T.state.servers = [{ id: 'm1', label: 'build-server', status: 'online', version: '1.4.6', last_seen: new Date().toISOString() }]; true`);
                await openNewTeam(ev, waitFor); await settle(300); const r1 = await t.rect();
                await t.type('input', N.teamName, 'alpha'); await t.type('input', N.folder, '/work/payments-app'); await settle(300); same(r1, await t.rect(), 'step 1 with a folder');
                await t.pick(N.machine, /^Another computer/); await settle(300); same(r1, await t.rect(), 'the remote address open');
                assert.ok(await t.pick(N.machine, /^This computer/), 'the Machine select has an entry named This computer (UI/UX 07:36Z; it read Local (this machine))'); await t.type('input', N.folder, gitDir);
                await waitFor(`!!window.__nt.find(window.__nt.dlg(${N.team}), 'input', /worktree/i)`, 'the worktree option', 6000); same(r1, await t.rect(), 'the worktree option shown');
                await ev(`window.__nt.find(window.__nt.dlg(${N.team}), 'input', /worktree/i).click(); true`); await settle(300); same(r1, await t.rect(), 'the worktree ticked with its base branch');
                await ev(`window.hideLaunchModal(); T.state.servers = []; T.state.hub = false; T.state.cloud = false; true`);
            });
            await S.run(`${label}: the More menu opens without resizing the dialog, and the Edit member dialog (every tab) is the same rectangle as New team`, async () => {
                await openNewTeam(ev, waitFor); await settle(300); const r0 = await t.rect();
                await t.to(2, { template: /Coding|\(\d+ members\)/ }); await settle(400); same(r0, await t.rect(), 'step 2 with a template');
                await t.click('button', /^More/i); await settle(250); same(r0, await t.rect(), 'More menu open');
                await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`); await settle(200);
                const role = (await ev(`window.__nt.roles(window.__nt.dlg(${N.team}))`))[1];
                await ev(`(() => { const b = window.__nt.rows(window.__nt.dlg(${N.team})).find(x => window.__na.name(x) === 'Edit ' + ${JSON.stringify(role)}); b.click(); return true; })()`);
                await waitFor(`!!window.__nt.dlg(${N.member})`, 'Edit member opens', 5000); await settle(300);
                const m0 = await ev(`window.__na.box(window.__nt.panel(window.__nt.dlg(${N.member})))`); same(r0, m0, 'Edit member vs New team');
                const mem = M(ev, waitFor);
                for (const n of N.memberTabs) { await mem.section(n); same(m0, await ev(`window.__na.box(window.__nt.panel(window.__nt.dlg(${N.member})))`), `Edit member tab ${n}`); }
                await mem.toPersona(); same(m0, await ev(`window.__na.box(window.__nt.panel(window.__nt.dlg(${N.member})))`), 'Edit member persona page');
                await mem.cancel(); same(r0, await t.rect(), 'New team after Edit member closes');
            });
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); document.documentElement.style.fontSize = ''; true`);
        }
        S.finish();
    } finally { try { fs.rmSync(gitDir, { recursive: true, force: true }); } catch { /* gone */ } await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
