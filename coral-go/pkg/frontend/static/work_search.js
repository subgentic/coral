/* The dashboard's search of task and goal text (#19237, goal #244, coral-search slice 3). The Inbox lists search only what a row shows (a task's title, team, priority and state; a goal's title), so a word only in a task's body
 * or a goal's outcome found nothing. The server has the search 'coral-board search' makes (GET /api/board/{team}/search, the same code and result list): this asks it for each team the list holds and answers the set of items it
 * found, `${team}#${id}`, which the list shows beside its own matches. A team that does not answer (Coral Hub refuses it, an older computer lacks it) adds nothing: the list's own filter still works. Lazy: the start path does not carry it. */
import { boardFetch } from './server_base.js';

/** The items of `source` ('tasks' or 'goals') whose text holds `text`, in the given teams: a Set of `${team}#${id}`. */
export async function workHits(teams, text, source) {
    const q = String(text || '').trim(), hits = new Set();
    if (!q) return hits;
    const kind = source === 'goals' ? 'goal' : 'task', qs = new URLSearchParams({ q, source });
    await Promise.all([...new Set(teams)].filter(Boolean).map(async team => {
        try {
            const r = await boardFetch(team, `/search?${qs}`);
            if (!r.ok) return;
            for (const h of (await r.json()).results || []) if (h.source === kind) hits.add(`${team}#${h.id}`);
        } catch { /* this team adds nothing */ }
    }));
    return hits;
}

let gen = 0, timer = 0;
/** The sidebar's one call (the words typed in Tasks or Goals are also asked of the server, the search 'coral-board search' makes, so a word only in a body or an outcome shows): after a short pause, fill `hits[kind]` (a Set the list reads) with the server's hits for `text` in `teams`, then `redraw`; an empty search empties it. A newer search drops an older answer. */
export function noteWork(hits, kind, text, items, redraw) {
    const teams = items.map(x => x.project || x.board_id), mine = ++gen; clearTimeout(timer);
    if (!String(text || '').trim()) { if (hits[kind].size) hits[kind].clear(); return; }
    timer = setTimeout(() => workHits(teams, text, kind).then(set => { if (mine !== gen) return; hits[kind] = set; redraw(); }).catch(() => {}), 250);
}
