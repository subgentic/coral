/* The artifacts of a task, on its page (#7739): what the team's Artifacts list holds for this task, the files an agent uploaded while it worked on it and the ones attached to its result. One line each: the name,
 * then its type, size, when and who made it; the name opens the artifact. Nothing here builds HTML from text: names and producers are written by agents (textContent only). The section is not drawn
 * when the task has no artifact or the list cannot be read (a Coral Hub viewer's: the team's artifacts are the owner's alone). Lazy: team_tasks_page.js imports it. */
import { boardFetch, pathId } from './server_base.js';
import { importOnce } from './import_once.js';
const { artifactTable, serverArtifactSort } = await importOnce('./artifact_table.js');
const { el, tableState } = await importOnce('./data_table.js'); // lazy: its failure is retried

const SHOWN = 50;
const HEX = /^coral:\/\/artifacts\/([a-f0-9]{64})$/i;

/** Opens the artifact the way the Artifacts tab's Open does: a task result's inline text in the preview, a stored file in the viewer. */
function openIt(item) {
    const name = String(item.name || 'Artifact');
    const m = HEX.exec(String(item.uri || ''));
    if (item.inline && item.content_url) return importOnce('./preview_pane.js').then(p => p.openArtifactTab(item.uri || '', { contentURL: item.content_url, mediaType: item.media_type, filename: name, phoneFull: true }));
    if (m) return importOnce('./artifact_viewer.js').then(v => v.openArtifactViewer(m[1].toLowerCase(), { filename: name, mediaType: item.media_type }));
    return null;
}

/** The section for `task` on `project`'s board, or null when there is nothing to show. */
export async function taskArtifactsSection(project, task, sort = serverArtifactSort()) {
    let data;
    try {
        const resp = await boardFetch(project, `/artifacts?task=${pathId(task.id)}&limit=${SHOWN}&sort=${encodeURIComponent(sort)}`);
        if (!resp.ok) return null;
        data = await resp.json();
    } catch { return null; }
    const items = (Array.isArray(data && data.artifacts) ? data.artifacts : []).filter(a => a && Number(a.task_id) === Number(task.id));
    if (!items.length) return null;
    const section = el('div', 'team-task-artifacts');
    const head = el('h3', 'goals-sub', 'Artifacts'); head.id = `team-task-artifacts-head-${Number(task.id)}`;
    const body = el('div');
    const state = tableState();
    function draw() {
        const table = artifactTable({ label: 'Task artifacts', rows: items, state,
            paged: !!data.has_more || Number(data.total) > items.length,
            onPageSort: next => { taskArtifactsSection(project, task, next).then(updated => { if (updated && section.isConnected) section.replaceWith(updated); }).catch(() => {}); },
            open: item => { const p = openIt(item); if (p) p.catch(() => {}); },
        });
        body.replaceChildren(table.el);
    }
    draw(); section.append(head, body);
    const total = Number(data.total);
    if (Number.isFinite(total) && total > items.length) section.append(el('p', 'goals-note', `${total - items.length} more are in the team's Artifacts tab.`));
    return section;
}

/** The task's results as links for its completion form (up to 5: the name opens the artifact), or [] when it has none or the list cannot be read. */
export async function taskResultLinks(project, task) {
    try {
        const resp = await boardFetch(project, `/artifacts?task=${pathId(task.id)}&limit=5&sort=${encodeURIComponent(serverArtifactSort())}`);
        if (!resp.ok) return [];
        const data = await resp.json();
        const items = (Array.isArray(data && data.artifacts) ? data.artifacts : []).filter(a => a && Number(a.task_id) === Number(task.id));
        return items.map(item => { const b = el('button', 'team-link', String(item.name || 'Artifact')); b.type = 'button'; b.addEventListener('click', () => { const p = openIt(item); if (p) p.catch(() => {}); }); return b; });
    } catch { return []; }
}
