// data_table's fold before the first paint (#7868, #7994). A table is built apart from the page, so its box has no width yet and the ResizeObserver has not run: the class dt-folded it has when it is built is
// what the first paint shows. A window narrower than the table's foldAt starts it folded (a first paint of the wide table would scroll a phone sideways); a window wider than foldAt does not, even a 481-760 px one:
// folding it first and unfolding a frame later was a flash. jsdom has no layout and no ResizeObserver, so what this reads is the pre-paint decision alone, deterministically (a browser run settles it after).
// Run: node data_table_prepaint_fold.test.mjs
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom();
// the helper's stand-in observer never fires; with none at all, the class a table has when it is built is certainly the pre-paint one
delete globalThis.ResizeObserver; delete window.ResizeObserver;
assert.equal(typeof ResizeObserver, 'undefined', 'no observer here: the class is the pre-paint one');
const DT = await importUi('data_table');

const build = (width, extra = {}) => {
    window.innerWidth = width;
    const t = DT.dataTable({ label: 'Fixture', columns: [{ key: 'a', label: 'A', field: 'a' }], rows: [{ a: 1 }], rowKey: r => 'r' + r.a, rowName: r => 'row ' + r.a, ...extra });
    return t.el.classList.contains('dt-folded');
};

// a phone: narrower than the default 40 rem (640 px) fold: folded before the first paint
assert.equal(build(390), true, '390 px starts folded');
assert.equal(build(480), true, '480 px starts folded');
// 481 to 760 px, wider than foldAt: NOT folded first (no fold-then-unfold flash); the observer folds it later if its own box is narrower
assert.equal(build(700), false, '700 px with the default 40 rem fold: not folded before paint');
assert.equal(build(761), false);
assert.equal(build(640), false, 'exactly foldAt is not narrower than it');
assert.equal(build(639), true, 'just under foldAt folds');
// a table with its own foldAt
assert.equal(build(700, { foldAt: 50 }), true, 'a 50 rem fold folds a 700 px window');
assert.equal(build(700, { foldAt: 30 }), false, 'a 30 rem (480 px) fold leaves a 700 px window alone');
assert.equal(build(400, { foldAt: 30 }), true);
// fold: always and none
assert.equal(build(1400, { fold: 'always' }), true, "fold 'always' is folded at any width");
assert.equal(build(300, { fold: 'none' }), false, "fold 'none' is never folded");

console.log('data_table_prepaint_fold: ok');
