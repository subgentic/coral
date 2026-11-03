/* The "Replying to" strip above a board box (#12502): which message the text answers, with its first words, and a way to drop the link. It is the link itself: the post carries reply_to while the strip is
 * there, whatever the text says (the "@Name" the Reply button puts in the box stays, since it is what notifies the person). Drawn with textContent. */

const SNIPPET = 80;

/** Show the strip for a message ({ id, name, text }) above the box card, or take it away (null). onClear runs when the person drops it. */
export function setReplyStrip(input, reply, onClear) {
    if (!input) return;
    const anchor = input.closest('.mb-post-card') || input;
    const old = anchor.previousElementSibling;
    if (old && old.classList.contains('mb-reply-strip')) old.remove();
    if (!reply) return;
    const strip = document.createElement('div');
    strip.className = 'mb-reply-strip'; strip.setAttribute('role', 'group'); strip.setAttribute('aria-label', `Replying to ${reply.name}`);
    const words = String(reply.text || '').replace(/\s+/g, ' ').trim();
    const text = document.createElement('span');
    text.className = 'mb-reply-strip-text';
    text.textContent = `Replying to ${reply.name}${words ? `: “${words.length > SNIPPET ? words.slice(0, SNIPPET - 1) + '…' : words}”` : ''}`;
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'btn btn-quiet btn-xs mb-reply-strip-clear'; x.textContent = 'Cancel reply';
    x.setAttribute('aria-label', `Stop replying to ${reply.name}`);
    x.addEventListener('click', () => { setReplyStrip(input, null); onClear?.(); input.focus(); });
    strip.append(text, x);
    anchor.before(strip);
}
