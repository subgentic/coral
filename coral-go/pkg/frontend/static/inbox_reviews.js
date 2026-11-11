import { artifactRevision, artifactsUnchanged, onArtifactsRev } from './artifacts_feed.js';
import { setReviewCacheReader } from './ask_filter.js';
/* Review artifacts use the same owner-protected team list and tags routes as Artifacts.
 * After the Inbox first opens, keep its badge updated on other tabs without eager startup reads. */
import { nativeSavedSourceAllowed } from './server_status.js';
import { sourcesKey } from './board_fetch.js';
import { inboxSources, serverLabel, isOwnerOnlyAnswer } from './inbox_servers.js';
import { boardFetch, nextArtifactPage, splitKey, serverFetch, identityKey, noteBoardLabels, normServer, isCloud, nativeSaved } from './server_base.js';
import { SORT_PARAM } from './filter_model.js';
import { fetchSkewed } from './query_skew.js';
import { hideAsksWhen } from './ask_filter.js';
import { importOnce } from './import_once.js';
const { createReviewPages } = await importOnce('./review_pages.js');
const { needsReviewAttention, hasNewVersion, waitingOnAgent } = await importOnce('./inbox_review_state.js');

let items = [], saved = [], muted = [], errors = [], pending = null, lastRead = 0, revision = 0, changed = (detail = null) => { if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('coral:reviews-changed', { detail })); };
let savedActivated = false;
export function activateSavedReviews() {
    if (savedActivated) return pending || Promise.resolve();
    savedActivated = true;
    return pending ? pending.then(() => refreshReviews(true)) : refreshReviews(true);
}
let activated = false, refreshAgain = false, freshnessDirty = false;
onArtifactsRev(() => {
    if (!activated) return;
    freshnessDirty = true;
    lastRead = 0;
    if (pending) refreshAgain = true; else refreshReviews();
});
// One row per artifact (#11533): versions (same uploader, team, name) are one item, the newest, with `earlier`.
const vkey = a => a.series_id ? JSON.stringify([a.team, 'series', a.series_id]) : (a.session_id || a.produced_by) ? JSON.stringify([a.team, a.session_id, a.produced_by, a.name]) : a.reviewKey; // a JSON array: no name or id can run into the next field
const UNKNOWN_AGENT = 'Unknown agent';
const byAge = (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.reviewKey.localeCompare(b.reviewKey);
/** The versions older than `row`, still for review. */
export const earlierVersions = row => {
    const key = row.reviewKey || `${row.team}:${row.id}`, pool = saved.some(a => a.reviewKey === key) ? saved : items, me = pool.find(a => a.reviewKey === key) || row;
    const older = new Map(pool.filter(a => a.reviewKey !== key && vkey(a) === vkey(me) && byAge(a, me) < 0).map(a => [a.hex, a]));
    // Starred-first returns only the newest row; its authoritative older ids
    // preserve the existing decision cleanup without fetching every version.
    for (const hex of me.earlier_digests || []) if (/^[a-f0-9]{64}$/.test(hex) && hex !== me.hex && !older.has(hex)) older.set(hex, { ...me, id: hex, hex, version: 0, reviewKey: `${me.team}:${hex}`, earlier: undefined, earlier_digests: undefined });
    return [...older.values()];
};
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
    return list.filter(a => newest.has(a)).map(a => {
        const older = new Map(newest.get(a).map(row => [row.hex, row]));
        // A bounded newest-version page carries authoritative older digests rather than those rows.
        // Keep that history on the collapsed row too, including Saved's sender/version line.
        for (const hex of a.earlier_digests || []) if (/^[a-f0-9]{64}$/.test(hex) && hex !== a.hex && !older.has(hex)) older.set(hex, { ...a, id: hex, hex, version: 0, reviewKey: `${a.team}:${hex}`, earlier: undefined, earlier_digests: undefined });
        if (!older.size) return a;
        const n = older.size + 1, line = typeof a.version_line === 'string' && !a.series_id ? a.version_line.replace(/^version (\d+)/, (w, v) => (Number(v) < n ? `version ${n}` : w)) : a.version_line; // a file sent again by name, with no series, is version 2, 3 ... of the rows this one stands for, not 'version 1' every time (#15285)
        return { ...a, earlier: [...older.values()], ...(line !== undefined ? { version_line: line } : {}) };
    }); // the list's own order: oldest newest-version first
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
const linkedReviews = new Set();
const askReviewKey = a => { const hex = onlyFileLink(a.text); return hex && typeof a.board === 'string' && !a.board.startsWith('@') && !a.board.includes('/') ? `${identityKey(a.server, a.board)}:${hex}` : ''; };
hideAsksWhen(a => { const key = askReviewKey(a); return !!key && (linkedReviews.has(key) || items.some(r => r.reviewKey === key)); }, async asks => {
    if (!activated) return;
    const started = revision, groups = new Map(), found = new Set();
    for (const ask of asks) {
        const hex = onlyFileLink(ask.text);
        if (!hex || typeof ask.board !== 'string' || ask.board.startsWith('@') || ask.board.includes('/')) continue;
        const team = identityKey(ask.server, ask.board);
        if (!groups.has(team)) groups.set(team, new Set());
        groups.get(team).add(hex);
    }
    for (const [team, digests] of groups) {
        const source = splitKey(team), ids = [...digests];
        for (let offset = 0; offset < ids.length; offset += 20) {
            const batch = ids.slice(offset, offset + 20), query = new URLSearchParams({ team: source.name, digest: batch.join(','), tag: 'for review' }).toString();
            try {
                const data = await readComputerPage(source.server, { query, limit: 50 });
                if (data.has_more || data.artifacts.some(a => a.team !== team || !batch.includes(a.hex))) continue;
                for (const row of data.artifacts) if (row.available && !row.muted && !['saved', 'ignored', 'superseded'].some(tag => row.tags?.includes(tag))) found.add(row.reviewKey);
            } catch { /* Keep an unverified question visible. */ }
        }
    }
    if (started !== revision) return;
    linkedReviews.clear(); for (const key of found) linkedReviews.add(key);
});
/** A review artifact the operator has opened carries the 'read' tag (#9277): it stays in Needs you, shown as read, but it is not counted (the Inbox badge, the Needs you count). Opening it again, or marking it unread, is the same tags route. */
/** The files the Operator saved for later (#11641): tagged 'saved', out of Needs you and its counts, listed at the top of Saved with their decisions still there. */
let savedFor = null, savedRev = -1, savedView = [];
/** The saved files, one row per file like Needs you (#11937): the newest version, with the older saved ones as `earlier`. */
export const savedFiles = () => {
    const permitted = rows => isCloud() && nativeSaved() ? rows.filter(row => nativeSavedSourceAllowed(splitKey(row.team).server)) : rows;
    if (savedFor === saved && savedRev === revision) return permitted(savedView);
    savedView = collapseVersions(saved); savedFor = saved; savedRev = revision;
    return permitted(savedView);
};
export const isRead = a => !!(a.tags && a.tags.includes('read')) && !(a.new_comments > 0) && !hasNewVersion(a); // a read file whose Operator-started thread has agent replies not yet opened is unread again, counted once as itself (#12026)
export const unreadReviewItems = () => reviewItems().filter(needsReviewAttention);
/** Reflect an acknowledged server write across cached versions, including collapsed copies. */
export function reviewStarChanged(row, on) {
    const key = vkey(row);
    for (const a of [...items, ...saved, ...muted]) if (vkey(a) === key) a.starred = on;
    row.starred = on; revision++;
}

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
        if (!groups.has(key)) groups.set(key, { name: row.produced_by || UNKNOWN_AGENT, rows: [], more: [] });
        const group = groups.get(key);
        (group.rows.length < 10 ? group.rows : group.more).push(row);
    }
    return [...groups.values()];
}

