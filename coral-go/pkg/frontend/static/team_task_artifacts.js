/* The artifacts of a task, on its page (#7739): what the team's Artifacts list holds for this task, the files an agent uploaded while it worked on it and the ones attached to its result. One line each: the name,
 * then its type, size, when and who made it; the name opens the artifact. Nothing here builds HTML from text: names and producers are written by agents (textContent only). The section is not drawn
 * when the task has no artifact or the list cannot be read (a Coral Hub viewer's: the team's artifacts are the owner's alone). Lazy: team_tasks_page.js imports it. */
import { boardFetch, pathId } from './server_base.js';
import { whenText } from './when_text.js';
import { importOnce } from './import_once.js';
const { el } = await importOnce('./team_table.js'); // lazy: its failure is retried

const SHOWN = 50;
const HEX = /^coral:\/\/artifacts\/([a-f0-9]{64})$/i;

function sizeWords(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Opens the artifact the way the Artifacts tab's Open does: a task result's inline text in the preview, a stored file in the viewer. */
function openIt(item) {
    const name = String(item.name || 'Artifact');
    const m = HEX.exec(String(item.uri || ''));
    if (item.inline && item.content_url) return importOnce('./preview_pane.js').then(p => p.openArtifactTab(item.uri || '', { contentURL: item.content_url, mediaType: item.media_type, filename: name, phoneFull: true }));
    if (m) return importOnce('./artifact_viewer.js').then(v => v.openArtifactViewer(m[1].toLowerCase(), { filename: name, mediaType: item.media_type }));
    return null;
}

/** The section for `task` on `project`'s board, or null when there is nothing to show. */
export async function taskArtifactsSection(project, task) {
    let data;
    try {
        const resp = await boardFetch(project, `/artifacts?task=${pathId(task.id)}&limit=${SHOWN}`);
        if (!resp.ok) return null;
        data = await resp.json();
    } catch { return null; }
    const items = (Array.isArray(data && data.artifacts) ? data.artifacts : []).filter(a => a && Number(a.task_id) === Number(task.id));
    if (!items.length) return null;
    const section = el('div', 'team-task-artifacts');
    const head = el('h3', 'goals-sub', 'Artifacts'); head.id = `team-task-artifacts-head-${Number(task.id)}`;
    const list = el('ul', 'team-task-artifact-list'); list.setAttribute('aria-labelledby', head.id);
    for (const item of items) {
        const li = el('li', 'team-task-artifact');
        const opens = item.inline || HEX.test(String(item.uri || ''));
        const name = el(opens ? 'button' : 'span', opens ? 'team-link team-task-artifact-name' : 'team-task-artifact-name', String(item.name || 'Artifact'));
        if (opens) { name.type = 'button'; name.addEventListener('click', () => { const p = openIt(item); if (p) p.catch(() => {}); }); }
        const type = String(item.media_type || '').split(';')[0];
        const meta = [type, sizeWords(Number(item.size)), item.created_at ? whenText(item.created_at) : '', item.produced_by ? `by ${item.produced_by}` : ''].filter(Boolean).join(' · ');
        li.append(name, el('span', 'team-task-artifact-meta', meta));
        list.append(li);
    }
    section.append(head, list);
    const total = Number(data.total);
    if (Number.isFinite(total) && total > items.length) section.append(el('p', 'goals-note', `${total - items.length} more are in the team's Artifacts tab.`));
    return section;
}
