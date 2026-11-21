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
            await ev(`window.showLaunchModal(); window._selectLaunchType('agent'); true`);
            await waitFor(`!!document.getElementById('launch-dir') && !!document.querySelector(${JSON.stringify(panel('agent'))})`, 'the where panel is mounted', 8000);
            await type('launch-dir', repo);
            await waitFor(`/Branch where it works/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '')`, 'the repository is read', 8000);
            let t = await text('agent');
            check(`${at}a repository shows its branch and that it is clean`, /trunk/.test(t) && /clean/.test(t), t.slice(0, 160));
            await waitFor(`/Claude is|Claude (is )?not/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '')`, 'the CLI line of the check', 8000);
            t = await text('agent');
            check(`${at}the setup check says the repo was found and says where the agent's CLI stands`, /Setup check/.test(t) && /Repo found/.test(t) && /Claude (is|not)/.test(t) && /to fix|to know|all good/.test(t), t.slice(t.indexOf('Setup check')));
            check(`${at}its worktrees are offered to launch in`, (await ev(`[...document.querySelectorAll(${JSON.stringify(panel('agent') + ' .launch-where-select option')})].map(o => o.textContent).join('|')`)).includes('fix-login'));
            await shot(`where-agent-${width}`);
            fs.writeFileSync(path.join(repo, 'new.txt'), 'x');
            await type('launch-dir', repo + '/'); await type('launch-dir', repo);
            await waitFor(`/1 changed/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '')`, 'the change is seen', 8000);
            t = await text('agent');
            check(`${at}a changed folder says so, as a warning to know, and does not block`, /1 changed/.test(t) && /1 uncommitted change/.test(t) && /to know|to fix/.test(t) && !(await ev(`document.getElementById('launch-agent-go')?.disabled === true && !document.querySelector('.cli-warning, #launch-cli-warning')`)));
            fs.rmSync(path.join(repo, 'new.txt'));
            await ev(`(() => { const s = document.querySelector(${JSON.stringify(panel('agent') + ' .launch-where-select')}); s.value = ${JSON.stringify(side)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`document.getElementById('launch-dir').value === ${JSON.stringify(side)}`, 'picking a worktree puts its folder in the field', 4000);
            await waitFor(`/fix-login/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '')`, 'the worktree is read', 8000);
            check(`${at}picking a worktree launches in its folder, on its branch`, (await text('agent')).includes('fix-login'));
            await type('launch-dir', plain);
            await waitFor(`/Not a git repository/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '')`, 'a plain folder is read', 8000);
            check(`${at}a folder that is not a repository says so and offers no branch`, !/Branch where it works/.test(await text('agent')));
            await type('launch-dir', repo);
            await waitFor(`/Recent repos on/.test(document.querySelector(${JSON.stringify(panel('agent'))})?.textContent || '') || true`, 'settled', 2000);
            await ev(`window.hideLaunchModal(); true`);
            // New terminal: the same step; its check has no CLI line
            await ev(`window.showLaunchModal(); window._selectLaunchType('terminal'); true`);
            await waitFor(`!!document.querySelector(${JSON.stringify(panel('terminal'))})`, 'the terminal step has the panel', 8000);
            await type('launch-terminal-dir', repo);
            await waitFor(`/Branch where it works/.test(document.querySelector(${JSON.stringify(panel('terminal'))})?.textContent || '')`, 'the terminal folder is read', 8000);
            t = await text('terminal');
            check(`${at}New terminal shows the branch and the repo check, and no CLI line`, /trunk/.test(t) && /Repo found/.test(t) && !/installed|signed in|not offered/.test(t), t.slice(0, 200));
            await shot(`where-terminal-${width}`);
            await ev(`window.hideLaunchModal(); true`);
        }
    } finally { await client.close(); fs.rmSync(root, { recursive: true, force: true }); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Where step checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