/** Refresh in bounded pages, coalescing feed updates. Failed teams retain their last known rows. */
/** One artifact of a team's for-review list as a Needs you row, or null when it is not one (not waiting, saved, ignored, superseded, not available, seen already) or is muted (then it goes to mutedOut). */
function reviewRowOf(a, team, seen, mutedOut = null) {
    if (splitKey(team).name === '~no-team' && a.board_id !== '~no-team') return null; // the No team list also holds files of teams with a board: only the ones with no board are its own
    const decidedWithNews = a.new_comments > 0 && (a.tags?.includes('approved') || a.tags?.includes('denied')) && !a.tags.includes('for review'); // a file the Operator decided that agents replied about in their thread: the server puts it in this list (#12097), marked and counted once
    if (!(a.tags?.includes('for review') || decidedWithNews) || a.tags.includes('saved') || a.tags.includes('ignored') || a.tags.includes('superseded') || !a.available || seen.has(a.id)) return null; // changes requested without news is the agent's turn (needsYouFile's rule, #11985, #12026)
    const hex = /(?:sha256:|coral:\/\/artifacts\/)?([a-f0-9]{64})$/i.exec(a.uri || a.digest || a.id || '')?.[1];
    if (!hex) return null;
    seen.add(a.id);
    if (a.muted === true) { if (mutedOut) mutedOut.push({ ...a, team, hex, reviewKey: `${team}:${a.id}` }); return null; } // the Operator's settings keep this kind (or team) out of Needs you (#12144): not a row, not counted, listed under the Muted line
    return { ...a, team, hex, reviewKey: `${team}:${a.id}` };
}
/** One team's files tagged for review (not saved, available), every page: the rows the Inbox reads, for one team. */
async function readTeam(team, mutedOut = null, stamp = {}) {
    const rows = [], seen = new Set();
    for (let at = { cursor: '', offset: 0 }, pages = 0; pages < 200; pages++) { // 50 a page, by the computer's cursor (#13161)
        const key = splitKey(team), query = new URLSearchParams({ team: key.name, tag: 'for review', starred_first: 'true', limit: '50', ...(at.cursor ? { cursor: at.cursor } : at.offset ? { offset: String(at.offset) } : {}) });
        const { response: r } = await fetchSkewed(key.server, '/api/team-artifacts', query); // a computer on an older release is asked again without the keys it refuses (#14317)
        if (r.status === 403 && await isOwnerOnlyAnswer(r)) break; // owner-only lists never fall back to a less private board route; any other 403 is an error, not an empty list
        if (!r.ok) throw new Error('Could not read review artifacts');
        const data = await r.json();
        if (!Array.isArray(data.artifacts)) throw new Error('Review documents could not be read.');
        if (data.partial || data.failed_boards?.length) throw new Error('Some review documents could not be read.');
        const token = artifactRevision(data.artifacts_rev);
        stamp.rev = pages === 0 ? token : stamp.rev === token ? token : null;
        for (const a of data.artifacts || []) {
            const row = reviewRowOf(a, team, seen, mutedOut);
            if (row) rows.push(row);
        }
        if (!nextArtifactPage(at, data)) break;
        if (pages === 199) throw new Error('Review documents exceed the scan limit; the list is incomplete.');
    }
    return rows;
}

