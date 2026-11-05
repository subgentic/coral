import { artifactRevision, artifactsUnchanged, onArtifactsRev } from './artifacts_feed.js';
import { setReviewCacheReader } from './ask_filter.js';
/* Review artifacts use the same owner-protected team list and tags routes as Artifacts.
 * After the Inbox first opens, keep its badge updated on other tabs without eager startup reads. */
import { fetchReviewProjects, sourcesKey } from './board_fetch.js';
import { boardFetch, boardArtifactPage, nextArtifactPage, keyLabel, splitKey } from './server_base.js';
import { hideAsksWhen } from './ask_filter.js';
import { importOnce } from './import_once.js';

let items = [], saved = [], muted = [], errors = [], pending = null, lastRead = 0, revision = 0, changed = () => { if (typeof document !== 'undefined') document.dispatchEvent(new Event('coral:reviews-changed')); };
let activated = false, refreshAgain = false;
const loadedRevisions = new Map();
onArtifactsRev((team, rev, reconnect) => {
    if (!activated) return;
    if (reconnect) { if (team === null) loadedRevisions.clear(); else loadedRevisions.delete(team); }
    lastRead = 0;
    if (pending) refreshAgain = true; else refreshReviews();
});
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
/** The one file a message is only a link to: `coral://artifacts/<hex>` with at most a few words of its own, else ''. */
const FILE_LINK = /coral:\/\/artifacts\/([0-9a-f]{64})/gi;
export const onlyFileLink = text => { const m = [...String(text || '').matchAll(FILE_LINK)]; return m.length === 1 && String(text).replace(FILE_LINK, '').replace(/[\s\p{P}]+/gu, '').length <= 40 ? m[0][1].toLowerCase() : ''; };
hideAsksWhen(a => { const hex = onlyFileLink(a.text); return !!hex && items.some(r => r.hex.toLowerCase() === hex); }); // the file is in Needs you once, as the file (#11998)
/** A review artifact the operator has opened carries the 'read' tag (#9277): it stays in Needs you, shown as read, but it is not counted (the Inbox badge, the Needs you count). Opening it again, or marking it unread, is the same tags route. */
/** The files the Operator saved for later (#11641): tagged 'saved', out of Needs you and its counts, listed at the top of Saved with their decisions still there. */
let savedFor = null, savedRev = -1, savedView = [];
/** The saved files, one row per file like Needs you (#11937): the newest version, with the older saved ones as `earlier`. */
export const savedFiles = () => {
    if (savedFor === saved && savedRev === revision) return savedView;
    savedView = collapseVersions(saved); savedFor = saved; savedRev = revision;
    return savedView;
};
export const isRead = a => !!(a.tags && a.tags.includes('read')) && !(a.new_comments > 0); // a read file whose Operator-started thread has agent replies not yet opened is unread again, counted once as itself (#12026)
export const unreadReviewItems = () => reviewItems().filter(a => !isRead(a));
/** The kinds of a file for review, in the words of the quiet Muted line: a count and its noun, singular and plural (#12144). */
const KIND_NOUNS = [['file', 'file for review', 'files for review'], ['done', 'finished request', 'finished requests'], ['release', 'release summary', 'release summaries'], ['decided', 'decision made for you', 'decisions made for you'], ['digest', 'daily digest', 'daily digests']];
/** "2 release summaries, 1 finished request": what the Operator's switches keep out, by kind, from the muted rows; '' for none. */
export function mutedWords(rows) {
    const by = {};
    for (const a of rows) by[a.kind || 'file'] = (by[a.kind || 'file'] || 0) + 1;
    return KIND_NOUNS.filter(([k]) => by[k]).map(([k, one, many]) => `${by[k]} ${by[k] === 1 ? one : many}`).join(', ');
}
/** The files the Operator's settings keep out of Needs you (#12144), one row per file like Needs you: in their folder and under the quiet Muted line, never counted. */
export const mutedReviewItems = () => collapseVersions(muted);
export const reviewErrors = () => errors;

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
async function readTeam(team, mutedOut = null, stamp = {}) {
    const rows = [], seen = new Set();
    for (let at = { cursor: '', offset: 0 }, pages = 0; pages < 200; pages++) { // 50 a page, by the computer's cursor (#13161)
        const r = await boardArtifactPage(team, 'for%20review', at);
        if (r.status === 403 || r.status === 404) break; // inaccessible teams never contribute rows
        if (!r.ok) throw new Error('Could not read review artifacts');
        const data = await r.json();
        const token = artifactRevision(data.artifacts_rev);
        stamp.rev = pages === 0 ? token : stamp.rev === token ? token : null;
        for (const a of data.artifacts || []) {
            if (splitKey(team).name === '~no-team' && a.board_id !== '~no-team') continue;
            const decidedWithNews = a.new_comments > 0 && (a.tags?.includes('approved') || a.tags?.includes('denied')) && !a.tags.includes('for review'); // a file the Operator decided that agents replied about in their thread: the server puts it in this list (#12097), marked and counted once
            if (!(a.tags?.includes('for review') || decidedWithNews) || a.tags.includes('saved') || a.tags.includes('ignored') || a.tags.includes('superseded') || (a.tags.includes('changes requested') && !(a.new_comments > 0)) || !a.available || seen.has(a.id)) continue; // changes requested without news is the agent's turn (needsYouFile's rule, #11985, #12026); // changes requested: the agent's turn, so the file leaves Needs you and its counts; its next version comes back as a new item (#11985). Artifacts and the goal still show it as changes requested // a saved file stays tagged for review (its decisions work) but is not in Needs you (#11641)
            const hex = /(?:sha256:|coral:\/\/artifacts\/)?([a-f0-9]{64})$/i.exec(a.uri || a.digest || a.id || '')?.[1];
            if (!hex) continue;
            seen.add(a.id);
            if (a.muted === true) { if (mutedOut) mutedOut.push({ ...a, team, hex, reviewKey: `${team}:${a.id}` }); continue; } // the Operator's settings keep this kind (or team) out of Needs you (#12144): not a row, not counted, listed under the Muted line
            rows.push({ ...a, team, hex, reviewKey: `${team}:${a.id}` });
        }
        if (!nextArtifactPage(at, data)) break;
    }
    return rows;
}
/** The rows of one team, as Needs you has them (newest version of each file): a link to one file reads only its own team (#13116), not every team. */
export async function reviewsOfTeam(team) { return collapseVersions((await readTeam(team)).sort(byAge)); }
/** The files for review on one goal of one team that nobody decided (one row per file, as Needs you has them): a goal page asks only its own team, not every team (#11913). */
export async function reviewsOfGoal(team, goalId) {
    return collapseVersions((await readTeam(team)).sort(byAge)).filter(a => String(a.goal_id) === String(goalId));
}

