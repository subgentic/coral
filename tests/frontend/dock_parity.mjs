// The parity census for the right dock's removal (#7456; the operator: "every feature must move over"; UI/UX's one-team-page doc, section 10).
//
//   node dock_parity.mjs --generate   rebuild the rows of fixtures/dock_parity.json from the dock's own code (the data-on-* actions, event listeners, stored settings and
//                                     control names of every module a dock tab is made of) and from the running-page controls of fixtures/dock_controls_baseline.json (made by
//                                     DOCK_INVENTORY_OUT=<file> node run_cdp_suites.mjs --only dock_inventory); a row that was already answered keeps its answer
//   node dock_parity.mjs              the census: exits 1 while any row is unanswered, or answered without its proof
//
// A row is one control or behaviour of one dock tab. Its answer is one of
//   "status": "moved"      with "newHome" (a tab of the team page, a tab of the agent page, the detail pane or the Saved bookmark) and "proof": { "file": <path under coral-go/pkg/frontend or tests/frontend>,
//                          "needle": <text that file must contain: the action name or the control's name in the new templates, or the test that covers the behaviour> }
//   "status": "removed-ok" with "okRef" (the operator's OK for removing it: a board message id or a coral:// artifact) and "why"
//   "status": "stays"      with "okRef" and "why": it belongs to the agent view's dock, which the operator keeps (board 11:26Z: the dock removal is only for the team view; the agent's own view keeps Files, Browse, diff, Notes, Activity, Agent UI and the agent's Artifacts)
// and every row starts as "todo". The dock is removed last, in its own task, only when this exits 0 (item 5 of the design's checklist). It is not part of test:cloud until then, so it may fail without
// holding a build. A dock source that now has an action the rows do not know is reported too (the inventory is out of date).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(HERE, '..', '..', 'coral-go', 'pkg', 'frontend');
const STATIC = path.join(FRONTEND, 'static');
const ROWS = path.join(HERE, 'fixtures', 'dock_parity.json');
const BASELINE = path.join(HERE, 'fixtures', 'dock_controls_baseline.json');

// The modules a dock tab is made of, and where UI/UX's design (team page doc, sections 3 and 4b) sends it.
const TABS = {
    'subscribers': { files: ['message_board.js'], home: 'team page: Agents tab (the rows are the Members list, the Operator included)' },
    'board': { files: ['board_chat.js'], home: 'team page: Messages tab' },
    'files': { files: ['changed_files.js'], home: 'agent page: Files tab' },
    'browse': { files: ['browser.js'], home: 'agent page: Files tab (the folder as a table)' },
    'artifacts': { files: ['artifacts_tab.js', 'artifact_*.js'], home: 'agent page: Artifacts tab; previews in the detail pane' },
    'team-view': { files: ['team_availability.js', 'team_context.js'], home: 'team page: Agents tab (status chips, one row per agent, Remind)' },
    'team-settings': { files: ['team_working_mode.js', 'team_settings_page.js', 'team_health_fields.js', 'team_cross_team_fields.js'], home: 'team page: Settings tab' },
    'team-artifacts': { files: ['team_artifacts.js', 'team_artifact_*.js', 'board_artifacts.js'], home: 'team page: Artifacts tab; previews in the detail pane' },
    'knowledge': { files: ['knowledge_*.js'], home: 'team page: Knowledge tab' },
    'tasks': { files: ['tasks.js', 'task_*.js'], home: "team page: Tasks tab (and a goal's own task table); a task opens its page" },
    'notes': { files: ['notes.js', 'agent_notes.js'], home: 'agent page: Notes tab' },
    'activity': { files: ['activity_*.js', 'event_row.js', 'event_search.js'], home: 'agent page: Activity tab' },
    'agent-ui': { files: ['agent_ui.js'], home: 'agent page: Agent UI tab' },
    'saved': { files: ['saved.js', 'saved_*.js'], home: 'the Saved bookmark: Inbox > Saved' },
    'customize': { files: ['tab_customize.js'], home: "removed by design (the tabs are the page's, fixed in a set order) but needs the operator's OK" },
    'dock chrome': { files: ['agentic_state.js', 'dock_page.js'], extraText: [path.join(FRONTEND, 'templates', 'includes', 'right_dock.html')], home: "removed with the dock: the panel toggle, the tab strip, the width and the last-tab memory (each needs a new home or the operator's OK)" },
};
const glob = (pat) => { const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); return fs.readdirSync(STATIC).filter(f => re.test(f)).sort(); };
const files = (tab) => [...new Set(TABS[tab].files.flatMap(glob))];
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n');

