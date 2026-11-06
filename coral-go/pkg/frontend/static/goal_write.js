/* A goal write through the Coral Hub's preview (#13503, coral-hub's contract): when goal_preview is enabled by the account (or its boot fallback), a goal create, close or update is first PREVIEWED, and the write carries the token the preview gave.
 *   1. POST /api/remote/{server}/api/hub/goal-preview {board, action, goal?, body}: `body` is the EXACT text of the write (a JSON object as a string); the answer is {token, expires, tier}.
 *   2. The ordinary write, through the same computer, with X-Hub-Goal-Preview: <token> and the SAME bytes that were previewed (the Hub hashes them: one different byte is preview_invalid).
 * Before EVERY write, never once per page: one token, one write (a close or an update token works once). A preview that has run out (preview_expired) is asked for again, once, and the write sent again; anything else
 * is said in the Hub's word as one plain sentence (goal_words.js PREVIEW_WORDS) in the editor's own error line. With the flag off (the self-hosted Hub, a computer's own dashboard) this is boardFetch, the write as it always was.
 * The task add is not previewed: the Hub leaves it alone without a token. goalWrite answers a Response like boardFetch does, so a caller keeps its `if (!r.ok)` and its error line. */
import { boardFetch, goalPreviewOn, serverFetch, splitKey, isCloud, isHub, LOCAL_SERVER } from './server_base.js';
import { importOnce } from './import_once.js';
import { PREVIEW_WORDS } from './goal_words.js';
const { serverEntry, serverVersion, compareVersions } = await importOnce('./server_status.js');

const JSON_HEADERS = { 'Content-Type': 'application/json' };
export const PREVIEW_HEADER = 'X-Hub-Goal-Preview';
export const GOAL_ACTIONS = ['goal_create', 'goal_close', 'goal_update', 'goal_driver', 'goal_move'];

/** The Coral that has the Operator's two goal routes (/driver and /move through a Hub, #13517): a Hub page in front of an older computer must not offer buttons that would only say not found. The prerelease floor '-0' counts a 2.0.50 candidate. */
export const OPERATOR_ROUTES_VERSION = '2.0.50';
export const OPERATOR_ROUTES_SINCE = `${OPERATOR_ROUTES_VERSION}-0`;
/** Whether the computer a team is on reports a Coral that has them; a version it does not report (or one that cannot be read) is no. */
export function computerHasOperatorRoutes(server, entryOf = serverEntry) {
    const c = compareVersions(serverVersion(entryOf(server)), OPERATOR_ROUTES_SINCE);
    return c !== null && c >= 0;
}
/** Whether the goal page offers Change driver and Move to another team for a goal on this server: on this computer's own dashboard always; through coral-hub's Hub or our own only for a computer that has the routes. */
export function offersOperatorChanges(server, { cloud = isCloud(), hub = isHub(), has = computerHasOperatorRoutes } = {}) {
    if (server === LOCAL_SERVER) return !cloud; // the Hub's own "local" is no computer behind coral-hub's Hub; on a computer's own dashboard (and a self-hosted Hub's own boards) it is this build
    return (cloud || hub) && has(server);
}

/** The words under the goal's actions when an older computer behind a Hub hides Change driver and Move, and whether that is the case. */
export const operatorChangesNote = () => `Change driver and Move need Coral ${OPERATOR_ROUTES_VERSION} on this computer.`;
export function operatorChangesNeedNewer(server, { cloud = isCloud(), hub = isHub(), has = computerHasOperatorRoutes } = {}) {
    return server !== LOCAL_SERVER && (cloud || hub) && !has(server);
}

/** A refused answer as the editor reads it: {code: the Hub's word, error: our sentence} with the status. */
const refused = (status, word) => new Response(JSON.stringify({ code: word, error: PREVIEW_WORDS[word] || PREVIEW_WORDS.bad_request }), { status, headers: { 'Content-Type': 'application/json' } });

