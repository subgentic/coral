/* Approved Goals mock v4: plain tasks with one-line linked documents and questions. */
import { importOnce } from './import_once.js';
import { markHidden } from './visible_marks.js';
import { isParked } from './goal_words.js';
const { el } = await importOnce('./dom_el.js');
const { taskWord } = await importOnce('./tasks_view.js');
const { taskHref, openTask } = await importOnce('./task_navigation.js');
const { moreMenu } = await importOnce('./more_menu.js');
const { avatar } = await importOnce('./data_table.js');
const { agentLink } = await importOnce('./agent_link.js');
const { readableName, itemKey } = await importOnce('./artifact_item.js');
const clean = s => markHidden(String(s || ''), { strict: true });
export const glyph = name => { const n = el('span', 'material-icons gl-kind', name); n.setAttribute('aria-hidden', 'true'); return n; };
export function ledgerTime(stamp, now = Date.now()) {
    const at = Date.parse(stamp); if (!Number.isFinite(at)) return '';
    const minutes = Math.max(0, Math.floor((now - at) / 60000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
    if (minutes < 10080) return `${Math.floor(minutes / 1440)} d ago`;
    return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(new Date(at).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) });
}
export function person(who, team, session = '') {
    if (!who) return el('span', 'gl-avatar-slot');
    const opts = { board: team, session }, node = agentLink(who, opts), circle = avatar(who, clean(who), opts).querySelector('.dt-avatar');
    node.replaceChildren(...(circle ? [circle] : [])); node.classList.add('gl-agent');
    if (node.tagName !== 'BUTTON') { node.setAttribute('role', 'img'); node.setAttribute('aria-label', clean(who)); }
    return node;
}
export function action(label, run, cls = '') { const b = el('button', `gl-action ${cls}`, label); b.type = 'button'; b.addEventListener('click', e => { e.stopPropagation(); run(b); }); return b; }
export function rowMenu(id, items) {
    const node = moreMenu(id, items, { label: 'Row actions', wrapClass: 'task-more gl-menu', restoreFocus: true });
    const b = node.querySelector('button'); b.textContent = '⋯'; b.setAttribute('aria-label', 'More actions'); return node;
}
function nameLink(title, href, run, cls = '') {
    const a = el('a', `gl-name ${cls}`, clean(title)); a.href = href; a.title = clean(title);
    a.addEventListener('click', e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return; e.preventDefault(); e.stopPropagation(); run(a); }); return a;
}
const tagClasses = { active: 'gl-active', review: 'gl-review', new: 'gl-new', approved: 'gl-approved', done: 'gl-done', blocked: 'gl-blocked', sentback: 'gl-sentback' };
const tag = (text, kind = '') => el('span', `chip chip-tag gl-tag ${tagClasses[kind] || ''}`, text);
function side({ status, kind, who, team, session, stamp, actions = [], menu = [] }, id) {
    const n = el('span', 'gl-side'), hover = el('span', 'gl-hover');
    for (const a of actions) hover.append(action(a.label, a.run));
    if (actions.length) n.append(hover);
    if (status) n.append(tag(status, kind));
    n.append(person(who, team, session)); const t = el('time', 'gl-time', ledgerTime(stamp)); if (stamp) { t.dateTime = stamp; t.title = new Date(stamp).toLocaleString(); } n.append(t);
    if (menu.length) n.append(rowMenu(id, menu)); return n;
}
function clickableRow(node, run) { node.addEventListener('click', e => { if (!e.target.closest('button,a,[role=menu]')) run(node.querySelector('.gl-name')); }); }
export function subjectRows(files, questions, { team, stateOf, openFile, openQuestion, dismissQuestion, fileContext, goalHref }) {
    const list = el('div', 'gl-subjects');
    const dealt = r => r.question ? !!r.a.answered : ['approved', 'denied', 'sentback'].includes(stateOf(r.a));
    const rows = [...questions.map(a => ({ a, question: true })), ...files.map(a => ({ a, question: false }))].sort((a, b) => Number(dealt(a)) - Number(dealt(b)));
    for (const { a, question } of rows) {
        const state = question ? a.answered ? 'answered' : 'question' : stateOf(a);
        const done = ['answered', 'approved', 'denied', 'sentback'].includes(state), row = el('div', `gl-subject list-row gl-row${done ? ' gl-done' : ''}`);
        if (question) row.dataset.subjectKind = 'question'; else { row.dataset.fileKey = itemKey(a); row.dataset.artifactId = itemKey(a); }
        const open = opener => question ? openQuestion(a, opener) : openFile(a, opener, fileContext(a));
        const title = question ? a.text || 'Question' : readableName(a), body = el('div', 'gl-subject-body');
        const href = question ? goalHref : a.uri || `coral://artifacts/${itemKey(a)}`;
        body.append(nameLink(title, href, open));
        const version = Number(a.version_number || a.version || a.file_latest_n || 0); if (!question && version > 1) body.append(el('span', 'gl-version', `(version ${version})`));
        const text = question ? state === 'answered' ? a.answer_text ? `You: “${clean(a.answer_text)}”` : '' : a.preview || a.text : a.review_note || a.review_question ? `“${a.review_note || a.review_question}”` : '';
        if (text) body.append(el('span', 'gl-preview', clean(text)));
        const status = question ? state === 'answered' ? 'Answered' : a.unread === false ? 'Question' : 'New' : ({ review: 'To review', approved: 'Approved', sentback: 'Asked for changes', denied: 'Denied' }[state] || '');
        const actions = question && !done ? [{ label: 'Answer', run: open }, ...(dismissQuestion ? [{ label: 'Dismiss', run: () => dismissQuestion(a) }] : [])] : [{ label: 'Open', run: open }];
        const icon = question ? glyph('waving_hand') : glyph(/image/.test(a.media_type || '') ? 'image' : 'description'); icon.setAttribute('aria-hidden', 'true');
        row.append(icon, body,
            side({ status, kind: question && !done ? 'new' : state, who: a.asker || a.produced_by || a.uploaded_by, team, session: a.session_id, stamp: a.answered_at || a.review?.at || a.created_at || a.at, actions, menu: question && !done ? actions : [] }, `goal-question-${encodeURIComponent(team)}-${a.id}`));
        clickableRow(row, open); list.append(row);
    }
    return list;
}
export function taskRows(tasks, { team, goalTitle, files, questions, ...opts }) {
    const list = el('div', 'goal-ledger-tasks'), done = t => ['completed', 'skipped'].includes(t.status);
    for (const t of [...tasks].sort((a, b) => Number(done(a)) - Number(done(b)))) {
        const group = el('div', 'gl-task-group'), row = el('div', `gl-task list-row gl-row${done(t) ? ' gl-done' : ''}`);
        const open = opener => openTask(team, t.id, opener, { from: goalTitle });
        const name = nameLink(t.title, taskHref(team, t.id), open); name.dataset.taskId = String(t.id); name.prepend(el('span', 'gl-id', `#${t.id} `));
        const word = t.status === 'skipped' ? 'Skipped' : t.status === 'parked' || isParked(t) ? 'Parked' : taskWord(t);
        const right = side({ status: word, kind: done(t) ? 'done' : t.status === 'blocked' || isParked(t) ? 'blocked' : t.status === 'in_progress' ? 'active' : '', who: t.assigned_to || t.completed_by, team, stamp: t.updated_at || t.created_at, actions: [{ label: 'Open task', run: open }] }, '');
        right.querySelector('.gl-tag')?.classList.add('goal-ledger-task-state');
        row.append(name, right); clickableRow(row, open); group.append(row);
        const mineFiles = files.filter(a => Number(a.task_id) === Number(t.id)), mineQuestions = questions.filter(a => Number(a.task_id) === Number(t.id));
        if (mineFiles.length || mineQuestions.length) { const subjects = subjectRows(mineFiles, mineQuestions, { team, ...opts }); subjects.dataset.subjectTaskId = String(t.id); group.append(subjects); }
        list.append(group);
    }
    return list;
}
