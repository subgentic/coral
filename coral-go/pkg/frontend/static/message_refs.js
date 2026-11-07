/* "#8" in a question's text opens message 8 of the team (#14153, the Beta Tester: a question said "you approved #8" and "your #6 answer", numbers the person had never been shown). The text is the asker's: a number is only
 * ever a link to a message of THIS team on THIS computer, built from the digits alone (the anchor's words are the digits, never the text around them). A "#N" after the word task, goal, issue, step, PR or item
 * names something else and stays text, as does one inside a link, code or a heading's own "#". A page with no team to open it in (a question from another computer) is left as it is. */
const REF = /(^|[^A-Za-z0-9#&/])#([1-9][0-9]{0,8})(?![A-Za-z0-9_-])/g;
const NOT_A_MESSAGE = /\b(?:tasks?|goals?|issues?|steps?|prs?|pull requests?|items?|numbers?|nos?\.?|bugs?|findings?|rows?|points?)\s*$/i;

/** The text as parts: { text } and { id } (the message number), in order. */
export function splitMessageRefs(text) {
    const s = String(text == null ? '' : text), parts = [];
    let at = 0, m;
    REF.lastIndex = 0;
    while ((m = REF.exec(s))) {
        const start = m.index + m[1].length;
        if (NOT_A_MESSAGE.test(s.slice(Math.max(0, start - 20), start))) continue;
        if (start > at) parts.push({ text: s.slice(at, start) });
        parts.push({ id: Number(m[2]) });
        at = start + m[0].length - m[1].length;
    }
    if (at < s.length) parts.push({ text: s.slice(at) });
    return parts;
}

/** Turns "#N" in the text nodes of root into buttons that call open(id, button); returns how many were made. */
export function linkMessageRefsIn(root, open, { who = 'the sender' } = {}) {
    if (!root || typeof open !== 'function') return 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.includes('#') && !n.parentElement.closest('a,button,code,pre,kbd,samp,script,style,h1,h2,h3,h4,h5,h6')) nodes.push(n);
    let made = 0;
    for (const n of nodes) {
        const parts = splitMessageRefs(n.nodeValue);
        if (!parts.some(p => p.id)) continue;
        const frag = document.createDocumentFragment();
        for (const p of parts) {
            if (p.text !== undefined) { frag.append(p.text); continue; }
            const b = document.createElement('button'); b.type = 'button'; b.className = 'msg-ref'; b.textContent = `#${p.id}`; b.dataset.message = String(p.id);
            b.title = `Open message #${p.id} of this team's board (named by ${who})`; b.setAttribute('aria-label', `Open message ${p.id}`);
            b.addEventListener('click', () => open(p.id, b));
            frag.append(b); made++;
        }
        n.replaceWith(frag);
    }
    return made;
}
