// The Inbox's new parts, for a keyboard and a screen reader (Goal #100, #9564): the phone drawer (the button's expanded state, Escape, focus back to the button, Tab that stays inside the open panel), the mail row (its avatar is a checkbox with a name,
// the selection count is read from a region that stays in the page) and the Hub frames (each has a title, and a folder the person opens puts the focus in the frame). Run: node inbox_a11y.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installDom, importUi, STATIC } from './helpers/jsdom_env.mjs';

installDom();
window.matchMedia = q => ({ matches: /max-width: 767px/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
const VL = await importUi('view_list');
const DT = await importUi('data_table');
const key = (el, k, extra = {}) => !el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra })); // true when the page's own handling was prevented

// 1. the drawer
const picks = [];
const root = VL.build({ id: 'fixture', label: 'Inbox views', drawer: true, onPick: k => picks.push(k), current: 'a', sections: [{ items: [{ key: 'a', label: 'Alpha', count: 2 }, { key: 'b', label: 'Beta' }, { key: 'c', label: 'Gamma' }] }] });
document.body.append(root);
const trigger = root.querySelector('.view-list-trigger'), nav = root.querySelector('.view-list-nav');
const stops = () => [...nav.querySelectorAll('.view-list-item')].filter(b => b.tabIndex >= 0);
assert.equal(trigger.getAttribute('aria-expanded'), 'false');
assert.equal(trigger.getAttribute('aria-controls'), nav.id);
trigger.click();
assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'the button says the panel is open');
assert.ok(nav.contains(document.activeElement), 'the focus moves into the panel');
const [first, last] = [stops()[0], stops().at(-1)];
last.focus();
assert.equal(key(last, 'Tab'), true, 'Tab on the last stop is held inside the panel (the browser would take it to the page behind the scrim)');
assert.ok(nav.contains(document.activeElement));
first.focus();
assert.equal(key(first, 'Tab', { shiftKey: true }), true, 'and Shift+Tab on the first');
assert.ok(nav.contains(document.activeElement));
key(document.activeElement, 'Escape');
assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'Escape closes it');
assert.equal(document.activeElement, trigger, 'and the focus is back on the button');
trigger.click(); nav.querySelector('[data-key="b"]').click();
assert.deepEqual(picks, ['b']);
assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'choosing a view closes it');
assert.equal(document.activeElement, trigger, 'and the focus is on the button, not lost with the hidden item');
root.remove();

// 2. the mail row
const rows = [{ id: 1, name: 'First chat' }, { id: 2, name: 'Second chat' }];
const t = DT.dataTable({ label: 'Chats', columns: [{ key: 'name', label: 'Name', field: 'name' }], rows, rowKey: r => 'r' + r.id, rowName: r => r.name, mail: r => ({ title: r.name, snippet: 'hello' }), selectable: { actions: [{ label: 'Star', run() {} }] } });
document.body.append(t.el);
const lead = t.el.querySelector('.dt-mail-lead');
assert.ok(lead, 'a phone row has its avatar control');
assert.equal(lead.getAttribute('role'), 'checkbox', 'the avatar is a checkbox');
assert.equal(lead.getAttribute('aria-label'), 'Select First chat', 'with the row\'s name');
assert.equal(lead.getAttribute('aria-checked'), 'false');
assert.equal(lead.hasAttribute('aria-pressed'), false, 'not a pressed toggle as well');
lead.click();
assert.equal(t.el.querySelector('.dt-mail-lead').getAttribute('aria-checked'), 'true', 'the checkbox is checked when the row is selected');
const live = t.el.querySelector('[role="status"].sr-only');
assert.ok(live, 'the selection count has a region that stays in the page');
assert.equal(live.textContent, '1 selected', 'and it says how many');
t.el.querySelector('.dt-mail-lead').click();
assert.equal(live.textContent, '', 'and goes quiet when none is');
t.el.remove();

// 3. the Hub frames
const sidebar = fs.readFileSync(STATIC + 'inbox_sidebar.js', 'utf8'), groups = fs.readFileSync(STATIC + 'sidebar_groups.js', 'utf8');
assert.match(sidebar, /f\.className = 'inbox-frame'; f\.title = meta\.label;/, 'every Hub frame has a title (its folder\'s name)');
assert.match(groups, /if \(focus\) \(document\.querySelector\('#group-table-view \.inbox-frame'\) \|\|/, 'a folder opened by the person puts the focus in its frame');
console.log('inbox_a11y: ok (drawer expanded state, Tab trap, Escape, focus back; mail avatar checkbox, selection count region; Hub frames titled and focused)');
