/** The replies to an open message, as buttons that go to each one: built from the rows now in the list (a reply is a row of its own, in order, indented). */
export function fillReplies(row, replies) {
    const holder = row.querySelector(':scope > .mb-row-replies');
    if (!holder) return;
    const kids = replies ?? (row.parentElement ? row.parentElement.querySelectorAll(`:scope > .mb-message[data-reply-to="${CSS.escape(row.dataset.messageId)}"]`) : []);
    holder.replaceChildren();
    if (kids.length) {
        const title = document.createElement('div'); title.className = 'mb-row-replies-title';
        title.textContent = `Replies (${kids.length})`; holder.append(title);
    }
    holder.hidden = !kids.length;
    for (const kid of kids) {
        const item = document.createElement('div');
        item.className = 'mb-row-reply';
        const who = kid.querySelector('.mb-row-who')?.textContent?.trim() || 'sender';
        const header = document.createElement('div'); header.className = 'mb-row-reply-header';
        const author = document.createElement('b'); author.textContent = who;
        const time = document.createElement('span'); time.className = 'mb-row-reply-time';
        time.textContent = kid.querySelector('.mb-row-toggle time')?.textContent || '';
        const open = document.createElement('button'); open.type = 'button'; open.className = 'mb-row-reply-open';
        open.setAttribute('data-on-click', 'mb-jump-msg'); open.dataset.msgId = kid.dataset.messageId;
        open.setAttribute('aria-label', `Open reply by ${who}`); open.textContent = 'Open reply';
        header.append(author, time, open); item.append(header);
        const words = document.createElement('div'); words.className = 'mb-row-reply-words';
        const sourceBody = kid.querySelector('.mb-message-body');
        if (sourceBody) {
            words.append(...Array.from(sourceBody.childNodes, child => child.cloneNode(true)));
            // The body clone is displayed beside the actual reply; duplicate IDs would break its references.
            for (const el of words.querySelectorAll('[id]')) el.removeAttribute('id');
        }
        item.append(words);
        if (words.textContent.trim().length > 220) {
            words.classList.add('is-clamped');
            const more = document.createElement('button');
            more.type = 'button'; more.className = 'mb-row-reply-more'; more.textContent = 'Show more';
            more.setAttribute('aria-expanded', 'false');
            more.addEventListener('click', () => {
                const expanded = item.classList.toggle('is-expanded');
                words.classList.toggle('is-clamped', !expanded);
                more.textContent = expanded ? 'Show less' : 'Show more';
                more.setAttribute('aria-expanded', String(expanded));
            });
            item.append(more);
        }
        holder.append(item);
    }
}
