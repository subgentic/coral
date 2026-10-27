// The data_table census's scanner (helpers/data_table_scan.mjs) against fixtures (#7905): the census can only say "zero means zero" if the scanner sees every spelling of a table, and does not count what is not one.
//   CSS: a table part (table, thead, tbody, tfoot, tr, td, th) and a whole table class count; a class that only begins like one (`.goals-table-page`, `.group-table-link`) does not; the component's own dt-* is
//        reported apart; a comment and an at-rule prelude are not rules; an exempt selector is counted apart.
//   JS:  <table>, <tr>, <td>, <th>, createElement('td'), el('th') and h('table'), the builder of cloud_servers.js, count; other tags do not.
//   The exemptions each carry a reason, and name a file that exists.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cssRules, cssCount, jsCount, EXEMPT, EXEMPT_SELECTORS } from './helpers/data_table_scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(HERE, '..', '..', 'coral-go', 'pkg', 'frontend', 'static');
const css = (src, exempt) => cssCount(src, exempt);

// CSS: what counts
assert.equal(css('.group-table th { color: red; }').n, 1, 'a header selector');
assert.equal(css('.x table, .y td { margin: 0; }').n, 1, 'two parts in one rule are one rule');
assert.equal(css('tr:hover td { x: y; }').n, 1);
for (const cls of ['team-table', 'group-table', 'group-table-stack', 'group-table-aligned', 'servers-table', 'cost-table', 'sched-runs-table', 'wf-runs-table', 'wf-steps-table', 'cs-table']) assert.equal(css(`.${cls} { width: 100%; }`).n, 1, `a whole table class: .${cls}`);
// CSS: what does not
assert.equal(css('.goals-table-page { padding: 0; }').n, 0, 'the Goals page layout class is not a table');
assert.equal(css('.goals-table-page .goals-back { min-height: 44px; }').n, 0, 'nor is a rule under it');
assert.equal(css('.group-table-link { color: red; } .group-table-head { gap: 4px; } .group-table-back { margin: 0; }').n, 0, 'a button or a header of a group page is not a table');
assert.equal(css('.wf-table-note { x: y; } .tablet { x: y; } .data-table-like { x: y; }').n, 0, 'a name that only contains a table word is not one');
assert.equal(css('/* .group-table th { x: y; } */ .plain { x: y; }').n, 0, 'a comment is not a rule');
assert.equal(css('@media (max-width: 700px) { .plain { x: y; } }').n, 0, 'an at-rule prelude is not a selector');
assert.equal(css('@media (max-width: 700px) { .group-table td { x: y; } }').n, 1, 'a rule inside an at-rule counts');
assert.deepEqual(cssRules('/* c */ a { x: y; } @media print { b, c { x: y; } }'), ['a', 'b, c'], 'cssRules: the selectors, the at-rule prelude left out');
// CSS: the component's own class, and exempt selectors
assert.deepEqual(css('.dt-table td { x: y; }'), { n: 0, own: ['.dt-table td'], exempted: 0 }, 'the dt-* class outside data_table.css is reported, not counted');
assert.deepEqual(css('.some-table td { x: y; } .group-table th { x: y; }', [/\.some-table/]).n, 1, 'an exempt selector is not counted');
assert.equal(css('.some-table td { x: y; } .group-table th { x: y; }', [/\.some-table/]).exempted, 1, 'but it is counted apart, so a stale exemption is seen');

// JS: what counts
assert.equal(jsCount('const t = document.createElement("table"); const r = document.createElement(\'tr\');'), 2, 'createElement');
assert.equal(jsCount('`<table class="x"><tr><td>a</td><th>b</th></tr></table>`'), 4, 'a template string: table, tr, td, th (the closing tags are not matches)');
assert.equal(jsCount("el('td', 'x', 'y'); el(\"th\"); el('table')"), 3, 'el()');
assert.equal(jsCount("h('table', null, h('tr', null, h('td', null, 'a'), h(\"th\", null, 'b')))"), 4, 'the h() builder of cloud_servers.js: the blind spot');
// JS: what does not
assert.equal(jsCount("el('div'); h('span'); h('tbody'); document.createElement('section'); `<thead></thead><tabletop>`"), 0, 'other tags, and a name that begins like a table, are not tables');
assert.equal(jsCount('const th = 1; const tr = th + 1; // a variable called h or th is not a call'), 0, 'a variable is not a builder');

// The former legacy builders now supply or host shared dataTable nodes.
const groups = fs.readFileSync(path.join(STATIC, 'sidebar_groups.js'), 'utf8');
assert.equal(jsCount(groups), 0, 'sidebar_groups.js only hosts shared table nodes');
const cloud = fs.readFileSync(path.join(STATIC, 'cloud_server_view.js'), 'utf8');
assert.equal(jsCount(cloud), 0, 'cloud_server_view.js builds no table of its own');
// the exemptions: a reason, and a file that exists and matches
for (const [kind, dir] of [['css', path.join(STATIC, 'css')], ['js', STATIC]]) for (const [f, why] of Object.entries(EXEMPT[kind])) {
    assert.ok(why && why.length >= 20, `${kind}/${f}: an exemption needs its reason`);
    assert.ok(fs.existsSync(path.join(dir, f)), `${kind}/${f}: the exempt file exists`);
}
assert.ok(EXEMPT_SELECTORS.every(re => re instanceof RegExp));
// the shared content style is the one place a Markdown table is styled: no other stylesheet has a rule for one of the content containers' tables
const owners = ['.subagent-detail-md', '.chat-bubble .message-text', '.md', '.docs-content', '.preview-pane-markdown'];
for (const f of fs.readdirSync(path.join(STATIC, 'css')).filter(n => n.endsWith('.css') && n !== 'content_table.css')) {
    for (const sel of cssRules(fs.readFileSync(path.join(STATIC, 'css', f), 'utf8'))) {
        for (const o of owners) assert.ok(!new RegExp(`${o.replace(/[.]/g, '\\.')}\\s+(table|th|td|thead|tbody|tr)\\b|${o.replace(/[.]/g, '\\.')}\\s*>\\s*(table|th|td)\\b`).test(sel), `css/${f}: a Markdown table is styled outside css/content_table.css: ${sel.slice(0, 80)}`);
    }
}
console.log('data_table_scan: ok');
