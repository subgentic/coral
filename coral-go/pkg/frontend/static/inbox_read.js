/* The Inbox's read marker (#9687, phase 1): which chats, boards and tasks the person has opened since they last changed, kept in this browser only (a Hub field that agrees across devices is phase 2).
 *
 *   isUnread(kind, key, stamp) -> bool      markRead(kind, key, stamp)      unreadCount(kind, rows, keyOf, stampOf) -> number      readSince() -> ms
 *
 * Read means opened: opening an item stores the stamp it had (a chat's or board's last message time, a task's updated_at); it is unread again when its stamp is newer than the stored one. An item never opened
 * is unread only if its stamp is newer than `since`, the moment this browser first used the marker: the first visit does not make every old row bold. A stamp that is not a date is read (never bold on a guess).
 * One localStorage key, { since, items: { "kind:key": ms } }, the newest MAX items kept; storage that is blocked, full or corrupt reads as empty and never throws (safe_storage.js).
 * `createReadMarker(store, now)` is the testable core; `readMarker` is the page's. */
import { browserLocal } from './safe_storage.js';

export const READ_KEY = 'coral.inbox.read.v1';
export const READ_MAX = 2000;

export function createReadMarker(store = browserLocal, now = () => Date.now()) {
    let raw = null, state = null;
    const load = () => {
        const text = store.get(READ_KEY);
        if (state && text === raw) return state;
        let v = null;
        try { v = text ? JSON.parse(text) : null; } catch { v = null; }
        if (!v || typeof v !== 'object' || !Number.isFinite(v.since) || !v.items || typeof v.items !== 'object') v = { since: now(), items: {} };
        else v = { since: v.since, items: Object.fromEntries(Object.entries(v.items).filter(([, ms]) => Number.isFinite(ms))) };
        state = v; raw = text;
        if (!text || text !== JSON.stringify(v)) save(); // the first use writes `since`; a corrupt record is replaced
        return state;
    };
    const save = () => {
        const entries = Object.entries(state.items);
        if (entries.length > READ_MAX) state.items = Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, READ_MAX)); // the oldest go
        raw = JSON.stringify(state);
        store.set(READ_KEY, raw);
    };
    const msOf = stamp => { const ms = typeof stamp === 'number' ? stamp : Date.parse(stamp); return Number.isFinite(ms) ? ms : null; };
    const idOf = (kind, key) => `${kind}:${key}`;
    return {
        isUnread(kind, key, stamp) {
            const ms = msOf(stamp);
            if (ms === null) return false;
            const s = load(), seen = s.items[idOf(kind, key)];
            return ms > (seen !== undefined ? seen : s.since);
        },
        markRead(kind, key, stamp) {
            const s = load(), id = idOf(kind, key), ms = msOf(stamp) ?? now();
            if (s.items[id] !== undefined && s.items[id] >= ms) return;
            s.items[id] = ms; save();
        },
        since() { return load().since; }, // the moment this browser began using the marker (ms)
        unreadCount(kind, rows, keyOf, stampOf) { return rows.filter(r => this.isUnread(kind, keyOf(r), stampOf(r))).length; },
    };
}

export const readMarker = createReadMarker();
export const isUnread = (...a) => readMarker.isUnread(...a);
export const markRead = (...a) => readMarker.markRead(...a);
export const unreadCount = (...a) => readMarker.unreadCount(...a);
export const readSince = () => readMarker.since();
