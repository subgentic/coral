/* The board as a table (#7921, goal #33; UI/UX's mock #7916): one row a message, the row opens in place to the whole message. The module is shared: the team Board page draws its rows with it
 * (message_board.js) and the agent dock's Board tab will (#7922). It builds the parts a row adds to the board's own message markup (a one-button head, the actions, the day dividers), keeps the
 * choices (Table or Chat, remembered per viewer; which rows are open, kept while messages arrive and dropped when the team changes) and the controls (the Table | Chat switch, the pills). The
 * chat view is the same rows with the head hidden, so every board action, the poll, Select and Export work in both. Pure string builders and small DOM helpers: no board state in here. */
import { escapeHtml, escapeAttr } from './html_escape.js';
import { askBadge, mentionedNames } from './board_message_text.js';
import { browserLocal } from './safe_storage.js';
import { registerActions, withId, textOf } from './actions.js';

const VIEW_KEY = 'coral.board.view';
const SNIPPET_CHARS = 300;

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
function avatarColor(name) {
    let h = 0;
    for (const c of String(name || '')) h = (h * 31 + c.codePointAt(0)) >>> 0;
    return `var(--avatar-${h % 8 + 1})`;
}

/** A message's first line of words for its row: Markdown marks and links reduced to their text, one line, never more than 300 characters (the stylesheet cuts it to the row). */
export function snippetOf(content) {
    const text = String(content || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^[ \t]*\|.*$/gm, ' ') // a Markdown table's lines (the pipes and dashes are no words)
        .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, ' ')
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
        mentions: names.map(n => ({ name: n, self: n.toLowerCase() === self })),
        task: taskRefs(m && m.content)[0] || '',
        ask: !!(m && m.ask && typeof m.ask === 'object'),
        mine: names.some(n => n.toLowerCase() === self),
        replyName,
    };
}

const CHIP_FIT = 3; // up to this many marks are all drawn in the head; more are the Question badge, the first mention and a "+N" pill that names the rest

/** The marks of a message as plain data (kept on the head, so the open message and a re-read of the mentions can draw them again): { k: 'in-reply'|'mention'|'task'|'ask', t: text, self?, h?: the ask's own markup }. */
export function chipsOf(m, tags) {
    const out = [];
    if (tags.replyName) out.push({ k: 'in-reply', t: `Reply to ${tags.replyName}` });
    for (const x of tags.mentions) out.push({ k: 'mention', t: `@${x.name}`, self: x.self });
    if (tags.task) out.push({ k: 'task', t: `#${tags.task}` });
    if (tags.ask) out.push({ k: 'ask', t: 'Question', h: askBadge(m) });
    return out;
}

function chipHtml(c) {
    if (c.k === 'ask') return c.h || '';
    const cls = c.k === 'in-reply' ? 'mb-row-reply-tag' : c.k === 'mention' ? `mb-row-mention${c.self ? ' is-self' : ''}` : 'mb-row-task';
    return `<span class="chip chip-tag mb-row-tag ${cls}">${escapeHtml(c.t)}</span>`;
}

/** The marks as the head draws them (all = false): up to three as they are; more, the Question badge (always) and the first mention (else the first mark), then one "+N" pill whose title and name list the rest.
 * With all (the open message) every mark is drawn. The row's marks are never cut off by the stylesheet. */