/** The Hub's word for an answer: its {error: word}, else one from the status (a 429, a 413, the tunnel's 503). */
async function wordOf(resp) {
    let w = '';
    try { w = String((await resp.clone().json()).error || ''); } catch { /* the status says it */ }
    if (PREVIEW_WORDS[w]) return w;
    if (resp.status === 429) return 'too_many_requests';
    if (resp.status === 413) return 'too_large';
    if (resp.status === 503) return w === 'busy' ? 'busy' : 'unreachable';
    return w === 'remote unavailable' ? 'unreachable' : 'bad_request';
}

async function preview(server, board, action, goalId, bodyText, f) {
    const ask = { board, action, body: bodyText };
    if (goalId) ask.goal = goalId;
    let resp;
    try { resp = await f(server, '/api/hub/goal-preview', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(ask) }); } catch { return { fail: refused(503, 'unreachable') }; }
    if (!resp.ok) return { fail: refused(resp.status, await wordOf(resp)) };
    let t = null;
    try { t = await resp.json(); } catch { /* none */ }
    return t && typeof t.token === 'string' && t.token ? { token: t.token } : { fail: refused(502, 'preview_required') };
}

/** The shapes the Hub checks at preview and at confirm (coral-hub, #13503): subscriber_id is REQUIRED and exactly 'Operator'; a close takes state (done|dropped, required) and an optional reason of at most 500 characters; an update takes at least one of
 *  title (200), outcome (4000), done_when (4000), blocked_on (500), driver (128), state (proposed|active|blocked|done|dropped). Returns '' when the body is inside them, else why not: a body outside them is `bad_request`, so it is not sent. */
const UPDATE_CAPS = { title: 200, outcome: 4000, done_when: 4000, blocked_on: 500, driver: 128 };
export function checkGoalBody(action, b) {
    if (action === 'goal_driver' || action === 'goal_move') { // the Operator's own two changes (#13517): no subscriber_id, each key once, strings (coral-hub's Security: driver 0-128 characters, '' clears; to_project 1-256, one path segment)
        if (!b || typeof b !== 'object' || Array.isArray(b)) return 'the body is an object';
        const allowed = action === 'goal_driver' ? ['driver'] : ['to_project', 'driver'];
        if (!Object.keys(b).every(k => allowed.includes(k))) return `a ${action === 'goal_driver' ? 'driver change' : 'move'} takes only ${allowed.join(' and ')}`;
        if (action === 'goal_driver' && typeof b.driver !== 'string') return 'driver is a string';
        if (b.driver !== undefined && (typeof b.driver !== 'string' || [...b.driver].length > 128)) return 'driver is at most 128 characters';
        if (action === 'goal_move' && (typeof b.to_project !== 'string' || !b.to_project.trim() || b.to_project.length > 256 || /[\/\\\u0000-\u001f]/.test(b.to_project))) return 'to_project is one board name, at most 256 characters';
        return '';
    }
    if (action !== 'goal_close' && action !== 'goal_update') return ''; // a create's body is the computer's own (createBody)
    if (!b || typeof b !== 'object' || b.subscriber_id !== 'Operator') return 'subscriber_id must be Operator';
    if (action === 'goal_close') {
        if (b.state !== 'done' && b.state !== 'dropped') return 'a close needs state done or dropped';
        if (b.reason !== undefined && (typeof b.reason !== 'string' || [...b.reason].length > 500)) return 'the reason is at most 500 characters';
        return Object.keys(b).every(k => ['subscriber_id', 'state', 'reason'].includes(k)) ? '' : 'a close takes state, reason and subscriber_id';
    }
    if (action === 'goal_update') {
        const keys = Object.keys(b).filter(k => k !== 'subscriber_id');
        if (!keys.length) return 'an update names at least one field';
        for (const k of keys) {
            if (k === 'state') { if (!['proposed', 'active', 'blocked', 'done', 'dropped'].includes(b.state)) return 'state is not one of the five'; }
            else if (!(k in UPDATE_CAPS)) return `an update does not take ${k}`;
            else if (typeof b[k] !== 'string' || [...b[k]].length > UPDATE_CAPS[k]) return `${k} is at most ${UPDATE_CAPS[k]} characters`;
        }
    }
    return '';
}

