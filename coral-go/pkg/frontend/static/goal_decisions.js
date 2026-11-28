/* The approved Goals decision ledger (#21846). Reads expanded and nearby visible goals;
 * existing board artifact records remain the authority for identity and decisions. */
import { boardFetch, splitKey } from './server_base.js';
import { loadStyles } from './lazy_styles.js';
import { importOnce } from './import_once.js';
import { markHidden } from './visible_marks.js';

import { whenText } from './when_text.js';
import { pollEvery } from './overload.js';
import { onArtifactsRev } from './artifacts_feed.js';
const { needsReviewAttention } = await importOnce('./inbox_review_state.js');
const { el } = await importOnce('./dom_el.js');
const { foldAllButton } = await importOnce('./fold_all_button.js');
const Tasks = await importOnce('./tasks_view.js');
const DT = await importOnce('./data_table.js');
const { avatar, chip } = DT;
const { isParked } = await importOnce('./goal_words.js');
const { readGoalJSON } = await importOnce('./goal_view.js');
const { agentLink, liveAgentOf } = await importOnce('./agent_link.js');
const { readableName, itemKey, managedHex } = await importOnce('./artifact_item.js');
const { fileContext } = await importOnce('./artifact_file_context.js');
await loadStyles('goal_decisions.css');
const safe = t => markHidden(String(t || ''), { strict: true });
const button = (cls, text, run) => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', run); return b; };
const entries = new Map(), folds = new Map(), foldButtons = new Set();
const cardsOf = () => mounted?.cards || [];
const allOpen = () => (cardsOf().length ? cardsOf().every(c => folds.get(c.key)) : null); // the goals' own state for the toolbar's expand-all / collapse-all (#22056)
const syncFoldButtons = () => { for (const b of foldButtons) { if (b.isConnected) b.dataset.live = '1'; else if (b.dataset.live) { foldButtons.delete(b); continue; } b.sync(); } };
/** The toolbar's expand-all / collapse-all for the goals on the page. */
export function goalFoldButton() {
    const b = foldAllButton('goals', { isOpen: allOpen, setAll: open => { for (const c of cardsOf()) { folds.set(c.key, open); c.paint(); if (open) c.load(); } syncFoldButtons(); } });
    b.classList.add('goals-fold-all'); foldButtons.add(b);
    return b;
}
let mounted = null, reading = 0; const readQueue = [];
async function limitedRead(run) { if (reading < 3) reading++; else await new Promise(resolve => readQueue.push(resolve)); try { return await run(); } finally { const next = readQueue.shift(); if (next) next(); else reading--; } }
export function decisionState(a) {
    const tags = a.tags || [];
    if (tags.includes('approved') || a.review?.state === 'approved') return 'approved';
    if (tags.includes('changes requested')) return 'sentback';
    if (tags.includes('denied')) return 'denied';
    return tags.includes('for review') ? 'review' : 'shared';
}
const classes = { approved: 'is-approved', sentback: 'is-sentback', denied: 'is-denied', review: 'is-review', shared: 'is-shared' };
const words = { approved: 'Approved', sentback: 'Sent back', denied: 'Denied', review: 'To review', shared: 'Shared' };
export const decisionOrder = items => [...items].sort((a, b) => Number(a.task_id || 0) - Number(b.task_id || 0) || readableName(a).localeCompare(readableName(b), undefined, { numeric: true }) || itemKey(a).localeCompare(itemKey(b)));
export const decisionFiles = (items, item, team) => ({ goalItems: items, ...fileContext(items, item, { key: itemKey, options: a => ({ hex: managedHex(a), server: splitKey(team).server, board: splitKey(team).name, filename: readableName(a), mediaType: a.media_type }) }) });
/** Keyboard row links and agent buttons are separate controls; nothing is built from HTML. */
export function decisionList(items, { team, onOpen }) {
    const list = el('ul', 'goal-decision-list'), ordered = decisionOrder(items), tasks = new Set(ordered.map(a => a.task_id)); let previous;
    for (const a of ordered) {
        if (tasks.size > 1 && previous !== a.task_id) { const sub = el('li', 'goal-decision-subhead', a.task_id ? `Task #${a.task_id} ${safe(a.task_title)}` : 'No task'); list.append(sub); previous = a.task_id; }
        const status = decisionState(a), li = el('li', `list-row goal-decision-row ${classes[status]}`); if (status === 'review' && needsReviewAttention(a)) li.classList.add('is-unread'); li.dataset.fileKey = itemKey(a); li.dataset.artifactId = itemKey(a);
        const mark = el('span', 'goal-decision-mark', status === 'approved' ? '✓' : status === 'sentback' ? '↺' : '•'); mark.setAttribute('aria-hidden', 'true');
        const tile = el('span', 'goal-decision-type', /markdown/.test(a.media_type || '') || /\.md$/i.test(a.name) ? 'M↓' : '↗'); tile.setAttribute('aria-hidden', 'true');
        const open = () => onOpen(a, li.querySelector('.goal-decision-name'), decisionFiles(ordered, a, team));
        const name = button('goal-decision-name', readableName(a), open); name.title = readableName(a);
        const question = el('span', 'goal-decision-question', status === 'sentback' && a.review_note ? `Sent back: “${safe(a.review_note)}”` : [status === 'approved' ? 'Approved' : status === 'sentback' ? 'Sent back' : '', safe(a.review_question || '')].filter(Boolean).join(' · ')); question.title = question.textContent;
        const who = a.produced_by || a.uploaded_by || a.uploader || '', agent = el('span', 'goal-decision-agent');
        if (who) { const person = avatar(who, safe(who), { board: team, session: a.session_id || '' }); person.querySelector('.dt-person-name')?.replaceWith(agentLink(who, { board: team, session: a.session_id || '' })); agent.append(person); const live = liveAgentOf(who, { board: team, session: a.session_id || '' }); if (status === 'sentback' && live) { const liveState = safe(live.status || ''); if (liveState) agent.append(el('span', 'goal-decision-live', ` · ${liveState}`)); } }
        const chip = el('span', `chip goal-decision-chip ${classes[status]}`, words[status]);
        const last = ['review', 'shared'].includes(status) ? button('goal-decision-open', 'Open ↗', open) : el('time', 'goal-decision-time', whenText(a.review?.at || a.created_at));
        li.append(mark, tile, name, question, agent, chip, last);
        li.addEventListener('click', e => { if (!e.target.closest('button,a')) open(); });
        list.append(li);
    }
    return list;
}
/** Questions use the same row geometry as review files. */
function subjectList(rows, kind, nameOf, whoOf, open) {
    const list = el('ul', 'goal-decision-list');
    for (const item of rows) {
        const row = el('li', 'list-row goal-decision-row'); row.dataset.subjectKind = kind;
        const title = safe(nameOf(item)), run = () => open(item, row.querySelector('.goal-decision-name'));
        const name = button('goal-decision-name', title, run); name.title = title;
        row.append(el('span', 'goal-decision-mark', '•'), el('span', 'goal-decision-type', '?'), name,
            el('span', 'goal-decision-question'), el('span', 'goal-decision-agent', safe(whoOf(item))),
            el('span', 'chip goal-decision-chip', 'Question'), button('goal-decision-open', 'Open ↗', run));
        row.addEventListener('click', e => { if (!e.target.closest('button,a')) run(); }); list.append(row);
    }
    return list;
}
function counts(items) {
    const c = { approved: 0, sentback: 0, review: 0, denied: 0, shared: 0 }; for (const a of items) c[decisionState(a)]++;
    return c;
}
/** Source-qualified cache: a failed refresh keeps the prior records with an error. */
export function goalTracker({ goals, teamOf, openGoal, openFile, closeGoal, questions = () => [], openQuestion = () => {} }) {
    mounted?.dispose();
    const root = el('div', 'goal-decision-tracker'), refreshers = [], visibleReads = new Map();
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(items => { for (const item of items) if (item.isIntersecting && item.target.isConnected) { observer.unobserve(item.target); visibleReads.get(item.target)?.(); } }, { rootMargin: '200px' }) : null;
    const cards = []; // each goal's key, paint and read, for the toolbar's expand-all / collapse-all
    mounted = { root, cards, refresh: () => refreshers.forEach(run => run()), dispose: () => observer?.disconnect() };
    for (const [index, g] of goals.entries()) {
        const team = g.board_id, key = JSON.stringify([team, g.id]);
        if (!entries.has(key)) { if (entries.size >= 200) entries.delete(entries.keys().next().value); entries.set(key, { items: [], tasks: [], taskState: DT.tableState(), at: 0, loaded: false, busy: false, error: '', cursor: '', waiters: [] }); }
        const st = entries.get(key), card = el('section', 'goal-decision-card'); card.dataset.goalKey = key;
        if (!folds.has(key)) { if (folds.size >= 200) folds.delete(folds.keys().next().value); folds.set(key, index < 2); }
        const bar = el('div', 'goal-decision-head'), toggle = button('goal-decision-toggle', '', () => { folds.set(key, !folds.get(key)); paint(); if (folds.get(key)) load(false); syncFoldButtons(); });
        toggle.dataset.goalId = String(g.id);
        toggle.append(el('span', 'goal-decision-chevron', '▾'), (() => { const s = chip(safe(g.state ? g.state[0].toUpperCase() + g.state.slice(1) : 'Unknown'), `goal-state-${g.state || 'unknown'}`); s.classList.remove('dt-chip'); s.classList.add('goal-decision-state'); return s; })(), el('span', 'goal-decision-id', `Goal #${g.id}`), el('span', 'goal-decision-title', safe(g.title)));
        const right = el('div', 'goal-decision-head-right'), summary = el('span', 'goal-decision-summary'), teamLabel = el('span', 'goal-decision-team', safe(teamOf(g)));
        if (Number(g.new_comments) > 0) right.append(chip('New comments', 'goal-new-comments'));
        const openArtifacts = button('btn btn-small btn-quiet goal-artifacts-open', '↗', () => openGoal(g, 'artifacts'));
        openArtifacts.title = 'Open goal artifacts'; openArtifacts.setAttribute('aria-label', 'Open goal artifacts');
        right.append(summary, teamLabel, openArtifacts); bar.append(toggle, right);
        const body = el('div', 'goal-decision-body'); card.append(bar, body); root.append(card);
        function paint() {
            const open = folds.get(key); toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} Goal #${g.id} ${safe(g.title)}, ${safe(g.state ? g.state[0].toUpperCase() + g.state.slice(1) : 'Unknown')}`); card.classList.toggle('is-collapsed', !open); body.hidden = !open;
            const c = counts(st.items), total = st.items.length;
            summary.hidden = st.loaded && !total;
            summary.textContent = st.error ? 'Decisions unavailable' : st.loaded ? `${c.review} to review · ${c.sentback} sent back · ${c.approved} approved${c.denied ? ` · ${c.denied} denied` : ''}${st.cursor ? ' (loaded files)' : ''}` : open ? 'Loading decisions…' : 'Expand to read decisions';
            if (!open) return;
            const active = document.activeElement, focusKey = body.contains(active) ? active.closest('[data-file-key]')?.dataset.fileKey : '', focusClass = focusKey ? active.className : '';
            const context = el('div', 'goal-decision-context'), done = el('div', 'goal-decision-done'); done.append(el('strong', null, 'Done when: '), safe(g.done_when || g.doneWhen || 'Not specified'));
            const progress = el('div', 'goal-decision-progress');
            if (st.loaded && total) { progress.append(el('span', null, `${c.approved} of ${total} approved · ${c.review} to review${st.cursor ? ' (loaded)' : ''}`)); const segments = el('div', 'goal-decision-segments'); segments.setAttribute('role', 'img'); segments.setAttribute('aria-label', `${c.approved} approved, ${c.review} to review, ${c.sentback} sent back, ${c.denied} denied`); for (const s of ['approved', 'review', 'sentback', 'denied']) { const n = c[s]; if (n) { const part = el('span', classes[s]); part.style.flexGrow = String(n); segments.append(part); } } progress.append(segments); }
            context.append(done, progress, el('span', 'goal-decision-age', whenText(g.updated_at || g.updatedAt))); body.replaceChildren(context);
            if (st.tasks.length) {
                const stateOf = t => t.status === 'skipped' ? 'Skipped' : t.status === 'parked' || isParked(t) ? 'Parked' : '';
                const tasks = Tasks.tasksTable('goal', st.tasks, { bare: true, fold: 'none', sortBar: false, state: st.taskState,
                    ctx: { goalTitleOf: () => g.title },
                    tweak: columns => columns.map(c => ['state', 'task'].includes(c.key) ? { ...c, cell: t => {
                        const node = c.cell(t), real = stateOf(t);
                        if (real && c.key === 'state') node.textContent = real;
                        if (real && c.key === 'task') node.querySelector('.dt-primary')?.setAttribute('aria-label', `Open task #${t.id}: ${t.title}, ${real}`);
                        return node;
                    } } : c),
                    open: (t, row) => importOnce('./task_navigation.js').then(m => m.openTask(team, t.id, row.querySelector('.dt-primary'), { from: g.title })) });
                tasks.el.classList.add('goal-ledger-tasks'); body.append(tasks.el);
            }
            if (st.error) { const e = el('p', 'goal-decision-error', st.error); e.setAttribute('role', 'alert'); e.append(button('btn btn-small', 'Retry', () => load(false, true))); body.append(e); }
            if (!st.loaded) body.append(el('p', 'goal-decision-note', st.error ? 'Decisions are unavailable.' : 'Loading decisions…'));
            else if (total) body.append(decisionList(st.items, { team, onOpen: (a, opener, files) => openFile(g, a, opener, files) }));
            else body.append(el('p', 'goal-decision-note', 'No files sent for review on this goal.'));
            const asks = questions(g);
            if (asks.length) body.append(subjectList(asks, 'question', a => a.text || 'Question', a => a.subscriber_id || a.asker || '', a => openQuestion(a)));
            if (st.cursor) { const more = button('btn btn-small', st.busy ? 'Loading…' : 'Load more files', () => load(true)); more.disabled = st.busy; body.append(more); }
            const foot = el('div', 'goal-decision-foot'); foot.append(el('span', null, `Click a decision to inspect in Goal #${g.id} › Artifacts.`)); const links = el('span'); for (const [tab, label] of [['tasks', `Tasks (${Number.isSafeInteger(g.rollup?.total) ? g.rollup.total : ['done', 'active', 'blocked', 'queued'].reduce((n, k) => n + (Number(g.rollup?.[k]) || 0), 0)})`], ['comments', `Comments (${Number.isSafeInteger(g.comments_open) ? g.comments_open : '—'})`]]) links.append(button('btn btn-small btn-quiet', label, () => openGoal(g, tab))); if (closeGoal && !['done', 'dropped'].includes(g.state)) links.append(button('btn btn-small btn-quiet', 'Close goal', () => closeGoal(g))); foot.append(links); body.append(foot);
            if (focusKey) [...body.querySelectorAll('[data-file-key]')].find(row => row.dataset.fileKey === focusKey)?.querySelector(`button.${CSS.escape(String(focusClass).split(' ')[0])}`)?.focus({ preventScroll: true });
        }
        async function readTasks() {
            const rows = new Map(), seen = new Set(); let cursor = '';
            do {
                const data = await limitedRead(() => readGoalJSON(team, `/tasks?goal=${encodeURIComponent(g.id)}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
                if (!Array.isArray(data.tasks)) throw Error('Tasks could not be read.');
                for (const t of data.tasks) rows.set(t.id, t);
                cursor = typeof data.next_cursor === 'string' ? data.next_cursor : '';
                if (cursor && seen.has(cursor)) throw Error('The task list could not be read completely. Retry.');
                seen.add(cursor);
            } while (cursor);
            return [...rows.values()];
        }
        async function load(more, retry = false) {
            if (st.error && !retry) return;
            if (st.busy) { st.waiters.push(() => { if (card.isConnected) paint(); }); return; }
            if ((!more && st.loaded && Date.now() - st.at < 30000)) return;
            st.busy = true;
            try { if (!more) st.tasks = await readTasks(); const response = await limitedRead(() => boardFetch(team, `/artifacts?goal=${encodeURIComponent(g.id)}&tag=for%20review&tag=approved&tag=changes%20requested&tag=denied&versions=newest&sort=name&limit=50${more && st.cursor ? `&cursor=${encodeURIComponent(st.cursor)}` : ''}`)); if (response.status === 403 || response.status === 404) { st.items = []; st.loaded = false; } if (!response.ok) throw Error(response.status === 403 ? 'Artifacts are only available to the account this computer is linked to.' : `Decisions could not be read (HTTP ${response.status}).`); const data = await response.json(); if (!Array.isArray(data.artifacts)) throw Error('Decisions could not be read.'); const merged = new Map((more ? st.items : []).map(a => [itemKey(a), a])); for (const a of data.artifacts) if (decisionState(a) !== 'shared') merged.set(itemKey(a), a); st.items = decisionOrder([...merged.values()]); st.cursor = typeof data.next_cursor === 'string' ? data.next_cursor : ''; st.loaded = true; st.at = Date.now(); st.error = ''; } catch (e) { st.error = e.message || 'Decisions could not be read.'; } finally { st.busy = false; if (card.isConnected) paint(); for (const run of st.waiters.splice(0)) run(); }
        }
        refreshers.push(() => { if (folds.get(key) || st.loaded) load(false); }); cards.push({ key, paint, load: () => load(false) });
        visibleReads.set(card, () => load(false)); observer?.observe(card);
        paint(); if (folds.get(key)) queueMicrotask(() => { if (card.isConnected) load(false); });
    }
    syncFoldButtons();
    return root;
}
// Existing decisions notify every ledger. Invalidate rather than inventing local review state.
pollEvery(() => { if (mounted?.root.isConnected && mounted.root.getClientRects().length) mounted.refresh(); }, 30000);
function changed() { for (const st of entries.values()) st.at = 0; if (mounted?.root.isConnected && mounted.root.getClientRects().length) mounted.refresh(); }
onArtifactsRev(changed);
for (const type of ['coral:review-approved', 'coral:reviews-changed']) document.addEventListener(type, changed);
