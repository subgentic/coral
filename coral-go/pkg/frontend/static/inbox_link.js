/* A link to one Inbox item (including a Saved review) (#11797): /inbox/needs/<review|ask|goal>/[@<server>/]<team>/<id>, the address a push notification opens. The Inbox is on Needs you and the item opens on its own card: a file in the viewer with
 * Approve and Request changes, a question in its dialog with the Reply box, a "Goal looks done" item on the goal's own page. The item is looked for in cached lists or a protected lookup of its exact board/digest, with the viewer's own access; one that is not there, or
 * is neither waiting nor Saved any more, says so and the Inbox stays as it is. Lazy: loaded by the route. */
import { importOnce } from './import_once.js';
import { showToast } from './utils.js';
import { identityKey } from './server_base.js';
import { fetchProjects } from './board_fetch.js';

/** The team key a link names: its id as written, else the one team whose name (board_label, exact) it is. A name two teams have, or none, stays as written and so finds nothing (#12412). */
async function teamKeyOf(server, team, items) {
    const key = identityKey(server, team);
    if (items.some(a => (a.team || a.board) === key)) return key; // an id that has an item: as before
    let projects = [];
    try { projects = await fetchProjects(); } catch { return key; }
    const named = projects.filter(p => p && p.board_label === team && (p.server || '') === (server || ''));
    return named.length === 1 && named[0].project ? named[0].project : key;
}

export async function openNeed({ kind, server, team, id }) {
    if (kind === 'goal') { // a goal that looks done (#12172): this computer's goals only, as its row is
        if (server || !(await (await importOnce('./inbox_sidebar.js')).openGoalDoneNeed(team, id))) showToast('That goal is not waiting for you any more.');
        return;
    }
    const ask = kind === 'ask', m = await importOnce(ask ? './operator_asks.js' : './inbox_reviews.js');
    const pick = (list, at) => (ask ? list.find(a => a.board === at && String(a.id) === id) : list.find(a => a.team === at && a.hex === id));
    // The item is opened from what the Inbox already has (#13116: the link used to wait for a scan of every team, eight seconds through the Hub, twice if a scan was running); not loaded yet: a review reads only its own
    // team; a question reads as before. The lists are brought up to date after the viewer is open, in the background.
    let list = ask ? m.operatorAsks() : [...m.reviewItems(), ...m.savedFiles()], at = await teamKeyOf(server, team, list), item = pick(list, at);
    if (!item) {
        if (ask) { await m.refreshOperatorAsks(true); list = m.operatorAsks(); at = await teamKeyOf(server, team, list); item = pick(list, at); }
        else { try {
            item = await m.reviewOfTeam(at, id);
            if (!item) {
                // A cold Saved link is absent from the waiting-only list. Ask
                // the same protected route for this exact board/digest only.
                const saved = await m.reviewOfTeam(at, id, { anyState: true });
                if (saved?.tags?.includes('saved') && saved.tags.includes('for review')) item = saved;
            }
        } catch (error) { showToast(error.message || 'That review file could not be read.'); return; } }
    }
    Promise.resolve((ask ? m.refreshOperatorAsks(true) : m.refreshReviews(true, { reuse: true }))).catch(() => {});
    if (!item) showToast(`That ${ask ? 'question' : 'file'} is not waiting for you any more.`);
    else if (ask) m.openAskDialog(item, () => {});
    else (await importOnce('./inbox_sidebar.js')).openReview(item);
}
