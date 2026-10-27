// The phone Inbox's additions for a screen reader (#9583, the a11y pass #9606): the drawer's Boards group (a heading, each board named, the open one aria-current and named on the button), a mail row's glyph (hidden
// where it is decoration, the row's own name on its open button, the checkbox named where it selects) and the standing permission (the answer's own words on a button of its own, above the bar in the card, so the
// reading order is the visual one). Run: node phone_inbox_a11y.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installDom, importUi, STATIC } from './helpers/jsdom_env.mjs';

installDom();
window.matchMedia = q => ({ matches: /max-width: 767px/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
const VL = await importUi('view_list');
const DT = await importUi('data_table');

// 1. the drawer's Boards group
const root = VL.build({ id: 'fixture', label: 'Inbox views', drawer: true, onPick() {}, current: 'board:team-b', sections: [
    { title: 'Needs attention', items: [{ key: 'needs', label: 'Needs you', count: 2 }] },
    { title: 'Boards', items: [{ key: 'board:team-a', label: 'Team A', icon: 'forum' }, { key: 'board:team-b', label: 'Team B', icon: 'forum' }] }] });
document.body.append(root);
const heads = [...root.querySelectorAll('.view-list-nav h2')].map(h => h.textContent);
assert.deepEqual(heads, ['Needs attention', 'Boards'], 'the group is a heading');
const items = [...root.querySelectorAll('.view-list-nav .view-list-item')];
assert.deepEqual(items.map(b => b.getAttribute('aria-label')), ['Needs you, 2', 'Team A', 'Team B'], 'each board is named by its team');
assert.deepEqual(items.filter(b => b.getAttribute('aria-current')).map(b => b.dataset.key), ['board:team-b'], 'the open board is the one current entry');
assert.ok(items.every(b => [...b.querySelectorAll('.view-list-icon')].every(i => i.getAttribute('aria-hidden') === 'true')), 'the glyphs are decoration');
assert.match(root.querySelector('.view-list-trigger').getAttribute('aria-label'), /^Team B\. Open the folders$/, 'the button names the open board');
root.remove();

// 2. a mail row: the glyph is hidden where it is decoration, named where it selects
const rows = [{ id: 'g1', title: 'Ship the thing' }];
const plain = DT.dataTable({ label: 'Goals', columns: [{ key: 'title', label: 'Goal', field: 'title' }], rows, rowKey: r => r.id, rowName: r => r.title, open() {}, mail: r => ({ lead: { icon: 'flag', square: true, name: 'open' }, title: r.title, snippet: 'outcome', time: '2m' }) });
document.body.append(plain.el);
const lead = plain.el.querySelector('.dt-mail-lead');
assert.equal(lead.getAttribute('aria-hidden'), 'true', 'a row that cannot be selected hides its glyph');
assert.equal(plain.el.querySelector('.dt-mail-open').getAttribute('aria-label'), 'Ship the thing', 'the open button is named by the row');
plain.el.remove();
const pick = DT.dataTable({ label: 'Goals', columns: [{ key: 'title', label: 'Goal', field: 'title' }], rows, rowKey: r => r.id, rowName: r => r.title, mail: r => ({ lead: { icon: 'flag', name: 'open' }, title: r.title }), selectable: { actions: [{ label: 'Star', run() {} }] } });
document.body.append(pick.el);
const box = pick.el.querySelector('.dt-mail-lead');
assert.equal(box.getAttribute('aria-hidden'), null);
assert.equal(box.getAttribute('aria-label'), 'Select Ship the thing', 'a selectable row names its checkbox');
pick.el.remove();

// 3. the standing permission: it is the answer's own full words on a button of its own, above the bar in the page
const { standingOptions } = await importUi('standing_option');
const apart = standingOptions([{ label: 'Yes' }, { label: "Yes, and don't ask again for go test commands" }, { label: 'No' }]).map(o => o.label);
assert.deepEqual(apart, ["Yes, and don't ask again for go test commands"], 'the standing answer is the one whose words say it is permanent; Yes and No stay in the bar');
const card = fs.readFileSync(STATIC + 'needs_input_card.js', 'utf8');
assert.ok(card.indexOf('cni-standing">${apart') < card.indexOf('class="cni-options '), 'the standing button is above the bar in the page, so the reading and the Tab order are the visual one (the bar is sticky: it follows the card; UI/UX\'s spec)');
assert.match(card, /optionButtonHtml\(o, "", fullLabels\[o\.label\]\)/, 'its name is the answer\'s own full words, never a shortened label');
console.log('phone_inbox_a11y: ok (Boards group headed and named, current board announced; mail glyph hidden or the checkbox named; standing permission by its own words, above the bar)');
