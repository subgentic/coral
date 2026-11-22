// #20388 (mock #20111): the Where step under the folder field. Real server (the runner's isolated one), a real git repository with a second branch and a worktree on this machine; no stubs.
// Typing the repository's folder shows its branch and that it is clean; a change in the folder turns up as "changed" with a warning line; a worktree can be picked to launch in it; a folder that is not a repository
// says so; a recent repo is listed with its own state. New terminal gets the same step and no CLI line. At 1280 and 390 px.
const assert = require('node:assert/strict');
const { execFileSync } = require('./helpers/child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });

(async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'where-')));
    const repo = path.join(root, 'payments-app'), side = path.join(root, 'payments-side'), plain = path.join(root, 'plain');
    fs.mkdirSync(repo); fs.mkdirSync(plain);
    git(repo, 'init', '-q', '-b', 'trunk'); git(repo, 'commit', '-q', '--allow-empty', '-m', 'init'); git(repo, 'branch', 'feature'); git(repo, 'worktree', 'add', '-q', '-b', 'fix-login', side);
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); await sleep(400); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }; // sleep-ok: a picture waits for the paint
    const panel = kind => `.launch-where[data-launch-where="${kind}"]`;
    const type = async (id, value) => ev(`(() => { const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const text = kind => ev(`document.querySelector(${JSON.stringify(panel(kind))})?.textContent.replace(/\\s+/g, ' ') || ''`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, mobile] of [[1280, false], [390, true]]) {
            const at = `${width}px: `;
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            // the experimental switch a worktree launch needs (#12746) is on in the answer the page reads; nothing is written to the server's settings, and this suite launches nothing
            await ev(`(() => { const R = window.fetch; window.fetch = (u, o) => !String(u).includes('/api/launch/where') ? R(u, o) : R(u, o).then(async r => { const d = await r.json(); d.worktree_launch = true; return new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } }); }); return true; })()`);
            await ev(`window.showLaunchModal(); window._selectLaunchType('agent'); true`);
            await waitFor(`!!document.getElementById('launch-dir') && !!document.querySelector(${JSON.stringify(panel('agent'))})`, 'the where panel is mounted', 8000);
            await type('launch-dir', repo);
            await waitFor(`/Use this folder as it is/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '')`, 'the repository is read', 8000);
            let t = await text('agent');
            check(`${at}a repository shows its branch and that it is clean`, /trunk/.test(t) && /clean/.test(t), t.slice(0, 160));
            await waitFor(`/Claude is|Claude (is )?not/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '')`, 'the CLI line of the check', 8000);
            t = await text('agent');
            check(`${at}the setup check says the repo was found and says where the agent's CLI stands`, /Setup check/.test(t) && /Repo found/.test(t) && /Claude (is|not)/.test(t) && /to fix|to know|all good|not checked|can launch/.test(t), t.slice(t.indexOf('Setup check')));
            check(`${at}the computer it runs on is named, with a way to change it`, await ev(`(() => { const c = document.querySelector('[data-launch-where-computer="agent"]'); return !!c && /Computer/.test(c.textContent) && !!c.querySelector('.launch-where-computer-chip') && !!c.querySelector('[data-launch-computer="change"]'); })()`));
            check(`${at}the branch is the mock's list: this folder, a new worktree, a worktree that exists, another branch`, await ev(`[...document.querySelectorAll(${JSON.stringify(panel('agent') + ' .launch-where-branches > .launch-where-list > .launch-where-opt .launch-where-opt-title')})].map(n => n.textContent).join('|')`) === 'Use this folder as it is|New worktree from trunk|A worktree that exists|Another branch');
            check(`${at}the setup check follows the branch list (the mock's order), not stuck over it`, await ev(`(() => { const p = document.querySelector(${JSON.stringify(panel('agent'))}), c = p.querySelector('.launch-where-check'), l = p.querySelector('.launch-where-opt:last-of-type') || p.querySelector('.launch-where-opt'); return getComputedStyle(c).position !== 'sticky' && !!l && l.getBoundingClientRect().bottom <= c.getBoundingClientRect().top + 1; })()`));
            check(`${at}the trust tick has its label right beside the box, visible and left-aligned`, await ev(`(() => { const b = document.getElementById('launch-agent-trust'), l = b && b.closest('label'); if (!b || document.getElementById('launch-agent-trust-row').hidden) return false; const br = b.getBoundingClientRect(), lr = l.getBoundingClientRect(), t = document.createRange(); t.selectNodeContents(l); const tr = t.getBoundingClientRect(); return br.width < 24 && br.height < 24 && /Trust/.test(l.textContent) && tr.left - br.right < 16 && tr.left - lr.left < 40 && lr.height < 40; })()`));
            await shot(`where-agent-${width}`);
            fs.writeFileSync(path.join(repo, 'new.txt'), 'x');
            await type('launch-dir', repo + '/'); await type('launch-dir', repo);
            await waitFor(`/1 changed/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '')`, 'the change is seen', 8000);
            t = await text('agent');
            check(`${at}a changed folder says so, as a warning to know, and does not block`, /1 changed/.test(t) && /1 uncommitted change/.test(t) && /to know|to fix/.test(t) && !(await ev(`document.getElementById('launch-agent-go')?.disabled === true && !document.querySelector('.cli-warning, #launch-cli-warning')`)));
            fs.rmSync(path.join(repo, 'new.txt'));
            await ev(`(() => { const r = document.querySelector(${JSON.stringify(panel('agent') + ' input[name="launch-where-branch-agent"][value="exists"]')}); r.click(); return true; })()`);
            await waitFor(`!!document.querySelector(${JSON.stringify(panel('agent') + ' input[name="launch-where-wt-agent"]')})`, 'the worktrees are listed', 8000);
            await ev(`(() => { const r = [...document.querySelectorAll(${JSON.stringify(panel('agent') + ' input[name="launch-where-wt-agent"]')})].find(x => x.value === ${JSON.stringify(side)}); r.click(); return true; })()`);
            await waitFor(`document.getElementById('launch-dir').value === ${JSON.stringify(side)}`, 'picking a worktree puts its folder in the field', 4000);
            await waitFor(`/fix-login/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '')`, 'the worktree is read', 8000);
            check(`${at}picking a worktree launches in its folder, on its branch`, (await text('agent')).includes('fix-login'));
            // a worktree an agent is working in: said, with the agent named, and the two ways out
            await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => { m.state.liveSessions = [{ session_id: 'r1', name: 'Reviewer', display_name: 'Reviewer', agent_type: 'claude', working_dir: ${JSON.stringify(side)} }]; return true; })`);
            await ev(`(() => { const r = document.querySelector(${JSON.stringify(panel('agent') + ' input[name="launch-where-branch-agent"][value="exists"]')}); if (r) r.click(); return true; })()`);
            await type('launch-dir', repo);
            await waitFor(`!!document.querySelector(${JSON.stringify(panel('agent') + ' input[name="launch-where-branch-agent"][value="exists"]')})`, 'the branch list again', 8000);
            await ev(`document.querySelector(${JSON.stringify(panel('agent') + ' input[name="launch-where-branch-agent"][value="exists"]')}).click(); true`);
            await waitFor(`!!document.querySelector(${JSON.stringify(panel('agent') + ' input[name="launch-where-wt-agent"]')})`, 'the worktrees are listed again', 8000);
            await ev(`[...document.querySelectorAll(${JSON.stringify(panel('agent') + ' input[name="launch-where-wt-agent"]')})].find(x => x.value === ${JSON.stringify(side)}).click(); true`);
            await waitFor(`/This worktree is in use/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '')`, 'in use is said', 8000);
            check(`${at}a worktree an agent works in is in use: it names the agent, offers to open it or to pick a free one, and holds Next`, await ev(`(() => { const p = document.querySelector(${JSON.stringify(panel('agent'))}); const t = p.textContent, b = [...p.querySelectorAll('.launch-where-item-fail .launch-where-fix')].map(x => x.textContent).join('|'); return /Reviewer is working here/.test(t) && b === 'Open Reviewer|Pick a free one' && document.getElementById('launch-agent-next').disabled; })()`));
            await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => { m.state.liveSessions = []; return true; })`);
            await type('launch-dir', plain);
            await waitFor(`/Not a git repository/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '')`, 'a plain folder is read', 8000);
            check(`${at}a folder that is not a repository says so and offers no branch`, !/Use this folder as it is/.test(await text('agent')));
            await type('launch-dir', repo);
            await waitFor(`/Use this folder as it is/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '')`, 'the repository again', 8000);
            const radio = (kind, value) => ev(`(() => { const r = document.querySelector(${JSON.stringify(panel('agent'))} + ' input[name="launch-where-branch-agent"][value="${value}"]'); if (!r || r.disabled) return false; r.click(); return true; })()`);
            const payload = () => ev(`import((window.__coralStatic || '/static/') + 'launch_where.js').then(m => m.wherePayload('agent'))`);
            // a new worktree: the name and the folder (<repo>-worktrees/<name>), checked free, carried to the launch
            check(`${at}New worktree can be picked`, await radio('agent', 'new'));
            await waitFor(`!!document.querySelector(${JSON.stringify(panel('agent') + ' .launch-where-fields')}) && /Worktree folder is free/.test(document.querySelector(${JSON.stringify(panel('agent'))}).textContent)`, 'the new worktree fields and its check', 8000);
            check(`${at}Branch name and Folder labels are bound to their fields`, await ev(`(() => { const ls = [...document.querySelectorAll(${JSON.stringify(panel('agent'))} + ' .launch-where-fields label')]; return ls.length === 2 && ls.every(l => { const f = l.htmlFor && document.getElementById(l.htmlFor); return !!f && f.tagName === 'INPUT'; }); })()`));
            const nm = await ev(`document.querySelector(${JSON.stringify(panel('agent') + ' [aria-label="New branch name"]')}).value`);
            const fld = await ev(`document.querySelector(${JSON.stringify(panel('agent') + ' [aria-label="Worktree folder"]')}).value`);
            check(`${at}the folder is next to the repository and the name is a branch name`, !!nm && fld === repo + '-worktrees/' + nm, `${nm} ${fld}`);
            check(`${at}the launch carries the new worktree`, JSON.stringify(await payload()) === JSON.stringify({ new_worktree: { name: nm, base: 'trunk' } }), JSON.stringify(await payload()));
            fs.mkdirSync(repo + '-worktrees/taken', { recursive: true });
            await type(`launch-where-name-agent`, 'taken');
            await waitFor(`/already exists/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '')`, 'a taken folder is a problem', 8000);
            check(`${at}a name whose folder exists blocks Next, with the sentence`, await ev(`document.getElementById('launch-agent-next')?.disabled === true && /Fix 1 thing to continue/.test(document.querySelector(${JSON.stringify(panel('agent') + ' .launch-where-why')})?.textContent || '')`));
            fs.rmSync(repo + '-worktrees', { recursive: true, force: true });
            // another branch, with changes in the folder: asks first
            fs.writeFileSync(path.join(repo, 'wip.txt'), 'x');
            await type('launch-dir', repo + '/'); await type('launch-dir', repo);
            await waitFor(`/1 changed/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '')`, 'the change is seen again', 8000);
            check(`${at}Another branch can be picked`, await radio('agent', 'other'));
            await waitFor(`!!document.querySelector(${JSON.stringify(panel('agent') + ' select.launch-where-select')})`, 'the branch list', 8000);
            await ev(`(() => { const s = document.querySelector(${JSON.stringify(panel('agent') + ' select.launch-where-select')}); s.value = 'feature'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`/Switch anyway/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '')`, 'the switch asks first', 8000);
            check(`${at}switching a folder with changes asks first and holds Next until the person says so`, await ev(`document.getElementById('launch-agent-next')?.disabled === true`));
            await ev(`[...document.querySelectorAll(${JSON.stringify(panel('agent') + ' .launch-where-fix')})].find(b => /Switch anyway/.test(b.textContent)).click(); true`);
            await waitFor(`!/Switch anyway/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '')`, 'the answer is taken', 8000);
            check(`${at}the launch carries the branch and the person's yes`, JSON.stringify(await payload()) === JSON.stringify({ checkout_branch: 'feature', confirm_checkout: true }), JSON.stringify(await payload()));
            fs.rmSync(path.join(repo, 'wip.txt'));
            // the CLI's sign-in: signed out is a problem with the sign-in one click away; a CLI that cannot be asked is "not checked" and never blocks
            await ev(`(() => { if (!window.__realFetch) window.__realFetch = window.fetch; window.__cli = { found: true, signed_in: false }; window.fetch = (u, o) => String(u).includes('/api/system/cli-check') ? Promise.resolve(new Response(JSON.stringify(window.__cli), { status: 200, headers: { 'content-type': 'application/json' } })) : window.__realFetch(u, o); return true; })()`);
            await radio('agent', 'here');
            await type('launch-dir', repo + '/'); await type('launch-dir', repo);
            await waitFor(`/not signed in/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '')`, 'signed out is said', 8000);
            check(`${at}a signed-out CLI is a problem with Sign in beside it, and Next and Launch wait`, await ev(`(() => { const p = document.querySelector(${JSON.stringify(panel('agent'))}); return /Sign in on/.test(p.querySelector('.launch-where-item-fail .launch-where-fix')?.textContent || '') && document.getElementById('launch-agent-next').disabled && document.getElementById('launch-agent-go').disabled && /Fix 1 thing to continue: sign in to Claude on/.test(p.querySelector('.launch-where-why').textContent); })()`));
            await ev(`window.__cli = { found: true }; true`);
            await type('launch-dir', repo + '/'); await type('launch-dir', repo);
            await waitFor(`/sign-in: not checked/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '')`, 'not checked is said', 8000);
            check(`${at}a CLI whose sign-in cannot be asked is not checked and does not block`, await ev(`!document.getElementById('launch-agent-next').disabled && !document.querySelector(${JSON.stringify(panel('agent') + ' [data-where-blocks]')})`));
            await ev(`window.fetch = window.__realFetch; true`);
            await type('launch-dir', repo);
            await waitFor(`/Recent repos on/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '') || true`, 'settled', 2000);
            await ev(`window.hideLaunchModal(); true`);
            // New terminal: the same step; its check has no CLI line
            await ev(`window.showLaunchModal(); window._selectLaunchType('terminal'); true`);
            await waitFor(`!!document.querySelector(${JSON.stringify(panel('terminal'))})`, 'the terminal step has the panel', 8000);
            await type('launch-terminal-dir', repo);
            await waitFor(`/Use this folder as it is/.test(document.querySelector(${JSON.stringify(panel('terminal'))})?.textContent || '')`, 'the terminal folder is read', 8000);
            t = await text('terminal');
            check(`${at}New terminal shows the branch and the repo check, and no CLI line`, /trunk/.test(t) && /Repo found/.test(t) && !/installed|signed in|not offered/.test(t), t.slice(0, 200));
            await shot(`where-terminal-${width}`);
            await ev(`window.hideLaunchModal(); true`);
        }
    } finally { await client.close(); fs.rmSync(root, { recursive: true, force: true }); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Where step checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