export function layoutChips(chips, { all = false } = {}) {
    if (all || chips.length <= CHIP_FIT) return chips.map(chipHtml).join('');
    const ask = chips.find(c => c.k === 'ask');
    const first = chips.find(c => c.k === 'mention') || chips.find(c => c.k !== 'ask');
    const shown = chips.filter(c => c === ask || c === first);
    const rest = chips.filter(c => !shown.includes(c)).map(c => c.t);
    const list = rest.join(', ');
    return shown.map(chipHtml).join('') + `<span class="chip chip-tag mb-row-tag mb-row-more-tag" title="${escapeAttr(list)}" aria-label="${escapeAttr(`${rest.length} more: ${list}`)}">+${Number(rest.length)}</span>`;
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
export function dayDividerHtml(iso, { listItem = true } = {}) {
    const label = dayLabel(iso);
    return label ? `<div class="mb-day"${listItem ? ' role="listitem"' : ''} data-day="${escapeAttr(String(new Date(iso).toDateString()))}">${escapeHtml(label)}</div>` : '';
}

/** The parts only an open row has, built when it opens (a collapsed row has none: a long board is a lot of rows): the tags again at the top of the message (the phone's folded row hides them in the head), the replies' place and Reply, Copy link and More. */
function openParts(id, agent, moreLabel, more, tagHtml) {
    const replyText = `Reply to ${agent}`;
    const taskTag = /<span class="chip chip-tag mb-row-tag mb-row-task">#(\d+)<\/span>/.exec(tagHtml);
    const taskLink = taskTag ? `<button type="button" class="btn mb-row-btn mb-task-link" data-on-click="mb-task-open" data-task-id="${Number(taskTag[1])}">Open task #${Number(taskTag[1])}</button>` : '';
    return {
        tagsOpen: tagHtml ? `<div class="mb-row-tags-open">${tagHtml}</div>` : '',
        actions: `<div class="mb-row-replies" hidden></div><div class="mb-row-actions">${taskLink}<button type="button" class="btn mb-row-btn" data-on-click="mb-msg-reply" data-msg-id="${Number(id)}" data-sender="${escapeAttr(agent)}" aria-label="${escapeAttr(replyText)}">Reply</button><button type="button" class="btn mb-row-btn" data-on-click="mb-msg-copy-link" data-msg-id="${Number(id)}">Copy link</button>${more ? `<button type="button" class="btn mb-row-btn mb-row-more" data-on-click="mb-msg-more" aria-haspopup="dialog" aria-label="${escapeAttr(moreLabel)}">More</button>` : ''}</div>`,
    };
}

/** An opened row gets its open parts if it was drawn collapsed. */
function ensureOpenParts(row) {
    if (row.querySelector(':scope > .mb-row-actions')) return;
    const who = row.querySelector(':scope > .mb-row-toggle .mb-row-who');
    const tags = row.querySelector(':scope > .mb-row-toggle .mb-row-tags');
    const chips = tags && tags.dataset.chips ? JSON.parse(tags.dataset.chips) : [];
    const parts = openParts(Number(row.dataset.messageId), who ? who.getAttribute('title') || who.textContent : '', row.getAttribute('data-more') || '', row.hasAttribute('data-more'), layoutChips(chips, { all: true }));
    const body = row.querySelector(':scope > .mb-message-body');
    if (parts.tagsOpen && !row.querySelector(':scope > .mb-row-tags-open')) body?.insertAdjacentHTML('beforebegin', parts.tagsOpen);
    row.insertAdjacentHTML('beforeend', parts.actions);
}

/** What a message's row adds to the board's own markup, as strings: `toggle` (the one-button head), `tagsOpen` (the tags again at the top of the open message, for the phone's folded row), `actions` (Reply,
 * Copy link, More) and the row's classes. agent is the sender's name, timeHtml the message's <time>, moreLabel the name of its More button. */
export function rowParts(m, { agent, timeHtml, moreLabel, replyName = '', self = 'operator', more = true, idp = 'mbd' }) {
    const tags = tagsOf(m, { replyName, self });
    const open = isRowOpen(m.id);
    const snippet = snippetOf(m.content);
    const chips = chipsOf(m, tags);
    const tagHtml = layoutChips(chips, { all: true });
    const initial = Array.from(String(agent || '?'))[0] || '?';
    return {
        bodyId: `${idp}-${Number(m.id)}`, // each surface its own ids: the team page and the dock can show the same message at once
        classes: `${open ? ' mb-open' : ''}${tags.ask ? ' mb-q' : ''}${tags.mine ? ' mb-mine' : ''}${replyName ? ' mb-is-reply' : ''}`,
        toggle: `<button type="button" class="mb-row-toggle" data-on-click="mb-row-toggle" aria-expanded="${escapeAttr(String(open))}" aria-controls="${escapeAttr(idp)}-${Number(m.id)}"><span class="mb-row-chev" aria-hidden="true"></span><span class="mb-row-avatar" style="--mb-avatar:${escapeAttr(avatarColor(agent))}" aria-hidden="true">${escapeHtml(initial.toUpperCase())}</span><span class="mb-row-who" title="${escapeAttr(agent)}">${escapeHtml(agent)}</span><span class="mb-row-snippet">${escapeHtml(snippet)}</span><span class="mb-row-tags" data-chips="${escapeAttr(JSON.stringify(chips))}">${layoutChips(chips)}</span>${timeHtml}</button>`,
        tagsOpen: open ? openParts(m.id, agent, moreLabel, more, tagHtml).tagsOpen : '',
        actions: open ? openParts(m.id, agent, moreLabel, more, tagHtml).actions : '',
        attrs: more ? ` data-more="${escapeAttr(moreLabel)}"` : '', // what an opened row needs to build its actions (a collapsed row has none: a long board is a lot of rows)
    };
}

/** The members arrived after the rows were drawn (a mention names a member): each row's mention tags are read again from its message text, in place; the other tags stay. */
export function retagMentions(container, self = 'operator') {
    if (!container) return;
    for (const row of container.querySelectorAll(':scope > .mb-message[data-message-id]')) {
        const body = row.querySelector('.mb-message-body');
        if (!body) continue;
        const names = mentionedNames(body.textContent);
        row.classList.toggle('mb-mine', names.some(n => n.toLowerCase() === self));
        const head = row.querySelector(':scope > .mb-row-toggle .mb-row-tags');
        if (!head || !head.dataset.chips) continue;
        const old = JSON.parse(head.dataset.chips);
        const had = old.filter(c => c.k === 'mention').map(c => c.t).join('\n');
        if (had === names.map(n => `@${n}`).join('\n')) continue;
        const chips = [...old.filter(c => c.k === 'in-reply'), ...names.map(n => ({ k: 'mention', t: `@${n}`, self: n.toLowerCase() === self })), ...old.filter(c => c.k === 'task' || c.k === 'ask')];
        head.dataset.chips = JSON.stringify(chips);
        head.innerHTML = layoutChips(chips);
        const open = row.querySelector(':scope > .mb-row-tags-open');
        if (open) open.innerHTML = layoutChips(chips, { all: true });
    }
}

/** The server's word on the older Questions a new page answered (ask_updates: [{ id, ask }], #8200): each loaded message of those ids takes the new ask; the ones that changed are returned, so a row already on screen
 * can say so without a reload. The dashboard never works out "answered" itself. */
export function applyAskUpdates(all, updates) {
    const changed = [];
    for (const u of updates || []) {
        if (!u || !u.ask || typeof u.ask !== 'object') continue;
        const p = all.find(x => x.id === u.id);
        if (!p || JSON.stringify(p.ask) === JSON.stringify(u.ask)) continue;
        p.ask = u.ask;
        changed.push(p);
    }
    return changed;
}

/** A Question's badge says its new state on a row that is already drawn: the head's marks (and the "+N" pill's name, which lists the rest), the open message's marks and the chat header's badge. */
export function refreshAsk(row, m) {
    const head = row.querySelector(':scope > .mb-row-toggle .mb-row-tags');
    if (head && head.dataset.chips) {
        const chips = JSON.parse(head.dataset.chips).map(c => (c.k === 'ask' ? { ...c, h: askBadge(m) } : c));
        head.dataset.chips = JSON.stringify(chips);
        head.innerHTML = layoutChips(chips);
        const open = row.querySelector(':scope > .mb-row-tags-open');
        if (open) open.innerHTML = layoutChips(chips, { all: true });
    }
    const old = row.querySelector(':scope > .mb-message-header .mb-ask-badge');
    if (old) { const t = document.createElement('template'); t.innerHTML = askBadge(m); if (t.content.firstElementChild) old.replaceWith(t.content.firstElementChild); }
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
    if (want) { opened.add(String(id)); ensureOpenParts(row); fillReplies(row); } else opened.delete(String(id));
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
export function mountTableTools(host, { view, pill = 'all', onView, onPill, pills: withPills = true }) {
    let bar = host.querySelector(':scope > .mb-table-tools');
    if (bar) return bar;
    bar = document.createElement('div');
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
    sw.className = 'mb-view-switch btn-seg';
    sw.setAttribute('role', 'group');
    sw.setAttribute('aria-label', 'Board view');
    for (const [key, label] of [['table', 'Table'], ['chat', 'Chat']]) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'btn mb-view-btn'; b.dataset.view = key; b.textContent = label;
        b.setAttribute('aria-pressed', String(key === view));
        b.addEventListener('click', () => { for (const x of sw.children) x.setAttribute('aria-pressed', String(x === b)); onView(key); });
        sw.append(b);
    }
    bar.append(...(withPills ? [pills] : []), sw);
    host.append(bar);
    return bar;
}

const FOLD_BELOW_REM = 40;
const watched = new WeakSet();
/** The box folds its rows (two lines, the tags with the open message) when it is narrower than 40 rem; always when `always` (the agent dock). The class is on the box itself: mb-fold. */
export function watchFold(container, { always = false } = {}) {
    if (!container || watched.has(container)) return;
    watched.add(container);
    const set = () => {
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        container.classList.toggle('mb-fold', always || container.clientWidth < FOLD_BELOW_REM * rem);
    };
    set();
    if (typeof ResizeObserver === 'function') new ResizeObserver(set).observe(container);
}

/** The row of a message in the box that holds `from` (a row's own button, or any element inside the box). */
function rowIn(from, id) {
    const box = from.closest('.mb-messages-scroll, .board-chat-messages');
    return box ? box.querySelector(`:scope > .mb-message[data-message-id="${CSS.escape(String(id))}"]`) : null;
}

/** An opened row that starts under the sticky day line is scrolled down to 8 px below it (the line is on top of what scrolls under it, so the row's tags would be cut). */
function keepBelowDay(row) {
    const box = row.parentElement;
    if (!box) return;
    const edge = box.getBoundingClientRect().top;
    const lines = [...box.querySelectorAll(':scope > .mb-day')].filter(d => d.getBoundingClientRect().top <= edge + 1);
    const line = lines[lines.length - 1];
    const floor = (line ? line.getBoundingClientRect().bottom : edge) + 8;
    const top = row.getBoundingClientRect().top;
    if (top < floor) box.scrollTop -= floor - top;
}

/** Scroll a row into view for a jump (a search hit, a saved message, a link). A row shorter than the box is centred; an open message taller than the box starts 8 px below the sticky day line, so the sender and
 * the first lines are what is seen (centred, the middle of a long message was, with its head under the line). behavior is the page's own (smooth, or instant for reduced motion). */
export function revealRow(row, behavior = 'auto') {
    const box = row.parentElement;
    if (!box) return;
    const b = box.getBoundingClientRect(), r = row.getBoundingClientRect();
    const line = box.querySelector(':scope > .mb-day');
    const lineH = line ? line.getBoundingClientRect().height : 0;
    const tall = r.height + lineH + 16 > box.clientHeight;
    const want = tall ? (r.top - b.top) - lineH - 8 : (r.top - b.top) - (box.clientHeight - r.height) / 2;
    box.scrollTo({ top: Math.max(0, box.scrollTop + want), behavior });
}

const surfaces = [];
/** A surface that draws the table says what Reply and Copy link do in it: box is the selector of its messages box, hooks { reply(id, name), link(id) }. */
export function onRowActions(box, hooks) { surfaces.push({ box, ...hooks }); }
const surfaceOf = (el) => surfaces.find(s => el.closest(s.box));

// The head's press and a reply's jump: the same on every surface that draws the table (the team page's Board tab, the agent dock's).
registerActions({
    'mb-task-open': el => withId(el.dataset.taskId, id => surfaceOf(el)?.task(id, el)), // el: where the click was, so the Inbox opens the task in the Inbox (#8861)
    'mb-row-toggle': el => { const row = el.closest('.mb-message'); if (!row) return; toggleRow(row); if (row.classList.contains('mb-open')) keepBelowDay(row); },
    'mb-msg-reply': el => withId(el.dataset.msgId, id => { const n = textOf(el.dataset.sender), s = surfaceOf(el); if (n && s) s.reply(id, n); }),
    'mb-msg-copy-link': el => withId(el.dataset.msgId, id => surfaceOf(el)?.link(id)),
    'mb-jump-msg': el => withId(el.dataset.msgId, id => {
        const row = rowIn(el, id);
        if (!row) return;
        toggleRow(row, true);
        row.scrollIntoView({ block: 'center' });
        row.setAttribute('tabindex', '-1');
        row.focus({ preventScroll: true });
    }),
});

/** The day lines of a list drawn from a string (the dock's): the line to put before an item when its day is not the one before it. whenOf(item) is the item's first time, lastOf(prev) the previous item's last. */
export function dayLineBefore(when, prevWhen) {
    return !prevWhen || !sameDay(prevWhen, when) ? dayDividerHtml(when, { listItem: false }) : '';
}
