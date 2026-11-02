/* A link to one item of Needs you (#11797): /inbox/needs/<review|ask|goal>/[@<server>/]<team>/<id>, the address a push notification opens. The Inbox is on Needs you and the item opens on its own card: a file in the viewer with
 * Approve and Request changes, a question in its dialog with the Reply box, a "Goal looks done" item on the goal's own page. The item is looked for in the lists the Inbox reads with the viewer's own access (the address alone fetches nothing); one that is not there, or
 * is not waiting any more, says so and the Inbox stays as it is. Lazy: loaded by the route. */
import { importOnce } from './import_once.js';
import { showToast } from './utils.js';
import { identityKey } from './server_base.js';

export async function openNeed({ kind, server, team, id }) {
    if (kind === 'goal') { // a goal that looks done (#12172): this computer's goals only, as its row is
        if (server || !(await (await importOnce('./inbox_sidebar.js')).openGoalDoneNeed(team, id))) showToast('That goal is not waiting for you any more.');
        return;
    }
    const key = identityKey(server, team), ask = kind === 'ask', m = await importOnce(ask ? './operator_asks.js' : './inbox_reviews.js');
    await (ask ? m.refreshOperatorAsks : m.refreshReviews)(true);
    const item = ask ? m.operatorAsks().find(a => a.board === key && String(a.id) === id) : m.reviewItems().find(a => a.team === key && a.hex === id);
    if (!item) showToast(`That ${ask ? 'question' : 'file'} is not waiting for you any more.`);
    else if (ask) m.openAskDialog(item, () => {});
    else (await importOnce('./inbox_sidebar.js')).openReview(item);
}
