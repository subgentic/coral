// The DOM node bound of heap_growth_browser (#13622); heap_growth_bounds.test.js pins it with the Windows series that failed the old one.
// A node count jitters by a few hundred between samples with nothing growing, and a leak raises the lowest count, not the noise above it: the growth is the lowest of the last five samples minus
// the lowest of the first three (the warm-up sample and the two after it), never below 0.
const lowest = xs => Math.min(...xs.map(x => x.nodes));
function nodeFloorGrowth(series) {
    return Math.max(0, lowest(series.slice(-5)) - lowest(series.slice(0, 3)));
}
/** The most the floor may grow over `per` rounds after the warm-up: a leak of 3 nodes a round (the suite's selftest) is 60 between the first and the last five samples' floors. */
const nodeFloorBound = per => 40 + per / 4;
module.exports = { nodeFloorGrowth, nodeFloorBound };