// Filtered and unfiltered windows use the same protected per-computer reader.
let fview = null;
const settledAt = new Map();
const viewParts = f => ({ q: f.q || '', team: f.team || '', agent: f.agent || '', goal: f.goal || '', longer: f.longer || '', server: f.server || '', oldest: f.sort === 'oldest' });
export const reviewQueryKey = f => { const v = viewParts(f); return (v.q || v.team || v.agent || v.goal || v.longer || v.server || v.oldest) ? JSON.stringify(v) : ''; };
/** Choices describe all server matches, including files beyond the loaded rows. */
export function reviewFilterOptions() {
    const pages = fview ? fview.pager.status() : reviewPages();
    const teams = new Set(), agents = new Set(), goals = new Map();
    for (const source of pages) {
        const facets = source.facets || {};
        for (const f of facets.team || []) if (typeof f.v === 'string' && f.v) teams.add(f.v);
        for (const f of facets.by || []) if (typeof f.v === 'string' && f.v) agents.add(f.v);
        for (const f of facets.goal || []) if (typeof f.v === 'string' && f.v && Number.isSafeInteger(f.id) && f.id > 0) {
            const value = `${f.v} (#${f.id} · ${serverLabel(source.server)})`;
            goals.set(value, { value, title: f.v, server: source.server, id: f.id });
        }
    }
    return { teams: [...teams].sort(), agents: [...agents].sort(), goals: [...goals.values()].sort((a, b) => a.value.localeCompare(b.value)) };
}
const resolveGoalFilter = value => {
    const choices = reviewFilterOptions().goals, exact = choices.find(g => g.value === value);
    if (exact) return exact;
    const named = choices.filter(g => g.title === value);
    return named.length === 1 ? named[0] : null;
};
export function reviewQueryParams(f, now = Date.now()) {
    const v = viewParts(f), p = new URLSearchParams({ tag: 'for review', limit: '50', versions: 'newest', starred_first: 'true', facets: 'team,by,goal' });
    if (v.q) p.set('q', v.q);
    if (v.team) p.set('team', v.team);
    const goal = resolveGoalFilter(v.goal);
    if (goal) p.set('goal', String(goal.id));
    if (v.agent && v.agent !== UNKNOWN_AGENT) p.set('by', v.agent);
    if (v.longer) p.set('until', new Date(now - Number(v.longer) * 60000).toISOString());
    if (v.oldest) p.set(SORT_PARAM, 'oldest');
    return p;
}
const filterRows = mine => mine.pager.snapshot().flatMap(s => s.artifacts).filter(a => {
    const tags = a.tags || [];
    return (mine.filters.agent !== UNKNOWN_AGENT || !a.produced_by) && (!mine.filters.goal || mine.goal || (a.goal_title || 'No goal') === mine.filters.goal) && a.available && !a.muted && !tags.includes('saved') && !tags.includes('ignored') && !tags.includes('superseded') && !(settledAt.get(a.reviewKey) > mine.started);
});
export const queriedReviews = f => fview && fview.key === reviewQueryKey(f) ? filterRows(fview) : null;
export const reviewQueryState = () => {
    if (!fview) return null;
    const pages = fview.pager.status(), rows = filterRows(fview);
    const hasSources = pages.length > 0 || fview.emptyScope;
    const completeWindow = hasSources && !fview.invalidCounts && pages.every(p => p.loaded && !p.error && !p.has_more && !p.truncated && p.total === p.loadedCount);
    const known = hasSources && !fview.localFilters && !fview.invalidCounts && pages.every(p => p.loaded && !p.error && !p.truncated && Number.isSafeInteger(p.total));
    const attentionKnown = hasSources && !fview.localFilters && !fview.invalidCounts && pages.every(p => Number.isSafeInteger(p.attentionTotal) && !p.error && !p.truncated);
    return { total: fview.localFilters ? completeWindow ? rows.length : null : known ? pages.reduce((n, p) => n + p.total, 0) : null, shown: rows.length,
        more: pages.some(p => p.has_more), loading: pages.some(p => p.loading),
        attentionTotal: fview.localFilters ? completeWindow ? rows.filter(needsReviewAttention).length : null : attentionKnown ? pages.reduce((n, p) => n + p.attentionTotal, 0) : null,
        goalFiltered: !!fview.goal, localFilters: fview.localFilters,
        error: !hasSources ? 'No selected computer is online.' : pages.some(p => p.error) ? 'Some computers could not be asked.' : '', failed: pages.filter(p => p.error).length + (hasSources ? 0 : 1) };
};
export const clearReviewQuery = () => { if (fview) { const old = fview; fview = null; old.pager.reset([]); changed(); } };
export function queryReviews(f) {
    const key = reviewQueryKey(f);
    if (!key) { clearReviewQuery(); return null; }
    if (fview && fview.key === key && fview.sources === JSON.stringify(inboxSources()) && (fview.pager.status().some(p => p.loading) || Date.now() - fview.at < 30000)) return fview.promise;
    const goal = resolveGoalFilter(f.goal), params = reviewQueryParams(f).toString();
    if (fview) { const old = fview; fview = null; old.pager.reset([]); }
    const read = async (server, options) => {
        const data = await readComputerPage(server, { ...options, revisionBound: false });
        if (!options.cursor && !data.ownerOnly) {
            const query = new URLSearchParams(options.query);
            query.set('waiting', '1'); query.set('muted', '0'); query.delete('facets');
            try { const count = await readComputerPage(server, { ...options, query: query.toString(), limit: 1 }); data.attention_total = count.truncated || count.skewed?.some(k => k === 'waiting' || k === 'muted') ? null : count.total; } // an older computer cannot count what waits: no number, never the plain total
            catch { data.attention_total = null; }
        }
        return data;
    };
    const mine = { key, goal, emptyScope: !!(f.server && goal && f.server !== goal.server), filters: viewParts(f), sources: JSON.stringify(inboxSources()), localFilters: !!(f.goal && !goal) || f.agent === UNKNOWN_AGENT, started: revision, at: Date.now(), promise: null };
    mine.pager = createReviewPages({ read, key: pageKey, changed: () => { if (fview === mine) changed(); } });
    fview = mine;
    const sources = inboxSources().filter(server => (!f.server || server === f.server) && (!goal || goal.server === server));
    mine.pager.reset(sources, params);
    mine.promise = mine.pager.load();
    return mine.promise;
}
async function again(f, failedOnly) {
    const mine = fview;
    if (!mine || mine.key !== reviewQueryKey(f)) return;
    await Promise.all(mine.pager.status().filter(p => failedOnly ? p.error : p.has_more).map(p => mine.pager.more(p.server)));
    mine.at = Date.now();
}
export const moreQueriedReviews = f => again(f, false);
export const retryQueriedReviews = f => again(f, true);

