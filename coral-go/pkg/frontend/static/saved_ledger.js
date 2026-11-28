/* The Saved page as a calm list (#22108, the Saved mock of task #22107, in the style of the approved Needs you v19): one row per saved file or message, no buttons at rest.
 * A row: a grey kind icon; line 1 the name with the version in brackets; line 2 the team and the goal (links), then the start of the text, cut at the edge. At the right, in columns: a star if
 * starred, the status as a tag, the agent as an icon, the time it was saved. With the pointer on a row or the keyboard in it, Remove from Saved, Star or Remove star and More take the right side's
 * place. On a phone every row has a 44x44 "..." menu with all of that and Open; line 2 is the agent and the team, and the text, the agent icon and the time are left out.
 * Approve and Request changes are not on the row: the verdict is given in the file (the Operator's rule for Needs you). Pure drawing: the Inbox (inbox_sidebar.js) builds the rows' facts and actions.
 * Every string shown is text (textContent): names and words are what an agent wrote. */
import { loadStyles } from './lazy_styles.js';
await loadStyles('saved_ledger.css');

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const icon = (name, cls = '') => { const i = el('span', `material-icons ${cls}`.trim(), name); i.setAttribute('aria-hidden', 'true'); return i; };
const linkButton = (text, label, run, cls = '') => { const b = el('button', `sl-link ${cls}`.trim(), text); b.type = 'button'; b.setAttribute('aria-label', label); b.addEventListener('click', e => { e.stopPropagation(); run(); }); return b; };
const AVATARS = ['sl-av-1', 'sl-av-2', 'sl-av-3', 'sl-av-4', 'sl-av-5', 'sl-av-6', 'sl-av-7', 'sl-av-8'];
/** A file's kind as a grey glyph (the mock: a page, a picture, code, a web page); a document is a page. */
const fileGlyph = (media = '', name = '') => /^image\//.test(media) ? 'image' : /html/.test(media) || /\.html?$/i.test(name) ? 'web' : /json|javascript|x-|yaml|xml|csv/.test(media) || /\.(js|ts|go|py|json|ya?ml|sh|css|sql|rs|java|c|h|csv)$/i.test(name) ? 'code' : 'description';
const dot = () => { const s = el('span', 'sl-sep', '·'); s.setAttribute('aria-hidden', 'true'); return s; };

/** The agent as a round icon with its first letter; its name is the title and the spoken name. */
function avatar(name) {
    const a = el('span', 'sl-avatar', (String(name || '?').trim()[0] || '?').toUpperCase());
    a.setAttribute('role', 'img'); a.setAttribute('aria-label', name || 'Unknown agent'); a.title = name || '';
    let h = 0; for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    a.classList.add(AVATARS[h % AVATARS.length]); // the table avatar's eight colours (variables.css)
    return a;
}

/** One row. r: { key, kind: 'file'|'message', name, version, team: { text, open }, goal: { text, open } | null, agent: { text, open? }, text, starred, tag: { text, tone } | null, time,
 *  media (a file's media type, for its icon), label (the spoken name, when it is not the name), open(), remove: { label, run } | null, star: { on, run } | null, more: [{ label, title?, danger?, run }] }. x: { phone, moreMenu(items, label) } (a wider touch screen gets the phone's menu). */
function row(r, x) {
    const li = el('li', `list-row sl-row sl-${r.kind}`); li.dataset.key = r.key; // the list row's look (layout.css): its hover and focus ring
    li.append(icon(r.kind === 'file' ? fileGlyph(r.media, r.name) : 'chat_bubble_outline', 'sl-icon'));
    const main = el('div', 'sl-main'), one = el('div', 'sl-line1'), two = el('div', 'sl-line2');
    const name = el('button', 'sl-name', r.name); name.type = 'button'; const said = r.label || r.name; name.setAttribute('aria-label', `Open ${said}${r.version ? `, version ${r.version}` : ''}`); // a message is spoken by its whole words, numbered apart when two start alike (#6541)
    name.addEventListener('click', e => { e.stopPropagation(); r.open(); });
    one.append(name); if (r.version) one.append(el('span', 'sl-ver', `(version ${r.version})`));
    const parts = [];
    if (x.phone && r.agent?.text) parts.push(el('span', 'sl-agent-name', r.agent.text)); // a phone: line 2 is words, not 20 px targets; the row and its "..." are the targets (44 px, phone_targets)
    if (r.team?.text) parts.push(r.team.open && !x.phone ? linkButton(r.team.text, `Open team ${r.team.text}`, r.team.open) : el('span', 'sl-team', r.team.text));
    if (!x.phone && r.goal) { const g = linkButton('', `Open goal ${r.goal.text}`, r.goal.open, 'sl-goal'); g.append(icon('flag', 'sl-flag'), document.createTextNode(r.goal.text)); parts.push(g); }
    if (!x.phone && r.text) parts.push(el('span', 'sl-text', r.text));
    parts.forEach((p, i) => { if (i) two.append(dot()); two.append(p); });
    main.append(one); if (parts.length) main.append(two);
    li.append(main);
    const right = el('div', 'sl-right');
    const star = el('span', 'sl-col sl-star'); if (r.starred) { const s = icon('star', 'sl-star-on'); s.removeAttribute('aria-hidden'); s.setAttribute('role', 'img'); s.setAttribute('aria-label', 'Starred'); star.append(s); }
    const tag = el('span', 'sl-col sl-tagcol'); if (r.tag) { const t = el('span', `chip chip-tag sl-tag sl-tag-${r.tag.tone || 'grey'}`, r.tag.text); tag.append(t); }
    right.append(star, tag);
    if (!x.phone) { const who = el('span', 'sl-col sl-who'); if (r.agent?.text) who.append(avatar(r.agent.text)); right.append(who, el('span', 'sl-col sl-time', r.time || '')); }
    li.append(right);
    const items = [];
    if (r.remove) items.push({ label: r.remove.label || 'Remove from Saved', title: r.remove.title, run: r.remove.run });
    if (r.star) items.push({ label: r.star.on ? 'Remove star' : 'Star', run: r.star.run });
    if (x.phone || x.touch) { // a phone, or a touch screen with no hover: every action in the row's "..." menu, beside the right side
        const acts = el('div', 'sl-actions sl-actions-phone');
        acts.append(x.moreMenu([{ label: 'Open', run: () => r.open() }, ...items, ...r.more], said, 'dots')); // the dots, on a phone and a wider touch screen alike
        li.append(acts);
    } else if (items.length || r.more.length) {
        const acts = el('div', 'sl-actions');
        for (const it of items) { const b = el('button', 'btn btn-small sl-act', it.label); b.type = 'button'; b.setAttribute('aria-label', `${it.label}: ${said}`); if (it.title) b.title = it.title; b.addEventListener('click', e => { e.stopPropagation(); it.run(b); }); acts.append(b); }
        if (r.more.length) acts.append(x.moreMenu(r.more, said, 'button')); // an outlined More with its arrow, like the buttons beside it (the mock)
        li.append(acts);
    }
    li.addEventListener('click', e => { if (e.target.closest('button, a, .menu')) return; r.open(); }); // a click anywhere on the row opens it; its own controls do their own thing
    return li;
}

/** Fill host with the rows, in the order given. */
export function fillSavedLedger(host, rows, x) {
    const list = el('ul', `saved-ledger${x.phone ? ' saved-ledger-phone' : ''}`); list.setAttribute('aria-label', `Saved, ${rows.length}`);
    const touch = !x.phone && typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
    for (const r of rows) list.append(row(r, { ...x, touch }));
    host.replaceChildren(list);
}