/** Many writes one at a time through the preview (#13503): the Hub allows 20 previews and 20 confirms a minute per account, so with the flag on a bulk close goes at most about 10 a minute (a pause between goals), says where it is,
 *  and on the Hub's 429 STOPS with its plain line (never loops, never retries: the rest stay as they were, for the person to do after Retry-After's half minute). Flag off: no pause, no limit, as it always was.
 *  `one(item)` answers a Response (goalWrite) or throws; resolves { done, failed, stopped } where `stopped` is the sentence when the Hub's limit ended it. */
export const BULK_GAP_MS = 6000;
const gapMs = () => (typeof window !== 'undefined' && Number.isFinite(window.__coralBulkGapMs) ? window.__coralBulkGapMs : BULK_GAP_MS); // a suite shortens the pause (a person's page never sets it)
export async function writeEach(list, one, { on = goalPreviewOn, say = () => {}, wait = ms => new Promise(r => setTimeout(r, ms)), noun = 'goals' } = {}) {
    let done = 0, failed = 0, stopped = '';
    for (let i = 0; i < list.length; i++) {
        if (on()) { if (i) await wait(gapMs()); say(`Changing ${noun}: ${i + 1} of ${list.length}`); }
        let r = null;
        try { r = await one(list[i]); } catch { failed++; continue; }
        if (r && r.status === 429) { stopped = `${PREVIEW_WORDS.too_many_requests} ${done} of ${list.length} ${noun} ${done === 1 ? 'was' : 'were'} changed; the rest are unchanged.`; break; }
        if (r && r.ok) done++; else failed++;
    }
    return { done, failed, stopped };
}

/** goalWrite(project, action, goalId, path, method, body): the write as boardFetch would send it, previewed first when the Hub asks for it. `body` is the object; `goalId` is the goal for a close or an update (0/absent for a create). */
export async function goalWrite(project, action, goalId, path, method, body, { boardFn = boardFetch, serverFn = serverFetch, on = goalPreviewOn } = {}) {
    const bodyText = JSON.stringify(body);
    if (!on() || !GOAL_ACTIONS.includes(action)) {
        const resp = await boardFn(project, path, { method, headers: JSON_HEADERS, body: bodyText });
        // A failed/timed-out account read may miss the gate; the Hub still refuses the write.
        if (!resp.ok && GOAL_ACTIONS.includes(action) && await wordOf(resp) === 'preview_required') return refused(resp.status, 'preview_required');
        return resp;
    }
    const bad = checkGoalBody(action, body); // a body outside the Hub's shapes would be bad_request: it is not sent
    if (bad) return refused(400, 'bad_request');
    const { server, name } = splitKey(project);
    for (let attempt = 0; attempt < 2; attempt++) {
        const p = await preview(server, name, action, goalId, bodyText, serverFn);
        if (p.fail) return p.fail;
        const resp = await boardFn(project, path, { method, headers: { ...JSON_HEADERS, [PREVIEW_HEADER]: p.token }, body: bodyText }); // the SAME bytes that were previewed
        if (resp.ok) return resp;
        const word = await wordOf(resp);
        if (word === 'preview_expired' && attempt === 0) continue; // ran out between the check and the write: checked again, once
        // a word of the Hub's own is said in our sentence; any other refusal (the computer's own: a title that is missing) is passed on as it came
        let hubsOwn = false;
        try { hubsOwn = !!PREVIEW_WORDS[String((await resp.clone().json()).error || '')]; } catch { /* the computer's own */ }
        return hubsOwn || resp.status === 429 || resp.status === 413 ? refused(resp.status, word) : resp;
    }
}