/** The files for review on one goal of one team that nobody decided (one row per file, as Needs you has them): a goal page asks only its own team, not every team (#11913). */
export async function reviewsOfGoal(team, goalId) {
    return collapseVersions((await readTeam(team)).sort(byAge)).filter(a => String(a.goal_id) === String(goalId));
}

/** One protected, source-scoped read for a linked file or a fresh tag write. */
export async function reviewOfTeam(team, digest, { anyState = false } = {}) {
    const hex = String(digest || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error('The review file has no valid digest.');
    const source = splitKey(team);
    if (anyState && isCloud() && nativeSaved() && !nativeSavedSourceAllowed(source.server)) throw new Error('Saved file lookup requires an owned, online computer running Coral 2.0.62 or newer.');
    const params = new URLSearchParams({ team: source.name, digest: hex, ...(!anyState ? { tag: 'for review' } : {}) });
    const query = params.toString();
    const data = await readComputerPage(source.server, { query, cursor: '', limit: 50, revisionBound: !anyState }); // viewer state can overlap its own mark-read write
    if (data.ownerOnly) throw new Error('Review files are available only to this computer’s owner.');
    if (data.has_more || data.artifacts.some(a => a.team !== team || a.hex !== hex)) throw new Error('The computer did not return a scoped review file.');
    return data.artifacts.find(a => a.available && !a.tags?.includes('ignored') && !a.tags?.includes('superseded')) || null;
}

/** Expand a capped legacy collapse only when deciding it; ordinary Inbox reads stay bounded.
 * The reviewed row fixes the source, uploader/name group and upper version boundary. */
export async function legacyEarlierVersions(row) {
    const source = splitKey(row.team), query = new URLSearchParams({ team: source.name, tag: 'for review', versions: 'all', q: row.name || '' });
    const name = String(row.name || ''), uploader = String(row.produced_by || '');
    if (new TextEncoder().encode(name).length > 200) throw new Error('The file name exceeds Coral Hub’s 200-byte search limit; earlier versions could not be checked.');
    const hasUnsupportedSpaceOrControl = value => [...value].some(ch => ch !== ' ' && /[\p{Cc}\p{White_Space}]/u.test(ch));
    if (hasUnsupportedSpaceOrControl(name) || hasUnsupportedSpaceOrControl(uploader) || uploader.includes(',') || source.name.includes(',')) {
        throw new Error('The file name, uploader, or team contains characters Coral Hub cannot safely search; earlier versions could not be checked.');
    }
    if (uploader) query.set('by', uploader);
    const older = new Map(), seen = new Set();
    let cursor = '';
    do {
        const page = await readComputerPage(source.server, { query: query.toString(), cursor, limit: 50, revisionBound: false, legacyExpansion: true });
        if (page.ownerOnly) throw new Error('Earlier versions are available only to this computer’s owner.');
        for (const a of page.artifacts) if (a.team === row.team && vkey(a) === vkey(row) && a.hex !== row.hex && byAge(a, row) < 0) older.set(a.hex, a);
        if (!page.has_more) return [...older.values()];
        if (!page.next_cursor || seen.has(page.next_cursor)) throw new Error('Earlier versions could not be read completely.');
        cursor = page.next_cursor; seen.add(cursor);
    } while (cursor);
    return [...older.values()];
}

// The Inbox owns two bounded windows per computer, not a scan of every team.
// Facets/attention policy is layered on this metadata when its server contract is
// present. A raw for-review total is not an authoritative attention count.
const reviewQuery = new URLSearchParams({ tag: 'for review', versions: 'newest', starred_first: 'true', facets: 'team,by,goal' }).toString();
const savedQuery = new URLSearchParams({ tag: 'saved', versions: 'newest' }).toString();
let pagesReady = false, pendingStarted = 0, finishedAt = 0, finishedRev = -1, lastSources = null, rescans = 0;
async function readComputerPage(server, { query, cursor, limit, signal, revisionBound = true, legacyExpansion = false }) {
    const started = revision, params = new URLSearchParams(query);
    params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor); else params.delete('cursor');
    const { response, dropped } = await fetchSkewed(server, '/api/team-artifacts', params, { signal }); // dropped: the keys an older computer refused (#14317)
    const data = await response.json().catch(() => ({}));
    const asked = dropped.includes('digest') ? new Set((params.get('digest') || '').split(',').filter(Boolean)) : null; // the list came back whole: only the files asked for are kept
    if (signal?.aborted || (revisionBound && started !== revision)) throw Object.assign(new Error('The review read was superseded.'), { name: 'AbortError' });
    if (response.status === 403 && (data.code === 'owner_only' || data.error === 'owner_only')) return { artifacts: [], total: 0, tag_counts: {}, has_more: false, ownerOnly: true };
    if (legacyExpansion && response.status === 403 && (data.code === 'path_not_allowed' || data.error === 'path_not_allowed')) throw new Error("Earlier versions aren't available through Coral Hub.");
    if (!response.ok) throw new Error(`Review artifacts could not be read (HTTP ${response.status}).`);
    if (!Array.isArray(data.artifacts)) throw new Error('The review page was not a list.');
    if (data.partial || data.failed_boards?.length) throw new Error('Some review files could not be read.');
    const rawBoard = id => typeof id === 'string' && !!id && !id.startsWith('@') && !id.includes('/');
    noteBoardLabels((Array.isArray(data.teams) ? data.teams : []).filter(t => rawBoard(t.board_id)).map(t => ({ board_id: t.board_id, board_label: t.team })), 'board_id', server);
    const artifacts = [];
    for (const a of data.artifacts) {
        const hex = /(?:sha256:|coral:\/\/artifacts\/)?([a-f0-9]{64})$/i.exec(a.uri || a.digest || a.id || '')?.[1]?.toLowerCase();
        // A computer response must name the owning board. A display label is not
        // a routing identity, and a missing source never becomes the Hub/local.
        if (!hex || !rawBoard(a.board_id)) continue;
        if (asked && !asked.has(hex)) continue;
        const team = identityKey(server, a.board_id);
        artifacts.push({ ...a, id: hex, server: normServer(server), team, hex, reviewKey: `${team}:${hex}` });
    }
    return { ...data, artifacts, skewed: dropped };
}
const pageKey = row => row.reviewKey;
const reviewPager = createReviewPages({ read: readComputerPage, key: pageKey });
const savedPager = createReviewPages({ read: readComputerPage, key: pageKey });
function syncPageSources() {
    const servers = inboxSources();
    if (!pagesReady) { reviewPager.reset(servers, reviewQuery); savedPager.reset(isCloud() && nativeSaved() ? servers.filter(server => nativeSavedSourceAllowed(server)) : servers, savedQuery); pagesReady = true; }
    else { reviewPager.setSources(servers); savedPager.setSources(isCloud() && nativeSaved() ? servers.filter(server => nativeSavedSourceAllowed(server)) : servers); }
}
export const reviewPages = () => reviewPager.status();
export const savedReviewPages = () => savedPager.status();
/** Saved is an intersection: the saved query's for-review tag count covers off-page review files. */
export function countSavedReviews() {
    const pages = savedReviewPages().filter(page => !isCloud() || !nativeSaved() || nativeSavedSourceAllowed(page.server)), unknown = new Set();
    let value = 0, complete = pages.length > 0;
    for (const page of pages) {
        if (page.ownerOnly) continue;
        const n = page.total === 0 ? 0 : page.tag_counts ? ('for review' in page.tag_counts ? page.tag_counts['for review'] : 0) : null;
        if (page.loaded && !page.error && !page.truncated && Number.isSafeInteger(n) && n >= 0) value += n;
        else { unknown.add(page.server); complete = false; }
    }
    if (unknown.size) for (const row of savedFiles()) if (unknown.has(splitKey(row.team).server)) value++;
    return { value, complete };
}
/** Query totals and tags describe the server query, not its attention policy. */
export function reviewPageSummary() {
    if (!activated) return null;
    const sources = reviewPages().filter(s => !s.ownerOnly), ready = sources.length > 0 && sources.every(s => s.loaded && !s.error && !s.truncated);
    const totalKnown = ready && sources.every(s => Number.isSafeInteger(s.total));
    const completeWindow = ready && sources.every(s => !s.has_more && !s.truncated && s.total === s.loadedCount);
    const tagsKnown = ready && sources.every(s => s.tag_counts && Object.values(s.tag_counts).every(n => Number.isSafeInteger(n) && n >= 0));
    const tags = tagsKnown ? Object.create(null) : null;
    if (tags) for (const source of sources) for (const [tag, n] of Object.entries(source.tag_counts)) tags[tag] = (tags[tag] || 0) + n;
    const unread = unreadReviewItems(), loadedBySource = Object.create(null);
    for (const row of unread) { const server = splitKey(row.team).server; loadedBySource[server] = (loadedBySource[server] || 0) + 1; }
    return { sources, expected: sources.length, answered: sources.filter(s => s.loaded && !s.error).length,
        loadedBySource,
        queryTotal: totalKnown ? sources.reduce((n, s) => n + s.total, 0) : null, tag_counts: tags,
        attentionTotal: completeWindow ? unread.length : null, loadedUnread: unread.length,
        hasMore: sources.some(s => s.has_more), partial: !ready || sources.some(s => s.truncated),
        failed: sources.filter(s => s.error).map(s => s.server) };
}
let pagesPublished = false;
function publishPages() {
    const next = [], nextSaved = [], nextMuted = [], failed = [];
    for (const source of reviewPager.snapshot()) {
        if (source.error) failed.push(`${source.server} review artifacts could not be refreshed: ${source.error}`);
        for (const a of source.artifacts) {
            const tags = a.tags || [], decidedWithNews = a.new_comments > 0 && (tags.includes('approved') || tags.includes('denied')) && !tags.includes('for review');
            if (!(tags.includes('for review') || decidedWithNews) || tags.includes('saved') || tags.includes('ignored') || tags.includes('superseded') || !a.available) continue;
            (a.muted === true ? nextMuted : next).push(a);
        }
    }
    for (const source of savedPager.snapshot()) {
        if (source.error) failed.push(`${source.server} saved review artifacts could not be refreshed: ${source.error}`);
        for (const a of source.artifacts) if (a.tags?.includes('saved') && a.tags.includes('for review') && a.available) nextSaved.push(a);
    }
    items = next.sort(byAge); saved = nextSaved.sort(byAge); muted = nextMuted.sort(byAge); errors = failed;
    changed({ countsUnchanged: !pagesPublished }); // initial page publication is not an edit: the independent startup summary is already reading
    pagesPublished = true;
}
async function appendReviews(pager, server) {
    if (!activated) return;
    if (pending) await pending;
    const started = revision;
    const servers = server === undefined ? pager.status().filter(s => s.has_more || !s.loaded).map(s => s.server) : [server];
    const reads = servers.map(s => pager.more(s)); changed();
    await Promise.all(reads);
    if (started === revision) publishPages();
}
export const loadMoreReviews = server => appendReviews(reviewPager, server);
export const loadMoreSavedFiles = server => appendReviews(savedPager, server);
const unchangedComputer = (server, stamp) => artifactsUnchanged(identityKey(server, stamp.team), stamp.rev, true);
async function refreshActiveQuery(unchanged = null) {
    const mine = fview;
    if (!mine) return;
    if (mine.pager.status().some(page => page.loading)) {
        await mine.promise;
        return fview === mine ? refreshActiveQuery(unchanged) : undefined;
    }
    const started = revision;
    mine.at = Date.now();
    mine.promise = mine.pager.refresh({ unchanged }).then(results => {
        if (fview !== mine || started !== revision) return;
        mine.started = started;
        mine.invalidCounts = false;
        if (results.some(result => result !== false)) changed();
    });
    return mine.promise;
}
export function refreshReviews(force = false, { reuse = false } = {}) {
    if (force) activated = true;
    if (!activated) return null;
    if (pending) return force && pendingStarted !== revision ? pending.then(() => refreshReviews(true)) : pending;
    const sources = sourcesKey();
    if (force && reuse && finishedAt && Date.now() - finishedAt < 30000 && finishedRev === revision && sources === lastSources) return Promise.resolve();
    if (!force && Date.now() - lastRead < 30000 && sources === lastSources) return null;
    const sourceSetChanged = sources !== lastSources;
    lastSources = sources; pendingStarted = revision; lastRead = Date.now();
    const started = revision;
    syncPageSources();
    const unchanged = !force && !freshnessDirty && finishedRev === revision ? unchangedComputer : null;
    freshnessDirty = false;
    pending = Promise.all([reviewPager.refresh({ unchanged }), (!isCloud() || savedActivated ? savedPager.refresh({ unchanged }) : Promise.resolve([])), refreshActiveQuery(unchanged)]).then(([reviews, saved]) => {
        if (started !== revision) return;
        if (!sourceSetChanged && [...reviews, ...saved].every(result => result === false)) { if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('coral:reviews-settled')); return; } // (its own event, not reviews-changed: the Inbox draws its list again and nothing is READ: the counts, the tab's other reads and an open viewer's file all listen to reviews-changed, and an idle board makes no list read, #14906) nothing new, but the read that was out has ended: the list redraws (its signature holds the pages' loading state, so a draw that would be the same is skipped) (#14841)
        publishPages();
        if (typeof document !== 'undefined') importOnce('./operator_asks.js').then(m => m.refreshReviewAskVisibility()).catch(() => {});
        if (!errors.length) { finishedAt = Date.now(); finishedRev = revision; }
    }).catch(() => { errors = ['Review artifacts could not be refreshed.']; changed(); }).finally(() => {
        pending = null;
        const sourcesChanged = sourcesKey() !== sources;
        if (sourcesChanged && rescans < 2) { rescans++; refreshAgain = false; refreshReviews(true).catch(() => {}); }
        else { if (!sourcesChanged) rescans = 0; if (refreshAgain) { refreshAgain = false; lastRead = 0; refreshReviews(); } }
    });
    return pending;
}
if (typeof document !== 'undefined') document.addEventListener('coral:servers-updated', () => { if (activated) refreshReviews(); });