function extract() {
    const rows = [];
    const add = (r) => rows.push({ ...r, status: 'todo' });
    for (const [tab, def] of Object.entries(TABS)) {
        const srcs = [...files(tab).map(f => path.join(STATIC, f)), ...(def.extraText || [])];
        for (const f of srcs) {
            const rel = path.relative(FRONTEND, f);
            lines(f).forEach((l, i) => {
                const at = `${rel}:${i + 1}`;
                for (const m of l.matchAll(/data-on-([a-z]+)="([A-Za-z0-9_:-]+)"/g)) add({ id: `${tab}/action/${m[2]}`, tab, kind: 'action', what: `${m[1]} -> ${m[2]}`, action: m[2], source: at });
                for (const m of l.matchAll(/addEventListener\(\s*['"]([a-z]+)['"]/g)) add({ id: `${tab}/listener/${path.basename(f)}:${i + 1}:${m[1]}`, tab, kind: 'listener', what: `${m[1]} handler: ${l.trim().slice(0, 110)}`, source: at });
                for (const m of l.matchAll(/(?:localStorage|browserLocal|settings)\.(?:getItem|setItem|get|set)\(\s*['"`]([A-Za-z0-9_:.-]+)/g)) add({ id: `${tab}/storage/${m[1]}`, tab, kind: 'storage', what: `remembers ${m[1]}`, source: at });
                for (const m of l.matchAll(/(?:title|aria-label)="([^"$<{][^"]{3,70})"/g)) add({ id: `${tab}/label/${m[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)}`, tab, kind: 'label', what: `names a control: "${m[1]}"`, source: at });
            });
        }
    }
    if (fs.existsSync(BASELINE)) {
        const b = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
        for (const [page, v] of Object.entries(b.pages)) {
            for (const t of v.tabs) add({ id: `${t.tab}/tab/${page}`, tab: t.tab, kind: 'tab', what: `the tab "${t.label}" on the ${page} page, badge/count text "${t.badge.replace(/^[a-z_]+\s*/, '')}"`, source: `running page (${page})` });
            for (const [tab, rows2] of Object.entries(v.controls)) for (const c of rows2) add({ id: `${tab}/control/${page}/${c.role}/${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}/${c.id}`, tab, kind: 'control', what: `${c.role} "${c.name}"${c.actions ? ' (' + c.actions + ')' : ''}${c.disabled ? ' [disabled when empty]' : ''}`, source: `running page (${page})` });
        }
    }
    const seen = new Map();
    for (const r of rows) { let id = r.id, n = 1; while (seen.has(id)) id = r.id + '#' + (++n); r.id = id; seen.set(id, r); r.newHome = TABS[r.tab] ? TABS[r.tab].home : ''; r.proof = null; }
    return rows;
}

const mode = process.argv[2];
if (mode === '--generate') {
    const fresh = extract();
    const old = fs.existsSync(ROWS) ? new Map(JSON.parse(fs.readFileSync(ROWS, 'utf8')).rows.map(r => [r.id, r])) : new Map();
    for (const r of fresh) { const o = old.get(r.id); if (o && o.status !== 'todo') Object.assign(r, { status: o.status, newHome: o.newHome || r.newHome, proof: o.proof, okRef: o.okRef, why: o.why }); }
    const ascii = (t) => t.replace(/[\u0080-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')); // the fixture stays ASCII: names and strings from the page are escaped
    fs.writeFileSync(ROWS, ascii(JSON.stringify({ about: 'The right dock parity census rows (#7456). Answer a row by status moved (with proof), removed-ok (with okRef) or stays (the agent view keeps it, with okRef); see dock_parity.mjs.', rows: fresh }, null, 1)) + '\n');
    const by = {}; for (const r of fresh) by[r.tab] = (by[r.tab] || 0) + 1;
    console.log(`dock_parity: ${fresh.length} rows written`, JSON.stringify(by));
    process.exit(0);
}
const data = JSON.parse(fs.readFileSync(ROWS, 'utf8'));
const problems = [];
const todo = data.rows.filter(r => r.status === 'todo');
const read = (f) => { for (const base of [FRONTEND, HERE, path.join(HERE, '..', '..')]) { const p = path.join(base, f); if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8'); } return null; };
for (const r of data.rows) {
    if (r.status === 'moved') {
        if (!r.newHome || !r.proof || !r.proof.file || !r.proof.needle) problems.push(`${r.id}: moved without a newHome and a proof {file, needle}`);
        else { const t = read(r.proof.file); if (t === null) problems.push(`${r.id}: its proof file ${r.proof.file} is not there`); else if (!t.includes(r.proof.needle)) problems.push(`${r.id}: ${r.proof.file} does not contain "${r.proof.needle}"`); }
    } else if (r.status === 'removed-ok') {
        if (!r.okRef || !r.why) problems.push(`${r.id}: removed-ok without the operator's OK (okRef) and why`);
    } else if (r.status === 'stays') {
        if (!r.okRef || !r.why) problems.push(`${r.id}: stays without the operator's word (okRef) and why`);
    } else if (r.status !== 'todo') problems.push(`${r.id}: unknown status ${r.status}`);
}
// the dock's code today against the rows: a new action nobody listed
const known = new Set(data.rows.filter(r => r.kind === 'action').map(r => `${r.tab}/action/${r.action}`));
if (fs.existsSync(STATIC)) for (const r of extract().filter(x => x.kind === 'action')) if (!known.has(`${r.tab}/action/${r.action}`)) problems.push(`the dock has a new action nobody listed: ${r.tab}/${r.action} (${r.source}); run --generate`);
const byTab = {}; for (const r of todo) byTab[r.tab] = (byTab[r.tab] || 0) + 1;
console.log(`dock_parity: ${data.rows.length} rows, ${data.rows.length - todo.length} answered, ${todo.length} still todo`, JSON.stringify(byTab));
for (const p of problems.slice(0, 40)) console.log('  ' + p);
if (todo.length || problems.length) { console.error(`FAIL: the dock cannot be removed yet (${todo.length} unanswered, ${problems.length} problems)`); process.exit(1); }
console.log("PASS: every row of the dock has a new home with its proof, or the operator's OK to go");
