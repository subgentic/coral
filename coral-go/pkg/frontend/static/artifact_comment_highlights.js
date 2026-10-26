// The highlights: where each comment's quote sits in the drawn text, and the CSS highlights that light it (split out of attachComments, #8379).
import { importOnce } from './import_once.js';
const { locateQuote, indexText } = await importOnce('./artifact_anchor.js');

/** The anchors of one comments panel: `locate` finds the quotes again (into `st.ranges` and `st.orphan`), `paint` draws them and the panel, `hover` lights one thread, `forget` drops the text index when the document closes. */
export function createHighlights({ st, dialog, body, panel, threads, groupOf, render }) {
    const textNodes = () => { const out = []; const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n); return out; };
    // The index of the drawn text, kept while the text nodes are the ones it was made from (a megabyte takes a while to index, #5255); drawn again when any node was replaced, added, removed or changed in length.
    let docIx = null;
    function docIndex() {
        const nodes = textNodes();
        if (docIx && docIx.nodes.length === nodes.length && nodes.every((n, i) => n === docIx.nodes[i] && n.nodeValue.length === docIx.lens[i])) return docIx.ix;
        docIx = { nodes, lens: nodes.map(n => n.nodeValue.length), ix: indexText(nodes) };
        return docIx.ix;
    }
    // Where each comment's quote sits now. Needed when the comments or the document change, not when a comment is made current.
    function locate() {
        st.ranges.clear(); st.orphan.clear();
        if (!st.data || dialog.classList.contains('av-comparing')) return;
        const ix = docIndex();
        for (const { c } of threads()) {
            if (c.deleted || !c.anchor || c.anchor.whole || groupOf(c) !== 'main') continue;
            const hit = locateQuote(ix.text, c.anchor);
            if (!hit) { st.orphan.add(c.id); continue; }
            const first = ix.at(hit.start), last = ix.at(hit.end - 1);
            const r = document.createRange();
            r.setStart(first.node, first.offset);
            r.setEnd(last.node, last.offset + 1);
            st.ranges.set(c.id, r);
        }
    }
    function highlight() {
        const hl = window.CSS && CSS.highlights;
        if (hl) { hl.delete('ac-comment'); hl.delete('ac-active'); }
        if (!st.data || !hl || typeof Highlight !== 'function' || dialog.classList.contains('av-comparing')) return; // while two versions are compared the drawn text is the diff, not the version the comments are on
        const open = [];
        for (const { c } of threads()) { const r = st.ranges.get(c.id); if (r && !c.resolved) open.push(r); }
        if (open.length) hl.set('ac-comment', new Highlight(...open));
        const a = st.ranges.get(st.active);
        if (a) hl.set('ac-active', new Highlight(a));
    }
    // The thread the pointer is on (card or text): its text is lit a little, the card too.
    function hover(id) {
        const hl = window.CSS && CSS.highlights;
        panel.querySelectorAll('.ac-card.ac-hover').forEach(n => n.classList.remove('ac-hover'));
        if (hl) hl.delete('ac-hover');
        if (id == null) return;
        panel.querySelector(`.ac-card[data-id="${id}"]`)?.classList.add('ac-hover');
        const r = st.ranges.get(id);
        if (hl && r && typeof Highlight === 'function') hl.set('ac-hover', new Highlight(r));
    }
    function paint(relocate = true) {
        if (relocate) locate();
        highlight();
        render();
    }
    return { locate, hover, paint, forget: () => { docIx = null; } };
}