/** The artifact's tags as the server has them now, read right before a write: the tags route replaces the whole list, so a tag someone added since the last refresh would be lost from the row's copy. null when it is no longer a for-review artifact. */
export async function currentTags(row) {
    const current = await reviewOfTeam(row.team, row.hex || row.id);
    return current ? current.tags || [] : null;
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
    if (fview) { fview.invalidCounts = true; refreshActiveQuery().catch(() => {}); }
    changed();
}

/** A decision put a row back (Undo of Dismiss, Move to Needs you): a read in flight took its lists before the write, so its answer is stale. Moving the revision makes that read be discarded, and the forced read that follows is a new one (#13601). */
export function reviewsChangedOnServer() { revision++; reviewPager.remove(() => false); savedPager.remove(() => false); }

/** The Operator decided a review (Approve): the row is out of the list at once, and a read that was already in flight cannot put it back. */
export function settleReview(row) {
    revision++;
    const gone = new Set([row.reviewKey || `${row.team}:${row.id}`, ...earlierVersions(row).map(a => a.reviewKey)]); // the versions before it were settled with it (settleEarlierVersions)
    reviewPager.remove(a => gone.has(a.reviewKey)); savedPager.remove(a => gone.has(a.reviewKey));
    for (const k of gone) { settledAt.set(k, revision); linkedReviews.delete(k); }
    items = items.filter(a => !gone.has(a.reviewKey)); saved = saved.filter(a => !gone.has(a.reviewKey));
    if (fview) fview.invalidCounts = true;
    changed();
}

