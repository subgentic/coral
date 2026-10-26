/* Review artifacts use the same owner-protected team list and tags routes as Artifacts.
 * After the Inbox first opens, keep its badge updated on other tabs without eager startup reads. */
import { fetchProjects } from './board_fetch.js';
import { boardFetch, isCloud, keyLabel, splitKey } from './server_base.js';

let items = [], errors = [], pending = null, lastRead = 0, revision = 0, changed = () => {};
let activated = false;
export const reviewItems = () => items;
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

/** Swap the review tag, preserving the remaining tags; keep the row on failure. */
export async function markReviewed(row) {
    const tags = [...new Set((row.tags || []).filter(t => t !== 'for review').concat('reviewed'))];
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
