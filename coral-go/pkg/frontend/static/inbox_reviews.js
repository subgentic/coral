/* Review artifacts use the same owner-protected team list and tags routes as Artifacts.
 * After the Inbox first opens, keep its badge updated on other tabs without eager startup reads. */
import { fetchProjects } from './board_fetch.js';
import { boardFetch, keyLabel, splitKey } from './server_base.js';

let items = [], saved = [], errors = [], pending = null, lastRead = 0, revision = 0, changed = () => {};
let activated = false;
// One row per artifact (#11533): versions (same uploader, team, name) are one item, the newest, with `earlier`.
const vkey = a => (a.session_id || a.produced_by) ? JSON.stringify([a.team, a.session_id, a.produced_by, a.name]) : a.reviewKey; // a JSON array: no name or id can run into the next field
const byAge = (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.reviewKey.localeCompare(b.reviewKey);
/** The versions older than `row`, still for review. */
export const earlierVersions = row => { const key = row.reviewKey || `${row.team}:${row.id}`, pool = saved.some(a => a.reviewKey === key) ? saved : items, me = pool.find(a => a.reviewKey === key) || row; return pool.filter(a => a.reviewKey !== key && vkey(a) === vkey(me) && byAge(a, me) < 0); }; // in the list the row is in: Needs you's, or Saved's (#11937)
// Worked out once per change, not once per call (#11633): this is asked for by the badge, the folder count, the pills, the rows and the labels on every update, and the old way compared every item with every other
// (a JSON key built for each pair): with a few hundred files for review one call took a tenth of a second, a few dozen calls a redraw, and an Approve (which redraws three times) froze the Inbox for seconds.
// The list is rebuilt when `items` is replaced or `revision` moves (a tag written in place, a row settled), and shared between callers in between.
let viewFor = null, viewRev = -1, view = [];
/** One row per artifact: the newest version of each series, with the older ones still for review as `earlier` (the same as reviewItems, for any list). */
function collapseVersions(list) {
    const groups = new Map(); // series key -> its versions, oldest first (items are sorted by age)
    for (const a of list) { const k = vkey(a); if (groups.has(k)) groups.get(k).push(a); else groups.set(k, [a]); }
    const newest = new Map(); // the newest version of each series -> the versions before it
    for (const group of groups.values()) { const top = group.reduce((m, b) => (byAge(m, b) < 0 ? b : m)); newest.set(top, group.filter(b => b !== top && byAge(b, top) < 0)); }
    return list.filter(a => newest.has(a)).map(a => (newest.get(a).length ? { ...a, earlier: newest.get(a) } : a)); // the list's own order: oldest newest-version first
}
export const reviewItems = () => {
    if (viewFor === items && viewRev === revision) return view;
    view = collapseVersions(items);
    viewFor = items; viewRev = revision;
    return view;
};
/** A review artifact the operator has opened carries the 'read' tag (#9277): it stays in Needs you, shown as read, but it is not counted (the Inbox badge, the Needs you count). Opening it again, or marking it unread, is the same tags route. */
/** The files the Operator saved for later (#11641): tagged 'saved', out of Needs you and its counts, listed at the top of Saved with their decisions still there. */
let savedFor = null, savedRev = -1, savedView = [];
/** The saved files, one row per file like Needs you (#11937): the newest version, with the older saved ones as `earlier`. */
export const savedFiles = () => {
    if (savedFor === saved && savedRev === revision) return savedView;
    savedView = collapseVersions(saved); savedFor = saved; savedRev = revision;
    return savedView;
};
export const isRead = a => !!(a.tags && a.tags.includes('read'));
export const unreadReviewItems = () => reviewItems().filter(a => !isRead(a));
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
/** One team's files tagged for review (not saved, available), every page: the rows the Inbox reads, for one team. */
async function readTeam(team) {
    const rows = [], seen = new Set();
    for (let offset = 0; offset <= 10000; offset += 200) {
        const r = await boardFetch(team, `/artifacts?tag=for%20review&limit=200&offset=${offset}`);
        if (r.status === 403 || r.status === 404) break; // inaccessible teams never contribute rows
        if (!r.ok) throw new Error('Could not read review artifacts');
        const data = await r.json();
        for (const a of data.artifacts || []) {
            if (!a.tags?.includes('for review') || a.tags.includes('saved') || !a.available || seen.has(a.id)) continue; // a saved file stays tagged for review (its decisions work) but is not in Needs you (#11641)
            const hex = /(?:sha256:|coral:\/\/artifacts\/)?([a-f0-9]{64})$/i.exec(a.uri || a.digest || a.id || '')?.[1];
            if (!hex) continue;
            seen.add(a.id); rows.push({ ...a, team, hex, reviewKey: `${team}:${a.id}` });
        }
        if (!data.has_more || !(data.artifacts || []).length) break;
    }
    return rows;
}
/** The files for review on one goal of one team that nobody decided (one row per file, as Needs you has them): a goal page asks only its own team, not every team (#11913). */
export async function reviewsOfGoal(team, goalId) {
    return collapseVersions((await readTeam(team)).sort(byAge)).filter(a => String(a.goal_id) === String(goalId));
}

export function refreshReviews(force = false) {
    // showInbox requests a forced read; badge/feed updates alone must not start the project scan.
    if (force) activated = true;
    if (!activated) return null;
    if (pending) return force ? pending.then(() => refreshReviews(true)) : pending;
    if (!force && Date.now() - lastRead < 30000) return null;
    const started = revision;
    lastRead = Date.now();
    pending = (async () => {
        try {
            const projects = await fetchProjects(), next = [], failed = [], nextSaved = [];
            for (const { project: team } of projects) {
                try {
                    const rows = await readTeam(team);
                    next.push(...rows);
                    try { // the saved files of this team: one page, a failure here leaves the others alone
                        const r = await boardFetch(team, '/artifacts?tag=saved&limit=200');
                        if (r.ok) for (const a of (await r.json()).artifacts || []) {
                            const hex = /(?:sha256:|coral:\/\/artifacts\/)?([a-f0-9]{64})$/i.exec(a.uri || a.digest || a.id || '')?.[1];
                            if (a.tags?.includes('saved') && a.tags.includes('for review') && a.available && hex) nextSaved.push({ ...a, team, hex, reviewKey: `${team}:${a.id}` });
                        }
                    } catch { nextSaved.push(...saved.filter(a => a.team === team)); }
                } catch {
                    next.push(...items.filter(a => a.team === team));
                    failed.push(`${keyLabel(team)} review artifacts could not be refreshed.`);
                }
            }
            if (started !== revision) return;
            items = next.sort(byAge); saved = nextSaved.sort(byAge);
            errors = failed;
        } catch { errors = ['Review artifacts could not be refreshed.']; }
        changed();
    })().finally(() => { pending = null; });
    return pending;
}

/** The artifact's tags as the server has them now, read right before a write: the tags route replaces the whole list, so a tag someone added since the last refresh would be lost from the row's copy. null when it is no longer a for-review artifact. */
export async function currentTags(row) {
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

/** The Operator decided a review (Approve): the row is out of the list at once, and a read that was already in flight cannot put it back. */
export function settleReview(row) {
    revision++;
    const gone = new Set([row.reviewKey || `${row.team}:${row.id}`, ...earlierVersions(row).map(a => a.reviewKey)]); // the versions before it were settled with it (settleEarlierVersions)
    items = items.filter(a => !gone.has(a.reviewKey)); saved = saved.filter(a => !gone.has(a.reviewKey));
    changed();
}

const reading = new Map(); // hex -> the write in flight, so the viewer and the preview opening the same artifact write once
/** The operator opened an artifact (the viewer, a preview, a link): when it is one of the for-review artifacts, tag it read. Any other artifact is never tagged. Resolves when it is done; rejects with the server's words. */
export function markOpenedRead(hex) {
    hex = String(hex || '').toLowerCase();
    if (!hex) return Promise.resolve();
    if (reading.has(hex)) return reading.get(hex);
    const p = (async () => {
        if (!activated) await refreshReviews(true); else if (pending) await pending;
        const row = items.find(a => a.hex.toLowerCase() === hex && !isRead(a) && !(a.tags || []).includes('changes requested')); // a file the Operator asked changes of waits on the agent: the viewer and the preview redraw it after the request, and that is not reading it again (#11860); it stays counted until the agent answers
        if (row) await setReviewRead(row, true);
    })().finally(() => reading.delete(hex));
    reading.set(hex, p);
    return p;
}

