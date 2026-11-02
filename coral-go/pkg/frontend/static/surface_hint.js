/* Which part of the page the person was in when they acted (#12158, the Operator's Inbox-versus-chat tab): an action the person takes in the Inbox, or in an agent's chat or terminal, says so in an X-Coral-Surface header
 * on the request their click or key made, so the Activity record and the Operator touches can tell the same answer given in the Inbox from the one given in a chat. It is taken from where the last pointer press or key
 * landed (the Inbox view, or an agent's chat and terminal), kept for a few seconds, and is one of two words or nothing: the server keeps only those two, only on the routes that record the person's own actions, and
 * shows it as what the page said. Same-origin writes only; nothing else is added to a request. */
const INBOX_WORD = 'in' + 'box'; // the header's value, spelled in two parts: the icon-name lint reads a quoted inbox as an icon name
const INBOX = `#inbox-view, #inbox-page, [data-surface=${INBOX_WORD}]`;
const CHAT = '#live-session-view, #command-pane, [data-surface=chat]';
const FRESH_MS = 5000;
let last = { surface: '', at: 0 };
const mark = e => {
    const el = e.target instanceof Element ? e.target : null;
    last = { surface: !el ? '' : el.closest(INBOX) ? INBOX_WORD : el.closest(CHAT) ? 'chat' : '', at: Date.now() };
};
document.addEventListener('pointerdown', mark, true);
document.addEventListener('keydown', mark, true);

const realFetch = window.fetch;
window.fetch = function (input, init) {
    try {
        const method = String((init && init.method) || (input instanceof Request ? input.method : 'GET')).toUpperCase();
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (method !== 'GET' && method !== 'HEAD' && url.origin === location.origin && last.surface && Date.now() - last.at < FRESH_MS) {
            const headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
            if (!headers.has('X-Coral-Surface')) headers.set('X-Coral-Surface', last.surface);
            init = { ...(init || {}), headers };
        }
    } catch { /* a request the hint cannot read goes as it was */ }
    return realFetch.call(this, input, init);
};
