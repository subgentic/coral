/* The team page's Knowledge tab (#7453 stage 3): what the team knows as a table (Entry, Updated, From), "Distill knowledge" in the bar, and a row opens the documents pane with the entry's text as text.
 * An entry is the team's index or one agent's distilled notes (GET /api/teams/detail/{team}/knowledge). The pane shows the text in a <pre>: distilled from agents' words, it is never run as Markdown or HTML here.
 * Everything is built with the DOM and textContent. Lazy: team_page.js imports it. */
import { importOnce } from './import_once.js';
import { teamFetch } from './server_base.js';
import { refusedTooLarge } from './utils.js';
import { whenText } from './when_text.js';
import { refreshDistill, startDistill, distillJob } from './knowledge_distill.js';
const { teamTable, rowButton, rowFocusTarget, el } = await importOnce('./team_table.js'); // lazy modules load the others they need through importOnce, so a failed load is retried
const { openDetailPane, closeDetailPane, detailKey } = await importOnce('./detail_pane.js');

const model = { team: '', data: null, refused: false, failed: '', loading: false };
let root = null, hooks = {};
const say = (t) => { const s = root && root.querySelector('.team-knowledge-status'); if (s) { s.textContent = ''; s.textContent = t; } };
const btn = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };

/** The table's entries: the team's index first, then each agent's notes by name. */
export function entriesOf(data) {
    if (!data || !data.exists) return [];
    const out = [];
    if (data.index) out.push({ key: 'index', name: 'Index', text: data.index, from: 'The whole team' });
    for (const a of [...(data.agents || [])].sort((x, y) => String(x.name).localeCompare(String(y.name)))) out.push({ key: `agent:${a.name}`, name: a.name, text: a.content || '', from: `${a.name}'s sessions` });
    return out;
}

async function load() {
    const team = model.team; if (!team) return;
    if (!model.data) { model.loading = true; draw(); }
    let refused = false;
    const data = await teamFetch(team, n => `/api/teams/detail/${encodeURIComponent(n)}/knowledge`)
        .then(async r => { if (r.ok) return r.json(); refused = await refusedTooLarge(r); return null; }).catch(() => null);
    if (team !== model.team) return;
    model.loading = false; model.refused = refused;
    if (data) { model.data = data; model.failed = ''; hooks.onCount?.(entriesOf(data).length); }
    else if (!refused) model.failed = 'The knowledge could not be read.';
    draw();
}

function openEntry(entry, opener) {
    const when = model.data && model.data.created_at;
    openDetailPane({
        key: entry.key, opener, title: entry.name, sub: [whenText(when), entry.from].filter(Boolean).join(' · '),
        body: (host) => { host.replaceChildren(Object.assign(el('pre', 'team-task-text knowledge-text'), { textContent: entry.text || 'Nothing written yet.' })); },
        onClose: () => { root?.querySelectorAll('tr[aria-current="true"]').forEach(r => r.removeAttribute('aria-current')); },
    });
    root?.querySelectorAll('tr[data-key]').forEach(r => { if (r.dataset.key === entry.key) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current'); });
}

async function distill() {
    const team = model.team;
    try { await startDistill(team); say('Distilling the team’s knowledge…'); } catch (e) { say(`Could not start: ${e && e.message ? e.message : 'no answer'}`); }
    draw();
}

function draw() {
    const body = root && root.querySelector('.team-knowledge-body'); if (!body) return;
    const a = document.activeElement;
    const held = a && body.contains(a) ? (a.closest('tr[data-key]')?.dataset.key || (a.classList.contains('team-distill') ? '#distill' : '')) : '';
    body.replaceChildren();
    const running = distillJob(model.team).status === 'running';
    const bar = el('div', 'team-agents-top');
    const entries = entriesOf(model.data);
    bar.append(el('p', 'goals-note team-count-line', model.data && model.data.exists ? `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` : ''));
    const d = btn('btn btn-small team-distill', running ? 'Distilling…' : 'Distill knowledge', distill); d.disabled = running;
    if (running) d.setAttribute('aria-label', 'Distill knowledge, running');
    bar.append(d);
    body.append(bar);
    if (model.failed) { const f = el('div', 'goals-failed'); f.setAttribute('role', 'alert'); f.append(el('span', null, model.failed), btn('btn btn-small', 'Try again', () => load())); body.append(f); }
    if (model.loading) body.append(el('p', 'goals-note', 'Loading knowledge…'));
    else if (model.refused) body.append(el('div', 'goals-empty', 'This team’s knowledge is too large to show through Coral Hub; open it on the computer.'));
    else if (!entries.length) { if (!model.failed) body.append(el('div', 'goals-empty', 'No knowledge yet. Distill knowledge reads the team’s work and writes what each agent learned.')); }
    else {
        const stamp = model.data.created_at, wordsWhen = whenText(stamp);
        const when = () => { const t = el('span', null, wordsWhen); const d = new Date(stamp); if (!Number.isNaN(d.getTime())) t.title = d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); return t; }; // relative, with the exact time on hover
        body.append(teamTable({
            label: `Knowledge, ${entries.length}`, columns: ['Entry', 'Updated', 'From'],
            rows: entries.map(e => ({ key: e.key, current: detailKey() === e.key, open: (tr) => openEntry(e, tr.querySelector('.team-row-btn')), cells: [rowButton(e.name), when(), e.from] })),
        }));
    }
    if (held) (held === '#distill' ? body.querySelector('.team-distill') : rowFocusTarget(body, held))?.focus({ preventScroll: true });
}

// The run's progress: the button says so while it runs, and the table is read again when it ends.
document.addEventListener('coral:distill-status', (e) => {
    const { team, job, prev } = e.detail || {};
    if (!root || !root.isConnected || team !== model.team) return;
    if (prev && prev.status === 'running' && job.status !== 'running') { say(job.status === 'complete' ? 'Knowledge is ready.' : job.status === 'failed' ? `Distilling failed${job.error ? `: ${job.error}` : ''}.` : 'Distilling stopped.'); load(); }
    else draw();
});

/** Show the team's knowledge in `host`. hooks: onCount(n). */
export function showKnowledge(host, team, h = {}) {
    if (team !== model.team) Object.assign(model, { team, data: null, refused: false, failed: '', loading: false });
    hooks = h;
    if (!host.dataset.built) {
        host.dataset.built = '1';
        const page = el('div', 'goals-page goals-table-page');
        const status = el('div', 'team-knowledge-status sr-only'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        page.append(status, el('div', 'team-knowledge-body'));
        host.replaceChildren(page);
    }
    root = host.firstChild;
    draw();
    refreshDistill(team).then(draw, () => {});
    return load();
}

export { closeDetailPane };
