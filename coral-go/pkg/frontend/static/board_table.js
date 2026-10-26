/* The board as a table (#7921, goal #33; UI/UX's mock #7916): one row a message, the row opens in place to the whole message. The module is shared: the team Board page draws its rows with it
 * (message_board.js) and the agent dock's Board tab will (#7922). It builds the parts a row adds to the board's own message markup (a one-button head, the actions, the day dividers), keeps the
 * choices (Table or Chat, remembered per viewer; which rows are open, kept while messages arrive and dropped when the team changes) and the controls (the Table | Chat switch, the pills). The
 * chat view is the same rows with the head hidden, so every board action, the poll, Select and Export work in both. Pure string builders and small DOM helpers: no board state in here. */
import { escapeHtml, escapeAttr } from './html_escape.js';
import { askBadge, mentionedNames } from './board_message_text.js';
import { browserLocal } from './safe_storage.js';

const VIEW_KEY = 'coral.board.view';
const SNIPPET_CHARS = 300;
const MENTIONS_SHOWN = 2;

/** 'table' (the default) or 'chat': the viewer's choice, remembered in this browser. */
export function boardView() { return browserLocal.get(VIEW_KEY) === 'chat' ? 'chat' : 'table'; }
export function saveBoardView(view) { browserLocal.set(VIEW_KEY, view === 'chat' ? 'chat' : 'table'); }

const opened = new Set();
/** Whether a message's row is open. */
export const isRowOpen = (id) => opened.has(String(id));
/** Another team: no row stays open. */
export const forgetOpenRows = () => opened.clear();

// The sender's circle: a solid fill with the initial in white, from the eight avatar tokens the tables' people use (variables.css, each 4.5:1 or more against white, the same in both themes). A name always gets the same one.
/** The fill of a sender's circle. */
export function avatarColor(name) {
    let h = 0;
    for (const c of String(name || '')) h = (h * 31 + c.codePointAt(0)) >>> 0;
    return `var(--avatar-${h % 8 + 1})`;
}

