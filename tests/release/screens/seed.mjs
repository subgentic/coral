// Seeds the isolated server with what a working Coral shows, through its HTTP API and the real coral-board / coral-agent programs as a mock agent: no real agent CLI, no model, no tokens.
//   node seed.mjs --base URL --link SIGN_IN_LINK --bin DIR --env-dump DIR --work DIR --home DIR --data DIR --out seed.json
// Two teams with agents in each state (working, waiting, idle, asleep), a goal with tasks and artifacts, board messages, a workflow and a run, a scheduled job, an HTML artifact, a saved
// message, chats with long messages. Everything it writes is made up here (no real data), so no screenshot holds a token, a path of the person's or a name that is not in this file.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { signIn, client } from './api.mjs';

const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const base = arg('base'), link = arg('link'), bin = arg('bin'), envDump = arg('env-dump'), work = arg('work'), home = arg('home'), data = arg('data'), out = arg('out');
if (!base || !link || !bin || !envDump || !work || !home || !data || !out) { console.error('usage: seed.mjs --base --link --bin --env-dump --work --home --data --out'); process.exit(2); }
const log = (...a) => console.error('[seed]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const cookie = await signIn(base, link);
const api = client(base, cookie);

export const LONG = 'The checkout page now keeps the cart total in view while the address form scrolls, and the payment step no longer reloads the whole page when the card number is wrong. ' +
    'I also moved the promo code field above the order summary because testers kept missing it, and the summary itself now says which items are shipping separately. ' +
    'Next I will check the narrow layout: at 390 pixels the sticky total covers the pay button unless the footer keeps its own space, so that is the first thing to look at.';

// ── the teams ───────────────────────────────────────────────────────────────────────────────────
await api('PUT', '/api/settings', { cli_path_claude: path.join(bin, 'mock-agent') });
async function team(name, roles) {
    const res = await api('POST', '/api/sessions/launch-team', { board_name: name, working_dir: work, agent_type: 'claude', backend: process.env.SCREENS_BACKEND || 'tmux',
        agents: roles.map(r => ({ name: r, prompt: 'Release screenshot fixture: a made-up team.' })) });
    for (const a of res.agents) if (a.error) throw new Error('launch failed: ' + JSON.stringify(a));
    return res;
}
const t1 = await team('checkout-redesign', ['Orchestrator', 'Frontend Dev', 'Backend Dev', 'QA']);
const t2 = await team('docs-refresh', ['Writer', 'Editor']);
const byName = Object.fromEntries([...t1.agents, ...t2.agents].map(a => [a.name, a]));
log('launched', Object.keys(byName).join(', '));

// Each mock agent writes its env (with its session token) when it is up; the CLI calls below run as that agent.
async function envOf(a) {
    const file = path.join(envDump, a.session_id + '.env');
    for (let i = 0; i < 150; i++) { if (fs.existsSync(file)) break; await sleep(200); }
    if (!fs.existsSync(file)) throw new Error('mock agent did not become ready: ' + a.name);
    const v = Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    if (!v.CORAL_SESSION_TOKEN) throw new Error('mock agent has no token: ' + a.name);
    // Only what the program needs: nothing of the caller's own Coral (its session, token, port or data folder) reaches the isolated server's tools.
    return { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CORAL_DATA_DIR: data, CORAL_URL: base, CORAL_TELEMETRY_DISABLED: '1', CORAL_SESSION_NAME: a.session_name, CORAL_SUBSCRIBER_ID: a.name, CORAL_SESSION_TOKEN: v.CORAL_SESSION_TOKEN };
}
for (const a of Object.values(byName)) a.env = await envOf(a);
function run(program, who, ...args) {
    const r = spawnSync(path.join(bin, program), args.map(String), { env: byName[who].env, encoding: 'utf8', timeout: 30000, cwd: work });
    if (r.status !== 0) throw new Error(`${program} ${args.join(' ').slice(0, 80)} as ${who}: ${r.stderr || r.stdout}`);
    return r.stdout;
}
const board = (who, ...args) => run('coral-board', who, ...args);
const id = (text, kind) => { const m = text.match(new RegExp('Created ' + kind + ' #(\\d+)')); if (!m) throw new Error('no ' + kind + ' id in: ' + text); return Number(m[1]); };

// ── goal, tasks, board ───────────────────────────────────────────────────────────────────────────
const goal = id(board('Orchestrator', 'goal', 'add', 'Ship the new checkout', '--outcome', 'Customers pay in three steps on any screen', '--done-when', 'The phone checkout passes QA and the old page is removed'), 'Goal');
const tasks = {};
tasks.cart = id(board('Orchestrator', 'task', 'add', 'Sticky cart total', '--goal', goal, '--assignee', 'Frontend Dev', '--priority', 'high', '--body', 'Keep the total in view while the address form scrolls.'), 'Task');
tasks.api = id(board('Orchestrator', 'task', 'add', 'Validate the card number server side', '--goal', goal, '--assignee', 'Backend Dev', '--body', 'Return a field error, not a reload.'), 'Task');
tasks.phone = id(board('Orchestrator', 'task', 'add', 'Phone layout pass', '--goal', goal, '--assignee', 'QA', '--blocked-by', JSON.stringify([tasks.cart])), 'Task');
tasks.docs = id(board('Orchestrator', 'task', 'add', 'Write the checkout help page', '--assignee', 'Writer', '--priority', 'low'), 'Task');
board('Frontend Dev', 'task', 'claim', tasks.cart);
board('Backend Dev', 'task', 'claim', tasks.api);
board('Backend Dev', 'task', 'complete', tasks.api, '--message', 'Card numbers are checked on the server; the form shows the field error.');
board('Orchestrator', 'goal', 'add', 'Cut the dashboard load time', '--outcome', 'First paint under a second on the office network');

board('Orchestrator', 'post', '@Frontend Dev the sticky total is yours. Phone first, please.');
board('Frontend Dev', 'post', '--broadcast', LONG); // a seed post to the whole team: coral-board refuses a post that notifies nobody
board('Backend Dev', 'post', 'The card check is done and merged. Numbers: `4242 4242 4242 4242` passes, anything else returns `card_invalid` with the field name. @QA it is ready to test.');
board('QA', 'post', '--broadcast', '1. Pay button is covered at 390 px.\n2. Promo field is easy to miss.\n3. Everything else passes.');
board('Writer', 'post', '@Editor the help page draft is up for a read.');

// ── artifacts: an HTML page, a report ───────────────────────────────────────────────────────────
const art = path.join(work, 'artifacts'); fs.mkdirSync(art, { recursive: true });
fs.writeFileSync(path.join(art, 'checkout-mockup.html'), `<!doctype html><title>Checkout mockup</title><style>body{font:16px system-ui;margin:2rem;max-width:34rem}.row{display:flex;justify-content:space-between;padding:.5rem 0;border-bottom:1px solid #ccc}button{margin-top:1rem;padding:.6rem 1.2rem}</style><h1>Checkout</h1><div class="row"><span>Linen shirt</span><span>$48.00</span></div><div class="row"><span>Shipping</span><span>$6.00</span></div><div class="row"><b>Total</b><b>$54.00</b></div><button>Pay $54.00</button>`);
fs.writeFileSync(path.join(art, 'qa-report.md'), '# Phone pass\n\n| Page | Result |\n|---|---|\n| Cart | pass |\n| Address | pass |\n| Payment | **pay button covered** |\n\nSee the mockup for the intended layout.\n');
const upload = (who, file, ...more) => run('coral-agent', who, 'artifact', 'upload', path.join(art, file), ...more);
upload('Frontend Dev', 'checkout-mockup.html', '--no-task', '--tag', 'for review');
upload('QA', 'qa-report.md', '--no-task');
// a CSV: the viewer's table (sticky header, sortable columns, a filter box, a long cell with its Show all), made up
fs.writeFileSync(path.join(art, 'phone-pass.csv'), ['Page,Width,Result,Notes', 'Cart,390,pass,', 'Address,390,pass,', 'Payment,390,fail,' + JSON.stringify('The pay button sits under the floating bar until the page is scrolled to its end; the Orchestrator asked for the bar to clear the last row of every page and for the spacing under the button to match the desktop layout.'), 'Confirmation,390,pass,', 'Cart,1440,pass,', 'Payment,1440,pass,'].join('\n') + '\n');
upload('QA', 'phone-pass.csv', '--no-task');

// ── agent states (typed lines the mock answers; the screens read the agent's real state) ─────────
const send = (a, command) => api('POST', '/api/sessions/live/' + encodeURIComponent(a.session_name) + '/send', { command, agent_type: 'claude', session_id: a.session_id });
await send(byName['Frontend Dev'], 'MOCK_BUSY 3600');                         // working
await send(byName['Backend Dev'], 'MOCK_ASK_PERMISSION');                     // waiting for the person
await send(byName.Orchestrator, 'Summarise where the checkout stands.');       // a chat with a reply, then idle
await send(byName.Writer, 'Draft a short help page for the new checkout. ' + LONG);
await sleep(1500);
await api('POST', '/api/sessions/live/' + byName.Editor.session_id + '/sleep', {});  // asleep

// ── automations: a workflow and a run, a scheduled job ───────────────────────────────────────────
const wf = await api('POST', '/api/workflows', { name: 'nightly-build', description: 'Builds and tests every night', enabled: 1,
    steps: [{ name: 'Install', type: 'shell', command: 'echo added 214 packages' }, { name: 'Test', type: 'shell', command: 'echo 412 tests passed' }] });
const wfId = wf.id ?? wf.workflow?.id;
let runId = null;
if (wfId) {
    const r = await api('POST', `/api/workflows/${wfId}/trigger`, {}, [200, 201, 202]);
    runId = r.run_id ?? r.id ?? r.run?.id ?? null;
}
const job = await api('POST', '/api/scheduled/jobs', { name: 'Weekly dependency check', cron_expr: '0 9 * * 1', enabled: 1, agent_type: 'claude', prompt: 'List outdated dependencies.', repo_path: work, no_worktree: 1 }, [200, 201]);

// ── the Inbox: a saved message (the Frontend Dev's long board post) ──────────────────────────────
try {
    const lines = board('Orchestrator', 'read', '--last', '5', '--json').split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
    const msg = lines.find(m => String(m.content || '').startsWith('The checkout page now keeps')) || lines[0];
    await api('POST', '/api/saved', { kind: 'board', ref: t1.board, key: String(msg.id), agent_type: 'claude', title: 'Frontend Dev on the sticky total', snippet: LONG.slice(0, 200), said_at: msg.timestamp || new Date().toISOString(), team: 'checkout-redesign', author: 'Frontend Dev' });
} catch (e) { log('saved message skipped:', String(e.message).slice(0, 160)); }

// ── a chat in the History list: the Writer's, with its long first message, once the indexer has it ──
let chat = byName.Writer.session_id;
for (let i = 0; i < 40; i++) {
    const h = await api('GET', '/api/sessions/history?limit=50');
    if ((h.sessions || []).some(x => x.session_id === chat)) break;
    await sleep(500);
}

const sessions = await api('GET', '/api/sessions/live');
const seed = {
    teams: [{ name: 'checkout-redesign', board: t1.board, id: t1.board_id }, { name: 'docs-refresh', board: t2.board, id: t2.board_id }],
    agents: Object.fromEntries(Object.values(byName).map(a => [a.name, { session_id: a.session_id, session_name: a.session_name }])),
    goal, tasks, workflow: wfId, run: runId, chat, job: job.id ?? job.job?.id ?? null, liveCount: Array.isArray(sessions) ? sessions.length : (sessions.sessions || []).length,
};
fs.writeFileSync(out, JSON.stringify(seed, null, 2));
log('done', JSON.stringify(seed).slice(0, 300));
