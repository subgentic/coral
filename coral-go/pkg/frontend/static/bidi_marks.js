/* Text another person wrote in a comment (#14113, coral-hub's Security): the Hub passes bidirectional controls through, so Arabic and Hebrew work and a reversed-text spoof (a file name that ends in a right-to-left override and the letters of a reversed extension
 * reads as a harmless one) does too; only what the page draws can answer it. Two things, neither of which touches real right-to-left text (that needs no control character, the letters carry their own direction):
 *   - the override, embedding and isolate controls (U+202A-U+202E, U+2066-U+2069) are NOT applied: each is replaced by a visible mark naming its code point, as the markdown editor shows hidden characters
 *     (⟦U+202E⟧), with a title that says what it is; the comment's text itself is never changed;
 *   - each piece of comment text is its own isolate (dir=auto, unicode-bidi: isolate), so whatever it holds cannot reorder the author, the time or the buttons beside it.
 * The marker is an isolate of its own and left to right, so it cannot be reordered either.
 * Left alone on purpose: the left-to-right and right-to-left marks (U+200E, U+200F) and the Arabic letter mark (U+061C). They are not overrides or embeddings: they only nudge how a neutral character next to them
 * is placed, Arabic and Hebrew text legitimately carries them, and marking each one would litter real right-to-left comments with boxes while hiding nothing a reader could be fooled by. */
const CONTROL = /[\u202A-\u202E\u2066-\u2069]/;
const SPLIT = /([\u202A-\u202E\u2066-\u2069])/;
const WORDS = { 0x202a: 'left-to-right embedding', 0x202b: 'right-to-left embedding', 0x202c: 'pop directional formatting', 0x202d: 'left-to-right override', 0x202e: 'right-to-left override', 0x2066: 'left-to-right isolate', 0x2067: 'right-to-left isolate', 0x2068: 'first-strong isolate', 0x2069: 'pop directional isolate' };

export const bidiCode = ch => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

/** The text without the controls (for a decoration made from a name: an initials circle). */
export const bidiStripped = text => String(text == null ? '' : text).replace(new RegExp(SPLIT.source, 'g'), '');

/** The text with each control written out as ⟦U+XXXX⟧ (for a place that takes a string: a screen reader's announcement, a tooltip). */
export const bidiWritten = text => String(text == null ? '' : text).replace(new RegExp(SPLIT.source, 'g'), c => `⟦${bidiCode(c)}⟧`);

/** Replaces every control in root's text with its visible mark and makes root an isolate. Returns root. */
export function markBidi(root) {
    if (!root) return root;
    root.setAttribute('dir', 'auto');
    root.setAttribute('data-bidi', 'isolate'); // an attribute, not a class: a suite reads an element's class order (the author span's)
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [];
    while (walker.nextNode()) if (CONTROL.test(walker.currentNode.data)) nodes.push(walker.currentNode);
    for (const node of nodes) {
        const frag = document.createDocumentFragment();
        for (const piece of node.data.split(SPLIT)) {
            if (!piece) continue;
            if (piece.length === 1 && CONTROL.test(piece)) {
                const m = document.createElement('span');
                m.className = 'bidi-mark';
                m.textContent = `⟦${bidiCode(piece)}⟧`;
                m.title = `A ${WORDS[piece.codePointAt(0)] || 'bidirectional control'} (${bidiCode(piece)}) is in this text: shown here, not applied`;
                frag.append(m);
            } else frag.append(document.createTextNode(piece));
        }
        node.replaceWith(frag);
    }
    return root;
}
