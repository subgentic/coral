/* Review artifacts use the same owner-protected team list and tags routes as Artifacts.
 * After the Inbox first opens, keep its badge updated on other tabs without eager startup reads. */
import { fetchProjects } from './board_fetch.js';
import { boardFetch, isCloud, keyLabel, splitKey } from './server_base.js';

let items = [], errors = [], pending = null, lastRead = 0, revision = 0, changed = () => {};
let activated = false;
export const reviewItems = () => items;
/** A review artifact the operator has opened carries the 'read' tag (#9277): it stays in Needs you, shown as read, but it is not counted (the Inbox badge, the Needs you count). Opening it again, or marking it unread, is the same tags route. */
export const isRead = a => !!(a.tags && a.tags.includes('read'));
export const unreadReviewItems = () => items.filter(a => !isRead(a));
export const reviewErrors = () => errors;
export function onReviewsChanged(fn) { changed = fn; }

/** Ten open rows per producer across teams; a session's identity includes its server. */
export function reviewGroups(rows) {
    const groups = new Map();
    for (const row of rows) {
        const key = `${splitKey(row.team).server}:${row.session_id || row.produced_by || row.team}`;
        if (!groups.has(key)) groups.set(key, { name: row.produced_by || 'Unknown agent', rows: [], more: [] });
        const group = groups.get(key);
        (group.rows.length < 10 ? group.rows : group.more).push(row);
    }
    return [...groups.values()];
}

/** Refresh in bounded pages, coalescing feed updates. Failed teams retain their last known rows. */
export function refreshReviews(force = false) {
    if (isCloud()) return null;
    // showInbox requests a forced read; badge/feed updates alone must not start the project scan.
    if (force) activated = true;
    if (!activated) return null;
    if (pending) return force ? pending.then(() => refreshReviews(true)) : pending;
    if (!force && Date.now() - lastRead < 30000) return null;
    const started = revision;
    lastRead = Date.now();
    pending = (async () => {
        try {
            const projects = await fetchProjects(), next = [], failed = [];
            for (const { project: team } of projects) {
                try {
                    const rows = [], seen = new Set();
                    for (let offset = 0; offset <= 10000; offset += 200) {
                        const r = await boardFetch(team, `/artifacts?tag=for%20review&limit=200&offset=${offset}`);
                        if (r.status === 403 || r.status === 404) break; // inaccessible teams never contribute rows
                        if (!r.ok) throw new Error('Could not read review artifacts');
                        const data = await r.json();
                        for (const a of data.artifacts || []) {
                            if (!a.tags?.includes('for review') || !a.available || seen.has(a.id)) continue;
                            const hex = /(?:sha256:|coral:\/\/artifacts\/)?([a-f0-9]{64})$/i.exec(a.uri || a.digest || a.id || '')?.[1];
                            if (!hex) continue;
                            seen.add(a.id); rows.push({ ...a, team, hex, reviewKey: `${team}:${a.id}` });
                        }
                        if (!data.has_more || !(data.artifacts || []).length) break;
                    }
                    next.push(...rows);
                } catch {
                    next.push(...items.filter(a => a.team === team));
                    failed.push(`${keyLabel(team)} review artifacts could not be refreshed.`);
                }
            }
            if (started !== revision) return;
            items = next.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.reviewKey.localeCompare(b.reviewKey));
            errors = failed;
        } catch { errors = ['Review artifacts could not be refreshed.']; }
        changed();
    })().finally(() => { pending = null; });
    return pending;
}

/** The artifact's tags as the server has them now, read right before a write: the tags route replaces the whole list, so a tag someone added since the last refresh would be lost from the row's copy. null when it is no longer a for-review artifact. */
async function currentTags(row) {
    for (let offset = 0; offset <= 10000; offset += 200) {
        const r = await boardFetch(row.team, `/artifacts?tag=for%20review&limit=200&offset=${offset}`);
        if (!r.ok) throw new Error(`Could not read the current tags (HTTP ${r.status}).`);
        const data = await r.json(), list = data.artifacts || [];
        const hit = list.find(a => a.id === row.id);
        if (hit) return hit.tags || [];
        if (!data.has_more || !list.length) return null;
    }
    return null;
}

/** Add or remove the 'read' tag, keeping the other tags as they are now; the row stays in the list and the counts follow at once. Throws with the server's words when the save fails (the row keeps its tags). */
export async function setReviewRead(row, read) {
    const current = await currentTags(row);
    if (current === null) { revision++; items = items.filter(a => a.reviewKey !== row.reviewKey); changed(); return; } // someone settled it meanwhile: nothing to write
    const rest = current.filter(t => t !== 'read');
    const tags = read ? [...rest, 'read'] : rest;
    const r = await boardFetch(row.team, `/artifacts/${encodeURIComponent(row.id)}/tags`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags }),
    });
    if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `Could not mark ${read ? 'read' : 'unread'} (HTTP ${r.status}).`);
    }
    revision++;
    const hit = items.find(a => a.reviewKey === row.reviewKey);
    if (hit) hit.tags = tags;
    row.tags = tags;
    changed();
}

const reading = new Map(); // hex -> the write in flight, so the viewer and the preview opening the same artifact write once
/** The operator opened an artifact (the viewer, a preview, a link): when it is one of the for-review artifacts, tag it read. Any other artifact is never tagged. Resolves when it is done; rejects with the server's words. */
export function markOpenedRead(hex) {
    hex = String(hex || '').toLowerCase();
    if (!hex || isCloud()) return Promise.resolve();
    if (reading.has(hex)) return reading.get(hex);
    const p = (async () => {
        if (!activated) await refreshReviews(true); else if (pending) await pending;
        const row = items.find(a => a.hex.toLowerCase() === hex && !isRead(a));
        if (row) await setReviewRead(row, true);
    })().finally(() => reading.delete(hex));
    reading.set(hex, p);
    return p;
}

/** Swap the review tag, preserving the remaining tags (the 'read' tag goes: a reviewed artifact is settled); keep the row on failure. */
export async function markReviewed(row) {
    const current = await currentTags(row); // as the server has them now, read right before the write (the route replaces the whole list): a tag added since the last refresh is kept (#9299)
    if (current === null) { revision++; items = items.filter(a => a.reviewKey !== row.reviewKey); changed(); return; } // someone settled it meanwhile: nothing to write
    const tags = [...new Set(current.filter(t => t !== 'for review' && t !== 'read').concat('reviewed'))];
    const r = await boardFetch(row.team, `/artifacts/${encodeURIComponent(row.id)}/tags`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags }),
    });
    if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `Could not mark reviewed (HTTP ${r.status}).`);
    }
    revision++;
    items = items.filter(a => a.reviewKey !== row.reviewKey);
    changed();
}
