/* The approved Goals decision ledger (#21846). Reads expanded and nearby visible goals;
 * existing board artifact records remain the authority for identity and decisions. */
import { boardFetch, serverFetch, splitKey } from './server_base.js';
import { loadStyles } from './lazy_styles.js';
import { importOnce } from './import_once.js';
import { markHidden } from './visible_marks.js';

import { whenText } from './when_text.js';
import { pollEvery } from './overload.js';
import { onArtifactsRev } from './artifacts_feed.js';
import { allTasksOf } from './goal_words.js';
const { needsReviewAttention } = await importOnce('./inbox_review_state.js');
const { el } = await importOnce('./dom_el.js');
const Ledger = await importOnce('./goal_ledger_rows.js');
const DT = await importOnce('./data_table.js');
const { avatar, chip } = DT;

const { readGoalJSON } = await importOnce('./goal_view.js');
const { foldAllButton } = await importOnce('./fold_all_button.js');
const { agentLink, liveAgentOf } = await importOnce('./agent_link.js');
const { readableName, itemKey, managedHex } = await importOnce('./artifact_item.js');
const { fileContext } = await importOnce('./artifact_file_context.js');
await loadStyles('goal_decisions.css');
await loadStyles('goal_ledger.css');
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
/** Keep the shared agent navigation and identity while displaying only its icon. */
function agentIcon(who, team, session = '') {
    const opts = { board: team, session }, person = avatar(who, safe(who), opts);
    const link = agentLink(who, opts), icon = person.querySelector('.dt-avatar');
    link.replaceChildren(...(icon ? [icon] : []));
    link.classList.add('goal-decision-agent-icon');
    if (link.tagName !== 'BUTTON') { link.setAttribute('role', 'img'); link.setAttribute('aria-label', safe(who)); }
    return link;
}
/** Keyboard row links and agent buttons are separate controls; nothing is built from HTML. */
export function decisionList(items, { team, onOpen, headings = true }) {
    const list = el('ul', 'goal-decision-list'), ordered = decisionOrder(items), tasks = new Set(ordered.map(a => a.task_id)); let previous;
    for (const a of ordered) {
        if (headings && tasks.size > 1 && previous !== a.task_id) { const sub = el('li', 'goal-decision-subhead', a.task_id ? `Task #${a.task_id} ${safe(a.task_title)}` : 'No task'); list.append(sub); previous = a.task_id; }
        const status = decisionState(a), li = el('li', `list-row goal-decision-row ${classes[status]}`); if (status === 'review' && needsReviewAttention(a)) li.classList.add('is-unread'); li.dataset.fileKey = itemKey(a); li.dataset.artifactId = itemKey(a);
        const mark = el('span', 'goal-decision-mark', status === 'approved' ? '✓' : status === 'sentback' ? '↺' : '•'); mark.setAttribute('aria-hidden', 'true');
        const tile = el('span', 'goal-decision-type', /markdown/.test(a.media_type || '') || /\.md$/i.test(a.name) ? 'M↓' : '↗'); tile.setAttribute('aria-hidden', 'true');
        const open = () => onOpen(a, li.querySelector('.goal-decision-name'), decisionFiles(ordered, a, team));
        const name = button('goal-decision-name', readableName(a), open); name.title = readableName(a);
        const question = el('span', 'goal-decision-question', status === 'sentback' && a.review_note ? `Sent back: “${safe(a.review_note)}”` : [status === 'approved' ? 'Approved' : status === 'sentback' ? 'Sent back' : '', safe(a.review_question || '')].filter(Boolean).join(' · ')); question.title = question.textContent;
        const who = a.produced_by || a.uploaded_by || a.uploader || '', agent = el('span', 'goal-decision-agent');
        if (who) { agent.append(agentIcon(who, team, a.session_id || '')); const live = liveAgentOf(who, { board: team, session: a.session_id || '' }); if (status === 'sentback' && live) { const liveState = safe(live.status || ''); if (liveState) agent.append(el('span', 'goal-decision-live', ` · ${liveState}`)); } }
        const chip = el('span', `chip goal-decision-chip ${classes[status]}`, words[status]);
        const last = ['review', 'shared'].includes(status) ? button('goal-decision-open', 'Open ↗', open) : el('time', 'goal-decision-time', whenText(a.review?.at || a.created_at));
        li.append(mark, tile, name, question, agent, chip, last);
        li.addEventListener('click', e => { if (!e.target.closest('button,a')) open(); });
        list.append(li);
    }
    return list;
}
function counts(items) {
    const c = { approved: 0, sentback: 0, review: 0, denied: 0, shared: 0 }; for (const a of items) c[decisionState(a)]++;
    return c;
}
/** Source-qualified cache: a failed refresh keeps the prior records with an error. */
export function goalTracker({ goals, teamOf, openGoal, openTeam, openFile, closeGoal, questions = () => [], openQuestion = () => {}, dismissQuestion = null }) {
    mounted?.dispose();
    const root = el('div', 'goal-decision-tracker'), refreshers = [], visibleReads = new Map();
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(items => { for (const item of items) if (item.isIntersecting && item.target.isConnected) { observer.unobserve(item.target); visibleReads.get(item.target)?.(); } }, { rootMargin: '200px' }) : null;
    const cards = []; // each goal's key, paint and read, for the toolbar's expand-all / collapse-all
    mounted = { root, cards, refresh: () => refreshers.forEach(run => run()), dispose: () => observer?.disconnect() };
    const summary = el('p', 'gl-summary'); summary.append(el('strong', null, `${goals.length} ${goals.length === 1 ? 'goal' : 'goals'}`), ` · ${goals.filter(g => g.state === 'active').length} active`); root.append(summary);
    for (const [index, g] of goals.entries()) {
        const team = g.board_id, key = JSON.stringify([team, g.id]);
        if (!entries.has(key)) { if (entries.size >= 200) entries.delete(entries.keys().next().value); entries.set(key, { items: [], tasks: [], answered: [], at: 0, loaded: false, busy: false, error: '', cursor: '', waiters: [] }); }
        const st = entries.get(key), card = el('section', 'goal-decision-card'); card.dataset.goalKey = key;
        if (!folds.has(key)) { if (folds.size >= 200) folds.delete(folds.keys().next().value); folds.set(key, index < 2); }
        const bar = el('div', 'goal-decision-head list-row gl-goal-row'), body = el('div', 'goal-decision-body');
        const toggle = button('goal-decision-toggle', '', () => { folds.set(key, !folds.get(key)); paint(); if (folds.get(key)) load(false); syncFoldButtons(); });
        toggle.dataset.goalId = String(g.id);
        const open = opener => openGoal(g, 'tasks', opener), name = Ledger.action('', open, 'gl-goal-name');
        const id = el('span', 'goal-decision-id', `#${g.id}`), title = el('span', 'goal-decision-title', safe(g.title)); name.append(id, title);
        const facts = el('div', 'gl-goal-meta'), main = el('div', 'gl-goal-main'); main.append(name, facts);
        const hover = Ledger.action('Open goal', open, 'gl-goal-open'), time = el('time', 'gl-goal-time'), right = el('div', 'gl-goal-side');
        const menu = Ledger.rowMenu(`goal-menu-${encodeURIComponent(team)}-${g.id}`, [{ label: 'Open goal', run: open }, { label: 'Copy for an agent', run: () => importOnce('./agent_copy_button.js').then(m => m.copyForAgent('goal', `Goal #${g.id}: ${g.title}. Team ${team}. Run coral-board goal show ${g.id}.`)) }]);
        toggle.append(el('span', 'goal-decision-chevron', '▾')); right.append(hover, time, menu, toggle);
        bar.append(Ledger.glyph('flag'), main, right); card.append(bar, body); root.append(card);
        bar.addEventListener('click', e => { if (e.target.closest('button,a,[role=menu]')) return; if (matchMedia('(max-width:760px)').matches) toggle.click(); else open(name); });
        function paint() {
            const expanded = folds.get(key), stateLabel = safe(g.state ? g.state[0].toUpperCase() + g.state.slice(1) : 'Unknown');
            toggle.setAttribute('aria-expanded', String(expanded)); toggle.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} Goal #${g.id} ${safe(g.title)}, ${stateLabel}`);
            name.setAttribute('aria-label', `Open Goal #${g.id} ${safe(g.title)}`);
            card.classList.toggle('is-collapsed', !expanded); body.hidden = !expanded;
            const asks = [...(st.answered || []), ...questions(g).filter(a => !(st.answered || []).some(b => b.id === a.id && b.board === a.board))], c = counts(st.items), state = el('span', `goal-decision-state goal-state-${g.state || 'unknown'}`);
            state.title = stateLabel; state.setAttribute('aria-label', stateLabel); state.setAttribute('role', 'img');
            const taskProgress = el('span', 'goal-decision-task-progress', `${Number(g.rollup?.done) || 0} of ${allTasksOf(g.rollup || {})} tasks done`);
            const pending = asks.filter(a => !a.answered).length, waits = [pending ? `${pending} ${pending === 1 ? 'question' : 'questions'}` : '', c.review ? `${c.review} to review` : ''].filter(Boolean).join(' · ');
            facts.replaceChildren(state, taskProgress); if (g.new_comments > 0) facts.append(' · ', el('span', 'goal-new-comments', 'New comments')); if (waits) facts.append(' · ', el('strong', 'gl-waits', waits));
            const teamName = Ledger.action(safe(teamOf(g)), () => openTeam(g), 'goal-decision-team'); facts.append(' · ', teamName);
            const stamps = [g.updated_at || g.updatedAt, ...st.tasks.map(t => t.updated_at), ...st.items.map(a => a.review?.at || a.created_at), ...asks.map(a => a.answered_at || a.at)].filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a));
            time.textContent = Ledger.ledgerTime(stamps[0]); if (stamps[0]) { time.dateTime = stamps[0]; time.title = new Date(stamps[0]).toLocaleString(); }
            if (!expanded) return;
            const active = document.activeElement, focusKey = body.contains(active) ? active.closest('[data-file-key]')?.dataset.fileKey : '';
            const context = el('div', 'goal-decision-context'), done = el('div', 'goal-decision-done'); done.append(el('strong', null, 'Done when: '), safe(g.done_when || g.doneWhen || 'Not specified')); context.append(done); body.replaceChildren(context);
            if (st.tasks.length) {
                const count = st.tasks.filter(t => ['completed', 'skipped'].includes(t.status)).length;
                const heading = el('h3', 'gl-tasks-label', 'Tasks '); heading.append(el('span', null, `${st.tasks.length} · ${count} done`)); body.append(heading);
                body.append(Ledger.taskRows(st.tasks, { team, goalTitle: g.title, files: st.items, questions: asks, stateOf: decisionState,
                    openFile: (a, opener, files) => openFile(g, a, opener, files), openQuestion, dismissQuestion,
                    fileContext: a => decisionFiles(st.items, a, team), goalHref: `#goal-${g.id}` }));
            }
            const taskIds = new Set(st.tasks.map(t => Number(t.id))), looseFiles = st.items.filter(a => !taskIds.has(Number(a.task_id))), looseAsks = asks.filter(a => !taskIds.has(Number(a.task_id)));
            if (looseFiles.length || looseAsks.length) {
                const section = el('section', 'goal-only-subjects'); section.append(el('h3', 'gl-tasks-label', 'Goal documents and questions'));
                section.append(Ledger.subjectRows(looseFiles, looseAsks, { team, stateOf: decisionState, openFile: (a, opener, files) => openFile(g, a, opener, files), openQuestion, dismissQuestion, fileContext: a => decisionFiles(st.items, a, team), goalHref: `#goal-${g.id}` })); body.append(section);
            }
            if (st.error) { const e = el('p', 'goal-decision-error', st.error); e.setAttribute('role', 'alert'); e.append(button('btn btn-small', 'Retry', () => load(false, true))); body.append(e); }
            if (!st.loaded) body.append(el('p', 'goal-decision-note', st.error ? 'Decisions are unavailable.' : 'Loading…'));
            else if (!st.tasks.length && !st.items.length && !asks.length) body.append(el('p', 'goal-decision-note', 'No tasks, review documents or questions on this goal.'));
            if (st.cursor) { const more = button('btn btn-small', st.busy ? 'Loading…' : 'Load more files', () => load(true)); more.disabled = st.busy; body.append(more); }
            if (focusKey) [...body.querySelectorAll('[data-file-key]')].find(row => row.dataset.fileKey === focusKey)?.querySelector('.gl-name')?.focus({ preventScroll: true });
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
        async function readAnswered() {
            const source = splitKey(team), rows = new Map(), seen = new Set(); let cursor = '';
            do {
                const response = await limitedRead(() => serverFetch(source.server, `/api/operator-asks?board=${encodeURIComponent(source.name)}&goal=${encodeURIComponent(g.id)}&state=answered&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
                if (!response.ok) { const error = Error(`Answered questions could not be read (HTTP ${response.status}).`); error.status = response.status; throw error; }
                const data = await response.json();
                if (!Array.isArray(data.asks)) throw Error('Answered questions could not be read.');
                for (const a of data.asks) rows.set(a.id, { ...a, server: source.server, answered: true });
                cursor = typeof data.next_cursor === 'string' ? data.next_cursor : '';
                if (cursor && seen.has(cursor)) throw Error('Answered questions could not be read completely. Retry.');
                seen.add(cursor);
            } while (cursor);
            return [...rows.values()];
        }
        async function load(more, retry = false) {
            if (!folds.get(key) || (st.error && !retry)) return;
            if (st.busy) { st.waiters.push(() => { if (card.isConnected) paint(); }); return; }
            if ((!more && st.loaded && Date.now() - st.at < 30000)) return;
            st.busy = true;
            try { if (!more) { st.tasks = await readTasks(); st.answered = await readAnswered(); } const response = await limitedRead(() => boardFetch(team, `/artifacts?goal=${encodeURIComponent(g.id)}&tag=for%20review&tag=approved&tag=changes%20requested&tag=denied&versions=newest&sort=name&limit=50${more && st.cursor ? `&cursor=${encodeURIComponent(st.cursor)}` : ''}`)); if (response.status === 403 || response.status === 404) { st.items = []; st.tasks = []; st.answered = []; st.loaded = false; } if (!response.ok) throw Error(response.status === 403 ? 'Artifacts are only available to the account this computer is linked to.' : `Decisions could not be read (HTTP ${response.status}).`); const data = await response.json(); if (!Array.isArray(data.artifacts)) throw Error('Decisions could not be read.'); const merged = new Map((more ? st.items : []).map(a => [itemKey(a), a])); for (const a of data.artifacts) if (decisionState(a) !== 'shared') merged.set(itemKey(a), a); st.items = decisionOrder([...merged.values()]); st.cursor = typeof data.next_cursor === 'string' ? data.next_cursor : ''; st.loaded = true; st.at = Date.now(); st.error = ''; } catch (e) { if ([403, 404].includes(e.status)) { st.items = []; st.tasks = []; st.answered = []; st.loaded = false; } st.error = e.message || 'Decisions could not be read.'; } finally { st.busy = false; if (card.isConnected) paint(); for (const run of st.waiters.splice(0)) run(); }
        }
        refreshers.push(() => { if (folds.get(key)) load(false); }); cards.push({ key, paint, load: () => load(false) });
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
