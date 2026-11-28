// #596 (the Operator, a fresh Windows install with only Codex): New agent's step 1 said "Claude is not installed on This computer. Fix 1 thing to continue" and kept Next off, because its
// setup check read the agent type from #launch-type, an element gone since the launch form became the agent config form, and so always asked about Claude.
// Now step 1 checks the type the form starts on, and follows it: the default_agent_type setting; else the newest agent's type on that computer; else the first installed agent; else Claude,
// which, when it is missing, names the way out (an agent this computer has, Settings > Providers). A pick on step 3 is what step 1 checks when the person goes back.
// With none of Claude, Codex or Antigravity ready, New agent opens "Get an agent ready" first (#18752) and hides the launch dialog; Not now goes on to the form, where step 1 is checked.
// The CLI checks are answered in the page (helpers/new_agent.js stubCliChecks): which agents are "installed" is the scenario's; nothing is written to the server's settings, nothing launches.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, waitStable } = require('./helpers/wait');
const { stubCliChecks } = require('./helpers/new_agent');

const ALL = ['claude', 'codex', 'agy', 'pi', 'opencode', 'hermes'];
const only = (...have) => ALL.filter(t => !have.includes(t)); // stubCliChecks takes the missing ones

(async () => {
    const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'na596-')));
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const CHECK = '#launch-step-agent .launch-where-check';
    const STATIC = `(window.__coralStatic || '/static/')`;
    // What step 1 shows: the check's lines, its sentence, its fix buttons, whether Next is off; and the type the form (step 3) holds.
    const STEP1 = `(() => { const c = document.querySelector('${CHECK}'), n = document.getElementById('launch-agent-next');
        const m = document.getElementById('launch-modal');
        return { shown: !!m && getComputedStyle(m).display !== 'none' && !document.getElementById('setup-agent-modal'), lines: c ? [...c.querySelectorAll('.launch-where-item-title')].map(e => e.textContent.trim()) : [], why: c?.querySelector('.launch-where-why')?.hidden === false ? c.querySelector('.launch-where-why').textContent : '',
            fixes: c ? [...c.querySelectorAll('.launch-where-fix')].map(b => b.textContent.trim()) : [], nextOff: !!n && (n.disabled || n.getAttribute('aria-disabled') === 'true'),
            type: document.querySelector('#launch-agent-acf .acf-agent-type')?.value || '' }; })()`;
    const step1 = () => ev(STEP1);
    const cliLine = s => s.lines.find(l => /installed|sign-in|not offered/.test(l)) || '';
    // A fresh page with these agents installed, then the scenario's own state (a setting, live agents), then New agent with a folder typed.
    // With nothing installed the set-up dialog comes first: `setupFirst` waits for it and presses Not now, as the person would.
    const open = async (have, setup = '', { setupFirst = false } = {}) => {
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await stubCliChecks(ev, only(...have));
        if (setup) await ev(`(async () => { const state = (await import(${STATIC} + 'state.js')).state; ${setup}; return true; })()`);
        await ev(`(() => { window.showLaunchModal(); window._selectLaunchType('agent'); return true; })()`);
        if (setupFirst) {
            await waitFor(`!!document.getElementById('setup-agent-modal')`, 'the set-up dialog (nothing installed)', 8000);
            await ev(`[...document.querySelectorAll('#setup-agent-modal button')].find(b => b.textContent.trim() === 'Not now').click(), true`);
            await waitFor(`!document.getElementById('setup-agent-modal')`, 'the set-up dialog to close', 8000);
        }
        await waitFor(`!!document.getElementById('launch-dir') && document.getElementById('launch-dir').getClientRects().length > 0`, 'the folder step', 8000);
        await ev(`(() => { const i = document.getElementById('launch-dir'); i.value = ${JSON.stringify(work)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await waitFor(`!!document.querySelector('${CHECK}') && !!document.querySelector('#launch-agent-pick')?.dataset.probed`, 'the setup check and the provider answers', 10000);
    };
    // The check once it names `name`'s CLI and has stopped changing (the provider cards may move the type a moment after the dialog opens, and the check follows them).
    // A check that never gets there is read as it is, so the failing line shows what it said.
    const settled = name => waitStable(ev, STEP1, `the check for ${name}`, 300, { timeout: 10000, accept: s => s.shown && s.lines.some(l => l.startsWith(name)) }).catch(() => step1());
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

        // the Operator's case: only Codex, no setting, no agent yet: the form starts on the first installed agent, and step 1 checks it
        let s; await open(['codex']); s = await settled('Codex');
        check('only Codex installed, nothing set: step 1 checks Codex, not Claude', s.shown && /^Codex /.test(cliLine(s)) && !s.lines.some(l => /Claude/.test(l)), JSON.stringify(s));
        check('only Codex installed: Next is on and the form is on Codex', !s.nextOff && s.type === 'codex', JSON.stringify(s));

        // rung 1: the setting comes first, over the newest agent
        await open(['claude', 'codex', 'opencode'], `state.settings = { ...(state.settings || {}), default_agent_type: 'opencode' }; state.liveSessions = [{ name: 'a', session_id: 's1', agent_type: 'codex', created_at: new Date().toISOString() }]`); s = await settled('Opencode');
        check('the default_agent_type setting: step 1 checks that agent', /^Opencode /.test(cliLine(s)) && s.type === 'opencode', JSON.stringify(s));

        // rung 2: no setting: the newest agent's type on this computer, even with Claude installed
        await open(['claude', 'codex'], `state.liveSessions = [{ name: 'old', session_id: 's1', agent_type: 'claude', created_at: '2026-01-01T00:00:00Z' }, { name: 'new', session_id: 's2', agent_type: 'codex', created_at: '2026-02-01T00:00:00Z' }]`); s = await settled('Codex');
        check('no setting: step 1 checks the newest agent\'s type (Codex over an older Claude)', /^Codex /.test(cliLine(s)) && s.type === 'codex' && !s.nextOff, JSON.stringify(s));

        // rung 4: nothing installed: the set-up dialog first (#18752); after Not now, Claude, blocked, and the way out is Settings > Providers
        await open([], '', { setupFirst: true }); s = await settled('Claude');
        check('nothing installed: after Not now in the set-up dialog, step 1 says Claude is missing and keeps Next off', s.shown && /^Claude is not installed/.test(cliLine(s)) && s.nextOff, JSON.stringify(s));
        check('nothing installed: the way out is Settings > Providers, said in the sentence too', JSON.stringify(s.fixes) === '["Settings > Providers"]' && /install Claude on .+, or set its path in Settings > Providers/.test(s.why), JSON.stringify(s));

        // the setting names a missing CLI and another is installed: "Use Codex" is offered, and pressing it moves the form and the check
        await open(['codex'], `state.settings = { ...(state.settings || {}), default_agent_type: 'claude' }`); s = await settled('Claude');
        check('the default is missing: step 1 offers the installed agent and Settings > Providers', /^Claude is not installed/.test(cliLine(s)) && JSON.stringify(s.fixes) === '["Use Codex","Settings > Providers"]' && /use Codex, which .+ has, or install Claude/.test(s.why) && s.nextOff, JSON.stringify(s));
        await ev(`[...document.querySelectorAll('${CHECK} .launch-where-fix')].find(b => b.textContent.trim() === 'Use Codex').click(), true`);
        s = await settled('Codex');
        check('Use Codex: the form is on Codex, step 1 checks Codex, Next is on', s.type === 'codex' && /^Codex /.test(cliLine(s)) && !s.nextOff, JSON.stringify(s));

        // a pick on step 3 is what step 1 checks when the person goes back
        await open(['claude', 'codex']); s = await settled('Claude');
        check('Claude and Codex installed, nothing set: Claude, as before', /^Claude /.test(cliLine(s)) && s.type === 'claude', JSON.stringify(s));
        await ev(`window._launchStage('agent'), true`);
        await waitFor(`!!document.querySelector('#launch-agent-pick input[value="codex"]')`, 'the provider choice on step 3', 8000);
        await ev(`document.querySelector('#launch-agent-pick input[value="codex"]').click(), true`);
        await ev(`window._launchStage('folder'), true`);
        s = await settled('Codex');
        check('Codex picked on step 3, then Back: step 1 checks Codex', /^Codex /.test(cliLine(s)) && s.type === 'codex' && !s.lines.some(l => /^Claude/.test(l)), JSON.stringify(s));
        await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`);
    } finally { await client.close(); fs.rmSync(work, { recursive: true, force: true }); }
    const failed = results.filter(r => !r).length;
    console.log(failed ? `FAIL ${failed} of ${results.length}` : `PASS all ${results.length}`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