// Teams are read a few at a time (#13116): through the Hub each read is about a second, and eight teams one after the other were eight seconds, twice when a click came during a scan.
const SCAN_AT_ONCE = 4;
let pendingStarted = 0;
let finishedAt = 0, finishedRev = -1; // when the last whole scan finished, and the revision it was good for: a forced read soon after, with nothing settled or tagged since and the same computers, is that scan (#13489)
let lastSources = null, rescans = 0; // which computers the last scan covered, and how many times in a row it started again because the list of computers moved under it
export function refreshReviews(force = false, { reuse = false } = {}) { // reuse: a read for opening one file or link, which a scan finished in the last 30 s answers (#13489); every other forced read is a fresh one
    // showInbox requests a forced read; badge/feed updates alone must not start the project scan.
    if (force) activated = true;
    if (!activated) return null;
    // A scan in flight is joined, not queued behind (#13116): its answer is as new as one started now, unless something was settled or tagged since it began (revision moved): it will be discarded, so a second one follows.
    if (pending) return force && pendingStarted !== revision ? pending.then(() => refreshReviews(true)) : pending;
    const sources = sourcesKey();
    if (force && reuse && finishedAt && Date.now() - finishedAt < 30000 && finishedRev === revision && sources === lastSources) return Promise.resolve(); // opening a file, a link, or the Inbox again within 30 s of a finished scan reads nothing again (#13489: one click was a scan of every board, x9 for review and x7 saved)
    if (!force && Date.now() - lastRead < 30000 && sources === lastSources) return null; // the 30 s wait is for the same computers: a computer that came into the list since is read now (#13304)
    lastSources = sources;
    const started = revision;
    pendingStarted = started;
    lastRead = Date.now();
    pending = (async () => {
        try {
            const projects = await fetchReviewProjects();
            const results = new Array(projects.length);
            const readOne = async (i) => {
                const team = projects[i].project, mutedHere = [], got = { rows: [], saved: [], mutedHere, failed: '' };
                try {
                    if (!force && await artifactsUnchanged(team, loadedRevisions.get(team), splitKey(team).name === '~no-team')) {
                        results[i] = { rows: items.filter(a => a.team === team), saved: saved.filter(a => a.team === team), mutedHere: muted.filter(a => a.team === team), failed: '' };
                        return;
                    }
                    const stamp = {};
                    got.rows = await readTeam(team, mutedHere, stamp);
                    try { // the saved files of this team, every page (50 a request, #13161): a failure here leaves the others alone
                        for (let at = { cursor: '', offset: 0 }, pages = 0; pages < 200; pages++) {
                            const r = await boardArtifactPage(team, 'saved', at);
                            if (!r.ok) { loadedRevisions.delete(team); break; }
                            const data = await r.json();
                            if (pages === 0) loadedRevisions.set(team, stamp.rev === artifactRevision(data.artifacts_rev) ? stamp.rev : null);
                            for (const a of data.artifacts || []) {
                                const hex = /(?:sha256:|coral:\/\/artifacts\/)?([a-f0-9]{64})$/i.exec(a.uri || a.digest || a.id || '')?.[1];
                                if ((splitKey(team).name !== '~no-team' || a.board_id === '~no-team') && a.tags?.includes('saved') && a.tags.includes('for review') && a.available && hex) got.saved.push({ ...a, team, hex, reviewKey: `${team}:${a.id}` });
                            }
                            if (!nextArtifactPage(at, data)) break;
                        }
                    } catch { loadedRevisions.delete(team); got.saved = saved.filter(a => a.team === team); }
                } catch {
                    got.rows = items.filter(a => a.team === team);
                    got.mutedHere.push(...muted.filter(a => a.team === team));
                    got.failed = `${keyLabel(team)} review artifacts could not be refreshed.`;
                }
                results[i] = got;
            };
            let at = 0;
            await Promise.all(Array.from({ length: Math.min(SCAN_AT_ONCE, projects.length) }, async () => { while (at < projects.length) await readOne(at++); }));
            const next = [], failed = [], nextSaved = [], nextMuted = []; // joined in the teams' own order, whatever order the reads finished in
            for (const g of results) { next.push(...g.rows); nextSaved.push(...g.saved); nextMuted.push(...g.mutedHere); if (g.failed) failed.push(g.failed); }
            if (started !== revision) { loadedRevisions.clear(); return; } // discarded payloads cannot certify the retained rows as fresh
            items = next.sort(byAge); saved = nextSaved.sort(byAge); muted = nextMuted.sort(byAge);
            errors = failed;
            if (!failed.length) { finishedAt = Date.now(); finishedRev = revision; }
        } catch { errors = ['Review artifacts could not be refreshed.']; }
        changed();
    })().finally(() => {
        pending = null;
        // A changed source list needs a bounded full rescan; join a queued
        // artifact revision notification into that scan rather than start two.
        const sourcesChanged = sourcesKey() !== sources;
        if (sourcesChanged && rescans < 2) {
            rescans++; refreshAgain = false;
            refreshReviews(true).catch(() => {});
        } else {
            if (!sourcesChanged) rescans = 0;
            if (refreshAgain) { refreshAgain = false; lastRead = 0; refreshReviews(); }
        }
    });
    return pending;
}
if (typeof document !== 'undefined') document.addEventListener('coral:servers-updated', () => { if (activated) refreshReviews(); });

