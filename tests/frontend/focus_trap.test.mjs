// The dialog's focus trap treats the dialog box as a stop (#9538, Security Reviewer's LOW on #9520): a dialog opened with the focus on its box (.modal-content) must not let Shift+Tab leave it for what is
// before it in the page. trapTarget(...) is the decision modal_chrome.js applies to every dialog: the control to move to, or null for the browser's own move. Plain objects stand for the elements.
//   node focus_trap.test.mjs
import assert from 'node:assert/strict';
import { trapTarget } from '../../coral-go/pkg/frontend/static/focus_trap.js';

const el = name => ({ name });
const [a, b, c, roving] = [el('a'), el('b'), el('c'), el('roving')];
const box = el('box'), modal = el('modal'), opener = el('opener');
const inside = new Set([a, b, c, roving, box, modal]);
modal.contains = x => inside.has(x);
const base = { modal, box, all: [roving, a, b, c], stops: [a, b, c] };
const go = (active, shift) => trapTarget({ ...base, active, shift });

assert.equal(go(box, true), c, 'Shift+Tab from the dialog box goes to the last control, not out of the dialog');
assert.equal(go(box, false), a, 'Tab from the dialog box goes to the first control');
assert.equal(trapTarget({ ...base, box: undefined, active: box, shift: true }), null, 'what the trap did before: with the box not a stop, Shift+Tab from it was the browser\'s move, out of the dialog (the case this test pins)');
assert.equal(go(modal, true), c, 'the same when the focus is on the modal element itself');
assert.equal(go(a, true), c, 'Shift+Tab from the first control wraps to the last');
assert.equal(go(c, false), a, 'Tab from the last control wraps to the first');
assert.equal(go(roving, true), c, 'a roving-tabindex tab that is the first of all wraps too');
assert.equal(go(opener, true), c, 'focus left on the control that opened the dialog comes in from the end with Shift+Tab');
assert.equal(go(opener, false), a, 'and from the start with Tab');
assert.equal(go(b, true), null, 'a control in the middle: the browser moves the focus');
assert.equal(go(b, false), null, 'both ways');
assert.equal(trapTarget({ ...base, stops: [], all: [], active: box, shift: true }), null, 'a dialog with no control leaves the key alone');
assert.equal(trapTarget({ modal, all: [a], stops: [a], active: a, shift: false }), a, 'one control: Tab stays on it (no box needed)');
console.log('focus_trap: ok (the dialog box is a stop: Shift+Tab goes to the last control, Tab to the first; the edges wrap; the middle is the browser\'s)');