let lastReadNotice = 0;
/** markOpenedRead that says so on the page when the write is refused (#12742): the sentence goes to `say` (the live region) and, at most once in ten seconds, to a visible toast, so a file that stays unread is never silent. Resolves either way. */
export function markOpenedReadVisibly(hex, say, team = '') {
    return markOpenedRead(hex, team).catch(error => {
        if (error?.name === 'AbortError') return; // A newer read replaced this one; no write was refused.
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
    const readKey = JSON.stringify([team, hex]);
    if (reading.has(readKey)) return reading.get(readKey);
    const p = (async () => {
        let own = null; // the file's own row, read from its own team alone when the Inbox's scan of every team has not run (a file opened through the Hub): one team's list, not nine (#13489)
        if (!activated && team) own = await reviewOfTeam(team, hex);
        else if (!activated) await refreshReviews(true, { reuse: true }); else if (pending) await pending;
        const row = own ? (needsReviewAttention(own) || (!isRead(own) && !waitingOnAgent(own)) ? own : undefined) : items.find(a => a.hex.toLowerCase() === hex && (!team || a.team === team) && (needsReviewAttention(a) || (!isRead(a) && !waitingOnAgent(a)))); // A sent-back file with no news is visible but uncounted; automatic viewer reloads leave its read tag alone. Unseen replies can be read normally.
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
    })().finally(() => reading.delete(readKey));
    reading.set(readKey, p);
    return p;
}


const openingVersions = new Map();
/** Record only a successfully loaded viewer version, on its frozen computer.
 * Older/refusing sources leave the baseline unknown, without a success claim. */
export function recordOpenedVersion(hex, { server, board = '' }) {
    const key = JSON.stringify([normServer(server), board, hex]);
    if (openingVersions.has(key)) return openingVersions.get(key);
    const work = (async () => {
        const response = await serverFetch(server, `/api/artifacts/${hex}/opened`, { method: 'POST' });
        if (!response.ok) return false;
        const data = await response.json();
        if (!data.series_id || !Number.isSafeInteger(data.opened_version) || data.opened_version < 1) return false;
        const team = board ? identityKey(server, board) : '';
        for (const row of [...items, ...saved, ...muted]) if (row.series_id === data.series_id && splitKey(row.team).server === normServer(server) && (!team || row.team === team)) row.opened_version = Math.max(row.opened_version || 0, data.opened_version);
        revision++;
        if (fview) { fview.invalidCounts = true; refreshActiveQuery().catch(() => {}); }
        changed(); return true;
    })().catch(() => false).finally(() => openingVersions.delete(key));
    openingVersions.set(key, work); return work;
}

setReviewCacheReader(unreadReviewItems, refreshReviews, reviewPageSummary);