/** The artifact's tags as the server has them now, read right before a write: the tags route replaces the whole list, so a tag someone added since the last refresh would be lost from the row's copy. null when it is no longer a for-review artifact. */
export async function currentTags(row) {
    for (let at = { cursor: '', offset: 0 }, pages = 0; pages < 200; pages++) { // 50 a page, by the computer's cursor (#13161)
        const r = await boardArtifactPage(row.team, 'for%20review', at);
        if (!r.ok) throw new Error(`Could not read the current tags (HTTP ${r.status}).`);
        const data = await r.json(), list = data.artifacts || [];
        const hit = list.find(a => a.id === row.id);
        if (hit) return hit.tags || [];
        if (!nextArtifactPage(at, data)) return null;
    }
    return null;
}

/** Add or remove the 'read' tag, keeping the other tags as they are now; the row stays in the list and the counts follow at once. Throws with the server's words when the save fails (the row keeps its tags). */
export async function setReviewRead(row, read, { fresh = false, click = false } = {}) { // click: the Operator pressed Mark read or Mark unread (the server records it, #13609); opening a file marks it read with no click // fresh: the row's tags were read a moment ago from its own team (a file's open), so the list is not walked again before the write
    const current = fresh ? (row.tags || []) : await currentTags(row);
    if (current === null) { revision++; items = items.filter(a => a.reviewKey !== row.reviewKey); changed(); return; } // someone settled it meanwhile: nothing to write
    const rest = current.filter(t => t !== 'read');
    const tags = read ? [...rest, 'read'] : rest;
    const r = await boardFetch(row.team, `/artifacts/${encodeURIComponent(row.id)}/tags`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', ...(click ? { 'X-Coral-Click': 'read' } : {}) }, body: JSON.stringify({ tags }),
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

/** A decision put a row back (Undo of Dismiss, Move to Needs you): a read in flight took its lists before the write, so its answer is stale. Moving the revision makes that read be discarded, and the forced read that follows is a new one (#13601). */
export function reviewsChangedOnServer() { revision++; }

/** The Operator decided a review (Approve): the row is out of the list at once, and a read that was already in flight cannot put it back. */
export function settleReview(row) {
    revision++;
    const gone = new Set([row.reviewKey || `${row.team}:${row.id}`, ...earlierVersions(row).map(a => a.reviewKey)]); // the versions before it were settled with it (settleEarlierVersions)
    items = items.filter(a => !gone.has(a.reviewKey)); saved = saved.filter(a => !gone.has(a.reviewKey));
    changed();
}

let lastReadNotice = 0;
/** markOpenedRead that says so on the page when the write is refused (#12742): the sentence goes to `say` (the live region) and, at most once in ten seconds, to a visible toast, so a file that stays unread is never silent. Resolves either way. */
export function markOpenedReadVisibly(hex, say, team = '') {
    return markOpenedRead(hex, team).catch(error => {
        const text = `Could not mark the file read: ${error && error.message ? error.message : 'try again'}`;
        if (say) say(text);
        const now = Date.now();
        if (now - lastReadNotice > 10000) { lastReadNotice = now; importOnce('./utils.js').then(m => m.showToast(text, true)).catch(() => {}); }
    });
}

const reading = new Map(); // hex -> the write in flight, so the viewer and the preview opening the same artifact write once
/** The operator opened an artifact (the viewer, a preview, a link): when it is one of the for-review artifacts, tag it read. Any other artifact is never tagged. Resolves when it is done; rejects with the server's words. */
export function markOpenedRead(hex, team = '') {
    hex = String(hex || '').toLowerCase();
    if (!hex) return Promise.resolve();
    if (reading.has(hex)) return reading.get(hex);
    const p = (async () => {
        let own = null; // the file's own row, read from its own team alone when the Inbox's scan of every team has not run (a file opened through the Hub): one team's list, not nine (#13489)
        if (!activated && team) own = (await readTeam(team)).find(a => a.hex.toLowerCase() === hex) || null;
        else if (!activated) await refreshReviews(true, { reuse: true }); else if (pending) await pending;
        const row = own ? (!isRead(own) && !(own.tags || []).includes('changes requested') ? own : undefined) : items.find(a => a.hex.toLowerCase() === hex && !isRead(a) && !(a.tags || []).includes('changes requested')); // a file the Operator asked changes of waits on the agent: the viewer and the preview redraw it after the request, and that is not reading it again (#11860); it stays counted until the agent answers
        if (row) {
            if (row.new_comments > 0) { // opening the file is opening its thread: the server marks the Operator's threads seen when the comments are read (#12026), so the row is read, and the count follows
                const { listComments } = await importOnce('./artifact_comments_api.js');
                let seen = true;
                await listComments(row.hex, splitKey(row.team).server, splitKey(row.team).name).catch(() => { seen = false; });
                if (seen) { row.new_comments = 0; revision++; changed(); } // only a read that went through marks them seen on the server: a failed one leaves the marker, and it clears at the next open (Security's SHOULD on #12026)
                else if (!row.tags?.includes('for review')) return; // a decided file is in Needs you only for its news: with the news still unseen its row stays (the tag write below would drop it)
            }
            await setReviewRead(row, true, { fresh: !!own });
        }
    })().finally(() => reading.delete(hex));
    reading.set(hex, p);
    return p;
}


setReviewCacheReader(unreadReviewItems, refreshReviews);
