/* A goal write through the Coral Hub's preview (#13503, coral-hub's contract): when the Hub's boot value goal_preview is true, a goal create, close or update is first PREVIEWED, and the write carries the token the preview gave.
 *   1. POST /api/remote/{server}/api/hub/goal-preview {board, action, goal?, body}: `body` is the EXACT text of the write (a JSON object as a string); the answer is {token, expires, tier}.
 *   2. The ordinary write, through the same computer, with X-Hub-Goal-Preview: <token> and the SAME bytes that were previewed (the Hub hashes them: one different byte is preview_invalid).
 * Before EVERY write, never once per page: one token, one write (a close or an update token works once). A preview that has run out (preview_expired) is asked for again, once, and the write sent again; anything else
 * is said in the Hub's word as one plain sentence (goal_words.js PREVIEW_WORDS) in the editor's own error line. With the flag off (the self-hosted Hub, a computer's own dashboard) this is boardFetch, the write as it always was.
 * The task add is not previewed: the Hub leaves it alone without a token. goalWrite answers a Response like boardFetch does, so a caller keeps its `if (!r.ok)` and its error line. */
import { boardFetch, goalPreviewOn, serverFetch, splitKey } from './server_base.js';
import { PREVIEW_WORDS } from './goal_words.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
export const PREVIEW_HEADER = 'X-Hub-Goal-Preview';
export const GOAL_ACTIONS = ['goal_create', 'goal_close', 'goal_update'];

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

/** goalWrite(project, action, goalId, path, method, body): the write as boardFetch would send it, previewed first when the Hub asks for it. `body` is the object; `goalId` is the goal for a close or an update (0/absent for a create). */
export async function goalWrite(project, action, goalId, path, method, body, { boardFn = boardFetch, serverFn = serverFetch, on = goalPreviewOn } = {}) {
    const bodyText = JSON.stringify(body);
    if (!on() || !GOAL_ACTIONS.includes(action)) return boardFn(project, path, { method, headers: JSON_HEADERS, body: bodyText });
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
