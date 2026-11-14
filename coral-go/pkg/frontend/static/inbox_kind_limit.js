// Needs you's kind groups show their five oldest rows with Show more, and Read all marks a group read in place (#16814). Loaded the first time Needs you has more than five rows, so none of it is at start:
// inbox_sidebar.js passes what it owns (the group list, a row's kind, the mark-read path) and gets back the group wrapper and the oldest-first order.
import { el } from './data_table.js';
import { identityKey, splitKey, decisionNeedsPerson } from './server_base.js';
import { isGoalDoneRead, markGoalDoneRead } from './goal_done.js';
import { importOnce } from './import_once.js';
const { isRead, setReviewRead } = await importOnce('./inbox_reviews.js');
const { waitingOnAgent } = await importOnce('./inbox_review_state.js');
const teamOf = g => { const k = splitKey(g.board_id); return k.name ? identityKey(k.server, k.name) : ''; };
const isUnread = s => (s.goalDone ? !isGoalDoneRead(teamOf(s.goalDone), s.goalDone) : !!s.review && !decisionNeedsPerson(splitKey(s.review.team).server) && !isRead(s.review));
const mark = s => (s.goalDone ? markGoalDoneRead(teamOf(s.goalDone), s.goalDone) : setReviewRead(s.review, true, { click: true }));
export const KIND_LIMIT = 5;
export function makeKindLimit(env) {
    const open = new Set(); // the groups whose rest is shown
    const at = s => Date.parse(s.waiting_since) || Infinity;
    const kindOf = s => (s.welcome || s.review?.starred || (s.review && waitingOnAgent(s.review)) ? -1 : env.index(s));
    /** A kind group longer than the limit reads oldest first (so the five it shows are the five oldest); shorter ones keep their order. */
    const oldest = list => {
        const out = [...list];
        for (const i of [0, 1, 2]) { const idx = out.map((s, n) => (kindOf(s) === i ? n : -1)).filter(n => n >= 0); if (idx.length > KIND_LIMIT) [...idx.map(n => out[n])].sort((a, b) => at(a) - at(b)).forEach((s, k) => { out[idx[k]] = s; }); }
        return out;
    };
    /** Read all N: mark the group's unread rows read in place, only through the existing mark-read path. */
    const readAll = async rows => {
        for (const s of rows.filter(isUnread)) { try { await mark(s); } catch (e) { /* the row stays unread and is counted again by the heading */ } }
        env.sync(); env.redraw();
    };
    const seen = new Map(); // rows drawn so far in a group, given back at the group's foot
    const limited = (g, rows) => {
        const members = () => rows.filter(s => kindOf(s) >= 0 && env.groups[kindOf(s)] === g), shown = open.has(g.key);
        const toggle = total => { const b = el('button', 'btn btn-quiet btn-small inbox-group-more', shown ? 'Show fewer' : `Show ${total - KIND_LIMIT} more`); b.type = 'button'; b.dataset.groupMore = g.key; b.setAttribute('aria-expanded', String(shown)); b.setAttribute('aria-label', shown ? `Show fewer in ${g.label}` : `Show ${total - KIND_LIMIT} more in ${g.label}`); b.addEventListener('click', e => { e.stopPropagation(); if (shown) open.delete(g.key); else open.add(g.key); env.redraw(); }); return b; };
        return { ...g, // data_table.js asks: skip(row) for each row, headExtra() once in the heading, foot() after the group's last row (the node data_table.js puts in a row of its own)
            skip: () => { const n = seen.get(g.key) || 0; seen.set(g.key, n + 1); return !shown && n >= KIND_LIMIT; },
            headExtra: () => { const all = members(), unread = all.filter(isUnread).length, box = el('span', 'inbox-group-extra'); box.append(el('span', 'inbox-group-count', String(all.length)));
                if (unread) { const b = el('button', 'btn btn-quiet btn-small inbox-group-read', `Read all ${unread}`); b.type = 'button'; b.dataset.groupRead = g.key; b.setAttribute('aria-label', `Mark all ${unread} unread in ${g.label} as read`); b.addEventListener('click', e => { e.stopPropagation(); b.disabled = true; readAll(all); }); box.append(b); }
                if (shown && all.length > KIND_LIMIT) box.append(toggle(all.length));
                return box; },
            foot: () => { seen.delete(g.key); const total = members().length; return total <= KIND_LIMIT || shown ? null : toggle(total); } }; // shown: Show fewer is in the heading
    };
    return { oldest, limited, open };
}
