// The accessibility tree in page order (#9222). Accessibility.getFullAXTree returns a FLAT list that is not in tree order (a group's children come after the siblings that follow the group: a fieldset's
// fields were listed after the field below it), so a suite that checks an order, or a count under one control, walks the tree itself: depth first through childIds, the order Chrome gives a screen reader.
//   axNodes(Accessibility)                          -> every node that is not ignored, from the root, in page order
//   axNodes(Accessibility, { from: backendNodeId }) -> the same under one DOM node (null when that node is not in the tree)
// An ignored node is not returned, but its children are (a wrapper the tree skips still has its parts in the order). The caller enables the Accessibility domain.
async function axNodes(Accessibility, { from } = {}) {
    const { nodes } = await Accessibility.getFullAXTree();
    const byId = new Map(nodes.map(n => [n.nodeId, n]));
    const start = from == null ? (nodes.find(n => !n.parentId) || nodes[0]) : nodes.find(n => n.backendDOMNodeId === from);
    if (!start) return from == null ? [] : null;
    const out = [], seen = new Set();
    const walk = n => { if (seen.has(n.nodeId)) return; seen.add(n.nodeId); if (!n.ignored) out.push(n); for (const c of n.childIds || []) { const k = byId.get(c); if (k) walk(k); } };
    walk(start);
    return out;
}

module.exports = { axNodes };