/** A message's first line of words for its row: Markdown marks and links reduced to their text, one line, never more than 300 characters (the stylesheet cuts it to the row). */
export function snippetOf(content) {
    const text = String(content || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(^|\n)\s{0,3}#{1,6}\s+/g, '$1')
        .replace(/[`*_>~]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const chars = Array.from(text);
    return chars.length > SNIPPET_CHARS ? chars.slice(0, SNIPPET_CHARS).join('') : text;
}

/** The task numbers a text names ("#7740"), each once, in the order written. */
export function taskRefs(content) {
    const out = [];
    for (const m of String(content || '').replace(/```[\s\S]*?```/g, ' ').matchAll(/(?<![\w&#/])#(\d{1,7})(?![\w-])/g)) if (!out.includes(m[1])) out.push(m[1]);
    return out;
}

/** What marks a message in its row: who it mentions (two, then "+N"), the first task it names, that it is a question, and whom it answers. Quiet tags, never louder text. */
export function tagsOf(m, { replyName = '', self = 'operator' } = {}) {
    const names = mentionedNames(m && m.content);
    return {
        mentions: names.slice(0, MENTIONS_SHOWN).map(n => ({ name: n, self: n.toLowerCase() === self })),
        more: Math.max(0, names.length - MENTIONS_SHOWN),
        task: taskRefs(m && m.content)[0] || '',
        ask: !!(m && m.ask && typeof m.ask === 'object'),
        mine: names.some(n => n.toLowerCase() === self),
        replyName,
    };
}

function tagsHtml(m, tags) {
    const out = [];
    if (tags.replyName) out.push(`<span class="mb-row-tag mb-row-reply-tag">Reply to ${escapeHtml(tags.replyName)}</span>`);
    for (const t of tags.mentions) out.push(`<span class="mb-row-tag mb-row-mention${t.self ? ' is-self' : ''}">@${escapeHtml(t.name)}</span>`);
    if (tags.more) out.push(`<span class="mb-row-tag mb-row-more-tag" title="${escapeAttr(`${Number(tags.more)} more mentioned`)}">+${Number(tags.more)}</span>`);
    if (tags.task) out.push(`<span class="mb-row-tag mb-row-task">#${escapeHtml(tags.task)}</span>`);
    if (tags.ask) out.push(askBadge(m));
    return out.join('');
}

const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const dayYear = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** The day of a timestamp as a divider says it: Today, Yesterday, else "Mon, Oct 24" (with the year when it is not this one); '' when the time cannot be read. */
export function dayLabel(iso, now = new Date()) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return (d.getFullYear() === now.getFullYear() ? day : dayYear).format(d);
}

/** Whether two timestamps are on one day (an unreadable one is on its own). */
export function sameDay(a, b) {
    const x = new Date(a), y = new Date(b);
    return Number.isFinite(x.getTime()) && Number.isFinite(y.getTime()) && x.toDateString() === y.toDateString();
}

/** The divider above a day's first row: sticky while that day's rows scroll under it. A list item, since the messages box is a list. */
export function dayDividerHtml(iso) {
    const label = dayLabel(iso);
    return label ? `<div class="mb-day" role="listitem" data-day="${escapeAttr(String(new Date(iso).toDateString()))}">${escapeHtml(label)}</div>` : '';
}

/** What a message's row adds to the board's own markup, as strings: `toggle` (the one-button head), `tagsOpen` (the tags again at the top of the open message, for the phone's folded row), `actions` (Reply,
 * Copy link, More) and the row's classes. agent is the sender's name, timeHtml the message's <time>, moreLabel the name of its More button. */
export function rowParts(m, { agent, timeHtml, moreLabel, replyName = '', self = 'operator' }) {
    const replyText = `Reply to ${agent}`;
    const tags = tagsOf(m, { replyName, self });
    const open = isRowOpen(m.id);
    const snippet = snippetOf(m.content);
    const tagHtml = tagsHtml(m, tags);
    const initial = Array.from(String(agent || '?'))[0] || '?';
    return {
        classes: `${open ? ' mb-open' : ''}${tags.ask ? ' mb-q' : ''}${tags.mine ? ' mb-mine' : ''}${replyName ? ' mb-is-reply' : ''}`,
        toggle: `<button type="button" class="mb-row-toggle" data-on-click="mb-row-toggle" aria-expanded="${escapeAttr(String(open))}" aria-controls="mbd-${Number(m.id)}"><span class="mb-row-chev" aria-hidden="true"></span><span class="mb-row-avatar" style="--mb-avatar:${escapeAttr(avatarColor(agent))}" aria-hidden="true">${escapeHtml(initial.toUpperCase())}</span><span class="mb-row-who" title="${escapeAttr(agent)}">${escapeHtml(agent)}</span><span class="mb-row-snippet">${escapeHtml(snippet)}</span><span class="mb-row-tags">${tagHtml}</span>${timeHtml}</button>`,
        tagsOpen: tagHtml ? `<div class="mb-row-tags-open">${tagHtml}</div>` : '',
        actions: `<div class="mb-row-replies" hidden></div><div class="mb-row-actions"><button type="button" class="btn mb-row-btn" data-on-click="mb-msg-reply" data-msg-id="${Number(m.id)}" data-sender="${escapeAttr(agent)}" aria-label="${escapeAttr(replyText)}">Reply</button><button type="button" class="btn mb-row-btn" data-on-click="mb-msg-copy-link" data-msg-id="${Number(m.id)}">Copy link</button><button type="button" class="btn mb-row-btn mb-row-more" data-on-click="mb-msg-more" aria-haspopup="dialog" aria-label="${escapeAttr(moreLabel)}">More</button></div>`,
    };
}

/** The members arrived after the rows were drawn (a mention names a member): each row's mention tags are read again from its message text, in place; the other tags stay. */
export function retagMentions(container, self = 'operator') {
    if (!container) return;
    for (const row of container.querySelectorAll(':scope > .mb-message[data-message-id]')) {
        const body = row.querySelector('.mb-message-body');
        if (!body) continue;
        const names = mentionedNames(body.textContent);
        const same = [...row.querySelectorAll(':scope > .mb-row-toggle .mb-row-mention')].map(e => e.textContent.slice(1)).join('\n') === names.slice(0, MENTIONS_SHOWN).join('\n');
        row.classList.toggle('mb-mine', names.some(n => n.toLowerCase() === self));
        if (same) continue;
        for (const holder of row.querySelectorAll(':scope > .mb-row-toggle .mb-row-tags, :scope > .mb-row-tags-open')) {
            for (const old of holder.querySelectorAll('.mb-row-mention, .mb-row-more-tag')) old.remove();
            const at = holder.querySelector('.mb-row-task, .mb-external-badge');
            const frag = document.createDocumentFragment();
            for (const n of names.slice(0, MENTIONS_SHOWN)) {
                const t = document.createElement('span');
                t.className = `mb-row-tag mb-row-mention${n.toLowerCase() === self ? ' is-self' : ''}`;
                t.textContent = `@${n}`;
                frag.append(t);
            }
            if (names.length > MENTIONS_SHOWN) { const more = document.createElement('span'); more.className = 'mb-row-tag mb-row-more-tag'; more.textContent = `+${names.length - MENTIONS_SHOWN}`; frag.append(more); }
            holder.insertBefore(frag, at);
        }
    }
}

/** The replies to an open message, as buttons that go to each one: built from the rows now in the list (a reply is a row of its own, in order, indented). */
function fillReplies(row) {
    const holder = row.querySelector(':scope > .mb-row-replies');
    if (!holder) return;
    const kids = row.parentElement ? [...row.parentElement.querySelectorAll(`:scope > .mb-message[data-reply-to="${CSS.escape(row.dataset.messageId)}"]`)] : [];
    holder.replaceChildren();
    holder.hidden = !kids.length;
    if (!kids.length) return;
    const title = document.createElement('div');
    title.className = 'mb-row-replies-title';
    title.textContent = `Replies (${kids.length})`;
    holder.append(title);
    for (const kid of kids) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mb-row-reply';
        b.setAttribute('data-on-click', 'mb-jump-msg');
        b.dataset.msgId = kid.dataset.messageId;
        const who = kid.querySelector('.mb-row-who'), time = kid.querySelector('.mb-row-toggle time'), snip = kid.querySelector('.mb-row-snippet');
        const name = document.createElement('b'); name.textContent = who ? who.textContent : '';
        const when = document.createElement('span'); when.className = 'mb-row-reply-time'; when.textContent = time ? time.textContent : '';
        const words = document.createElement('span'); words.className = 'mb-row-reply-words'; words.textContent = snip ? snip.textContent : '';
        b.append(name, when, words);
        holder.append(b);
    }
}

/** Open or close one row (force true or false, else the other way). The open ones are remembered by message id. */
export function toggleRow(row, force) {
    const want = typeof force === 'boolean' ? force : !row.classList.contains('mb-open');
    row.classList.toggle('mb-open', want);
    const head = row.querySelector(':scope > .mb-row-toggle');
    if (head) head.setAttribute('aria-expanded', String(want));
    const id = row.dataset.messageId;
    if (want) { opened.add(String(id)); fillReplies(row); } else opened.delete(String(id));
}

/** Expand all or Collapse all: every row on screen (and, for Collapse, every one remembered). */
export function setAllRows(container, on) {
    for (const row of container.querySelectorAll(':scope > .mb-message[data-message-id]')) toggleRow(row, on);
    if (!on) opened.clear();
}

/** Draw the open rows' replies again (the list changed under them). */
export function refreshReplies(container) {
    for (const row of container.querySelectorAll(':scope > .mb-message.mb-open')) fillReplies(row);
}

/** The view on the box: the table's class and the choice as a data attribute. */
export function applyView(container, view) {
    if (!container) return;
    container.classList.toggle('mb-table', view === 'table');
    container.dataset.view = view;
    for (const b of document.querySelectorAll('#mb-tools [data-table-only]')) b.hidden = view !== 'table'; // Expand all and Collapse all are the table's
}

const PILLS = [['all', 'All'], ['questions', 'Questions'], ['mentions', 'Mentions me']];

/** The toolbar's line under the search: the pills (All, Questions, Mentions me) at the left, the Table | Chat switch at the right. Built once per host; onView(view) and onPill(pill) are called on a choice. */
export function mountTableTools(host, { view, pill = 'all', onView, onPill }) {
    let bar = host.querySelector(':scope > #mb-table-tools');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'mb-table-tools';
    bar.className = 'mb-table-tools';
    const pills = document.createElement('div');
    pills.className = 'goals-chips mb-pills'; // the chips of the Goals and Tasks tabs: one chosen style
    pills.setAttribute('role', 'group');
    pills.setAttribute('aria-label', 'Show');
    for (const [key, label] of PILLS) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'goals-chip mb-pill'; b.dataset.pill = key; b.textContent = label;
        b.setAttribute('aria-pressed', String(key === pill));
        b.addEventListener('click', () => { for (const x of pills.children) x.setAttribute('aria-pressed', String(x === b)); onPill(key); });
        pills.append(b);
    }
    const sw = document.createElement('div');
    sw.className = 'mb-view-switch';
    sw.setAttribute('role', 'group');
    sw.setAttribute('aria-label', 'Board view');
    for (const [key, label] of [['table', 'Table'], ['chat', 'Chat']]) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'mb-view-btn'; b.dataset.view = key; b.textContent = label;
        b.setAttribute('aria-pressed', String(key === view));
        b.addEventListener('click', () => { for (const x of sw.children) x.setAttribute('aria-pressed', String(x === b)); onView(key); });
        sw.append(b);
    }
    bar.append(pills, sw);
    host.append(bar);
    return bar;
}
