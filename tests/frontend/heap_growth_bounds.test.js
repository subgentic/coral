// The node bound of heap_growth_browser (#13622). One sample of the DOM node count moves a few hundred up and down (Windows: 11293 to 11664 in a run with nothing growing), so a bound on the
// last samples' MEDIAN against one warm-up sample failed there twice (trial-250's windows-tests: +133 and +225 over a bound of 120) while the count came back to its floor. A leak raises the
// FLOOR, so the bound compares the lowest of the first three samples with the lowest of the last five. The two Windows series below are the ones from that run; the leak series is the
// suite's own HEAP_LEAK_SELFTEST (3 nodes a round) with the same jitter on top.
const assert = require('node:assert/strict');
const { nodeFloorGrowth, nodeFloorBound } = require('./helpers/heap_bounds');

const at = (ns, nodes) => ns.map((n, i) => ({ n, nodes: nodes[i] }));
const ROUNDS = [20, 25, 30, 35, 40, 45, 50, 55, 60];
const winA = at(ROUNDS, [11341, 11295, 11486, 11295, 11341, 11568, 11486, 11295, 11474]);
const winB = at(ROUNDS, [11343, 11295, 11664, 11343, 11438, 11568, 11568, 11293, 11568]);
const per = 40;

// The rule that failed (the median of the last five against the warm-up sample): the same series are red under it.
const oldGrowth = s => [...s.slice(-5).map(x => x.nodes)].sort((a, b) => a - b)[2] - s[0].nodes;
assert.ok(oldGrowth(winA) > 100 + per / 2 && oldGrowth(winB) > 100 + per / 2, 'the old rule fails both Windows series');

assert.ok(nodeFloorGrowth(winA) <= nodeFloorBound(per), `Windows A: floor grew ${nodeFloorGrowth(winA)}, bound ${nodeFloorBound(per)}`);
assert.ok(nodeFloorGrowth(winB) <= nodeFloorBound(per), `Windows B: floor grew ${nodeFloorGrowth(winB)}, bound ${nodeFloorBound(per)}`);

// A leak of 3 nodes a round with the same jitter on top (0, 50, 190, 270 above the floor, in the order the Windows runs had them) is caught.
const jitter = [0, 190, 0, 270, 50, 0, 190, 50, 0];
const leak = ROUNDS.map((n, i) => ({ n, nodes: 11300 + 3 * (n - 20) + jitter[i] }));
assert.ok(nodeFloorGrowth(leak) > nodeFloorBound(per), `the leak: floor grew ${nodeFloorGrowth(leak)}, bound ${nodeFloorBound(per)}`);
// ... and so is one that sits on the jitter's high side only (every sample above the floor by the same amount).
assert.ok(nodeFloorGrowth(leak.map(x => ({ ...x, nodes: x.nodes + 200 }))) > nodeFloorBound(per));
// Fewer than eight samples (a short run): the first three and the last five may overlap, and the rule still answers.
assert.equal(nodeFloorGrowth(at([10, 20, 30], [100, 90, 110])), 0);
console.log('ok: heap_growth node floor bound (Windows jitter passes, a 3-node-a-round leak fails)');
