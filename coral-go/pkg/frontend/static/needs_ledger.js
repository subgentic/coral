/* #22094: the approved Needs you list. Existing owners supply every action;
 * this view only groups, lays out and selects the rows already read by Inbox. */
import { el } from './dom_el.js';
import { markHidden } from './visible_marks.js';
import { menuMove } from './menu_keys.js';
import { loadStyles } from './lazy_styles.js';
await loadStyles('needs_ledger.css');
const folds = new Map();
const keepFold = (key, open) => { if (!folds.has(key) && folds.size >= 500) folds.delete(folds.keys().next().value); folds.set(key, open); };
const safe = s => markHidden(String(s || ''), { strict: true });
const button = (label, cls, run) => { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', e => { e.stopPropagation(); run(e); }); return b; };
const icon = (name, label) => { const i = el('span', 'material-icons nl-icon', name); if (label) { i.setAttribute('role', 'img'); i.setAttribute('aria-label', label); } else i.setAttribute('aria-hidden', 'true'); return i; };
const timeOf = r => Date.parse(r.waiting_since || r.operatorAsk?.at || r.review?.created_at || '') || 0;
const question = r => !!r.operatorAsk || r.waiting_kind === 'ask' || r.waiting_kind === 'question';
const permission = r => r.waiting_kind === 'permission';
export function needsLedger(cfg) {
    const { rows, state, keyOf, about, unread, name, source, actions, open, agentLink, teamLink, goalLink, taskLink, bulkActions, eligible } = cfg;
    const root = el('section', 'needs-ledger'); root.setAttribute('aria-label', 'Needs you');
    const summary = el('div', 'nl-summary'), lists = el('div', 'nl-lists'); root.append(summary, lists);
    let selecting = state.select || state.selected.size > 0;
    const checks = [], groups = [], controllers = [];
    const here = new Set(rows.map(keyOf)); for (const key of state.rowCache?.keys() || []) if (!here.has(key) && !state.selected.has(key)) state.rowCache.delete(key);
    for (const row of rows) state.rowCache?.set(keyOf(row), row);
    const chosen = () => rows.filter(r => state.selected.has(keyOf(r)));
    const api = { el: root, state, foldState: () => controllers.length ? controllers.every(c => !c.body.hidden) : null, setAll: open => { for (const c of controllers) c.set(open); cfg.onFoldChange?.(); }, selection: () => new Set(state.selected), clear: () => { state.selected.clear(); selecting = false; sync(); } };
    function checkbox(items, label) {
        const hit = el('label', 'nl-check-hit'), input = el('input', 'check nl-check'); input.type = 'checkbox'; input.setAttribute('aria-label', label); hit.append(input);
        input.addEventListener('change', () => { for (const r of items.filter(eligible)) (input.checked ? state.selected.add(keyOf(r)) : state.selected.delete(keyOf(r))); sync(); });
        hit.addEventListener('click', e => e.stopPropagation()); checks.push({ input, items }); return hit;
    }
    function sync() {
        const selected = chosen(); root.classList.toggle('nl-selection-active', selecting || !!selected.length); state.select = selecting;
        for (const { input, items } of checks) { const available = items.filter(eligible), n = available.filter(r => state.selected.has(keyOf(r))).length; input.checked = n > 0 && n === available.length; input.indeterminate = n > 0 && n < available.length; input.disabled = !available.length; }
        root.querySelectorAll('[data-needs-key]').forEach(n => n.classList.toggle('nl-is-selected', state.selected.has(n.dataset.needsKey)));
        summary.replaceChildren(checkboxTop, el('strong', '', selected.length ? `${selected.length} selected` : `${rows.length} items`));
        if (!selected.length) { summary.append(el('span', 'nl-summary-new', `· ${rows.filter(unread).length} new`)); const select = button(selecting ? 'Cancel' : 'Select', 'btn btn-small btn-quiet nl-selection-mode', () => { if (selecting) api.clear(); else { selecting = true; sync(); } }); summary.append(select); }
        else {
            for (const label of ['Dismiss', 'Mark read']) { const action = bulkActions.find(a => a.label === label); if (!action) continue; const b = button(label === 'Mark read' ? 'Mark as read' : label, 'btn btn-small', () => action.run(chosen())); b.disabled = !!action.disabled?.(selected) || !!action.hidden?.(selected); if (b.disabled) b.title = action.why?.(selected) || 'Not available for these items'; summary.append(b); }
            summary.append(button('Clear', 'btn btn-small btn-quiet', api.clear));
        }
    }
    const checkboxTop = checkbox(rows, 'Select all items');
    function meta(row, flat) {
        const a = about(row), box = el('div', 'nl-meta'), add = node => { if (!node) return; if (box.childNodes.length) box.append(document.createTextNode(' · ')); box.append(node); };
        if (!row.review) add(agentLink(row));
        if (flat || !a.goalId || permission(row)) add(teamLink(row));
        if (flat && a.goalId) add(goalLink(a));
        if (a.taskId && (flat || !permission(row))) add(taskLink(a));
        return box;
    }
    function more(side, entries, label) {
        if (!entries.length) return;
        const details = el('details', 'nl-more'), toggle = el('summary', 'nl-more-toggle'); toggle.setAttribute('aria-label', `More actions for ${safe(label)}`); toggle.append(icon('more_horiz')); details.append(toggle);
        const menu = el('div', 'menu nl-menu'); menu.setAttribute('role', 'menu'); for (const entry of entries) { const item = button(entry.label, 'menu-item', () => { details.open = false; entry.run(); }); item.setAttribute('role', 'menuitem'); menu.append(item); } details.append(menu); side.append(details);
        details.addEventListener('keydown', e => { const items = [...menu.querySelectorAll('button')], index = menuMove(e.key, items.length, items.indexOf(document.activeElement)); if (index >= 0) { e.preventDefault(); e.stopPropagation(); details.open = true; items[index].focus(); } });
        details.addEventListener('focusout', e => { if (!details.contains(e.relatedTarget)) details.open = false; });
        details.addEventListener('toggle', () => { if (details.open) root.querySelectorAll('details[open]').forEach(other => { if (other !== details) other.open = false; }); });
    root.addEventListener('keydown', e => { if (e.key === 'Escape' && details.open) { e.preventDefault(); e.stopPropagation(); details.open = false; toggle.focus(); } });
    }
    function rowNode(row, flat = false) {
        const a = about(row), isQuestion = question(row), isPermission = permission(row), r = el('article', `nl-row${isQuestion ? ' nl-question' : ''}${isPermission ? ' nl-permission' : ''}${row.review ? ' nl-file' : ''}`), body = el('div', 'nl-body'), side = el('div', 'nl-side');
        r.dataset.needsKey = keyOf(row); r.tabIndex = 0;
        r.append(checkbox([row], `Select ${safe(name(row))}`));
        const kindIcon = row.review ? (/image\//.test(row.review.media_type || '') ? 'image' : /html/.test(row.review.media_type || '') ? 'code' : 'description') : isPermission ? 'lock' : isQuestion ? 'waving_hand' : 'inbox';
        r.append(!row.review && !isPermission && !isQuestion ? cfg.kindIcon(row) : icon(kindIcon, row.review ? 'File for review' : isPermission ? 'Permission prompt' : 'Question'), body, side);
        const words = safe(cfg.words(row)).replace(/^\s*@Operator\s*:?\s*/i, ''), lines = words.split('\n').filter(Boolean);
        const title = row.review ? safe(row.review.name) : isPermission ? `${safe(name(row))} ${/^Wants to run:/i.test(words) ? 'wants to run a command' : 'needs permission'}` : isQuestion ? lines[0] || 'Question' : safe(name(row));
        const heading = el('div', 'nl-title', isQuestion && title.length > 160 ? title.slice(0,159)+'…' : title); r.setAttribute('aria-label', title);
        if (row.review) { const fileButton = button(title, 'nl-file-open', () => open(row)); heading.replaceChildren(fileButton); if (Number(row.review.version) > 1) heading.append(el('span', 'nl-version', `version ${row.review.version}`)); }
        body.append(heading);
        if (row.review) { const note = cfg.fileQuestion(row); if (note) body.append(el('div', 'nl-meta', safe(note))); }
        else body.append(meta(row, flat));
        const contextNote = cfg.contextNote(row); if (contextNote) body.append(el('div', 'nl-meta', safe(contextNote)));
        if (!row.review && !isQuestion && !isPermission && words) body.append(el('div', 'nl-other-text', words));
        if (isQuestion && (lines.length > 1 || title.length > 160)) { const box = el('div', 'nl-question-box'), text = title.length > 160 ? words : lines.slice(1).join('\n'); cfg.questionBox(box, row, text); body.append(box); }
        if (isPermission) body.append(el('code', 'nl-command', words.replace(/^Wants to run:\s*/i, '')));
        let actionNode = actions(row);
        const extras = [{ label: row.review ? 'Open file' : isPermission ? 'Open terminal' : isQuestion ? 'Open question' : 'Open', run: () => isPermission ? cfg.openTerminal(row) : open(row) }];
        if (isPermission && eligible(row)) extras.push({ label: 'Dismiss', run: () => cfg.dismissPrompt(row) });
        if (actionNode instanceof Node) {
            actionNode.classList.add('nl-actions');
            for (const b of actionNode.querySelectorAll('button')) {
                if (b.textContent.trim() === 'Dismiss') { extras.push({ label: 'Dismiss', run: () => b.click() }); b.hidden = true; }
                if (isQuestion && ['Answer', 'Custom answer'].includes(b.textContent.trim())) b.textContent = 'Write an answer';
            }
            if (isQuestion) actionNode.addEventListener('click', e => { const b = e.target.closest('button'); if (b?.textContent.trim() === 'Write an answer') cfg.readQuestion(row); }, { capture: true });
            if (row.review) actionNode.hidden = true; // files open once; review decisions stay in the viewer
            body.append(actionNode);
        }
        const extraActions = [...new Map(extras.map(entry => [entry.label, entry])).values()];
        if (row.review) side.append(cfg.fileAgent(row));
        if (unread(row)) side.append(el('span', 'nl-new', 'New'));
        const when = el('time', 'nl-when', cfg.when(row)); when.dateTime = row.waiting_since || ''; side.append(when);
        if (!row.review) { const hover = el('span', 'nl-hover-actions'); for (const entry of extraActions.filter(x => !isQuestion || x.label === 'Dismiss')) hover.append(button(entry.label, 'btn btn-small btn-quiet', entry.run)); side.prepend(hover); more(side, extraActions, title); }
        r.addEventListener('click', e => { if (!e.target.closest('button,a,input,label,details')) open(row); });
        r.addEventListener('keydown', e => { if (e.target === r && e.key === 'Enter') { e.preventDefault(); open(row); } });
        return r;
    }
    const newest = list => Math.max(0, ...list.map(timeOf)), ordered = list => [...list].sort((a, b) => timeOf(b) - timeOf(a) || keyOf(a).localeCompare(keyOf(b)));
    const prompts = ordered(rows.filter(permission)), rest = rows.filter(r => !permission(r));
    const section = (label, count) => { const h = el('h3', 'nl-section', label); h.append(el('span', 'nl-count', String(count))); lists.append(h); const box = el('div', 'nl-list'); lists.append(box); return box; };
    if (!cfg.grouped) { const box = el('div', 'nl-list'); lists.append(box); for (const row of ordered(rows)) box.append(rowNode(row, true)); }
    else {
        if (prompts.length) { const box = section('Permission prompts', prompts.length); for (const row of prompts) box.append(rowNode(row)); }
        const byGoal = new Map(); for (const row of rest) { const a = about(row), key = a.goalId ? JSON.stringify([a.team, a.goalId]) : 'direct'; if (!byGoal.has(key)) byGoal.set(key, { key, a, rows: [] }); byGoal.get(key).rows.push(row); }
        groups.push(...[...byGoal.values()].sort((a, b) => newest(b.rows) - newest(a.rows) || a.key.localeCompare(b.key)));
        if (groups.length) {
            const box = section('By goal', groups.length);
            for (const g of groups) {
                const questions = ordered(g.rows.filter(question)), files = ordered(g.rows.filter(r => r.review)), other = ordered(g.rows.filter(r => !question(r) && !r.review));
                const openNow = folds.has(g.key) ? folds.get(g.key) : questions.length > 0, head = el('div', 'nl-group-head'), groupBody = el('div', 'nl-group-body');
                head.classList.toggle('nl-goal', !!g.a.goalId); head.append(checkbox(g.rows, `Select ${safe(g.a.goalTitle || 'Not tied to a goal')}`), icon(g.a.goalId ? 'flag' : 'radio_button_unchecked', g.a.goalId ? 'Goal' : 'Not tied to a goal'));
                const main = el('div', 'nl-body'), toggle = button('', 'nl-group-toggle', () => { keepFold(g.key, groupBody.hidden); groupBody.hidden = !groupBody.hidden; toggle.setAttribute('aria-expanded', String(!groupBody.hidden)); head.classList.toggle('nl-open', !groupBody.hidden); });
                toggle.setAttribute('aria-expanded', String(openNow)); const title = el('span', 'nl-title'); if (g.a.goalId) title.append(el('span', 'nl-goal-id', `#${g.a.goalId}`), document.createTextNode(' '+safe(g.a.goalTitle || 'Goal'))); else title.textContent = 'Not tied to a goal'; toggle.append(title); main.append(toggle);
                const counts = [questions.length ? `${questions.length} ${questions.length === 1 ? 'question' : 'questions'}` : '', files.length ? `${files.length} to review` : '', other.length ? `${other.length} other items` : ''].filter(Boolean).join(' · '), detail = el('div', 'nl-meta'); detail.append(el('strong', '', counts));
                const progress = cfg.goalProgress?.(g.a); if (progress) detail.append(document.createTextNode(' · '+progress)); if (g.a.goalId) { detail.append(document.createTextNode(' · ')); detail.append(teamLink(g.rows[0])); } main.append(detail); head.append(main);
                const side = el('div', 'nl-side'); side.append(el('time', 'nl-when', cfg.when(ordered(g.rows)[0])));
                if (g.a.goalId) { const openGoal = () => cfg.openGoal(g.a); const hover = button('Open goal', 'btn btn-small btn-quiet nl-hover-actions', openGoal); side.prepend(hover); more(side, [{ label: 'Open goal', run: openGoal }], g.a.goalTitle); }
                const chev = icon(openNow ? 'expand_less' : 'expand_more'); side.append(chev); toggle.addEventListener('click', () => { chev.textContent = groupBody.hidden ? 'expand_more' : 'expand_less'; }); head.append(side); head.classList.toggle('nl-open', openNow); groupBody.hidden = !openNow;
                const set = open => { keepFold(g.key, open); groupBody.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); head.classList.toggle('nl-open', open); chev.textContent = open ? 'expand_less' : 'expand_more'; };
                controllers.push({ body: groupBody, set }); toggle.addEventListener('click', () => cfg.onFoldChange?.());
                const add = (label, items) => { if (!items.length) return; const h = el('h4', 'nl-subhead', label); h.append(el('span', 'nl-count', String(items.length))); groupBody.append(h); for (const row of items) groupBody.append(rowNode(row)); };
                add('Questions', questions); add('To review', files); add('Other items', other); box.append(head, groupBody);
            }
        }
    }
    root.addEventListener('keydown', e => {
        if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.target.closest('input,textarea,select,details')) return;
        const keys = ['ArrowDown','ArrowUp','Home','End']; if (!keys.includes(e.key)) return;
        const nodes = [...root.querySelectorAll('.nl-row,.nl-group-toggle')].filter(n => n.getClientRects().length), current = e.target.closest('.nl-row,.nl-group-toggle'), i = nodes.indexOf(current); if (i < 0) return;
        e.preventDefault(); const next = e.key === 'Home' ? 0 : e.key === 'End' ? nodes.length-1 : Math.max(0,Math.min(nodes.length-1,i+(e.key === 'ArrowDown' ? 1 : -1))); nodes[next]?.focus();
    });
    root.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented && state.selected.size && !e.target.closest('input:not(.check),textarea,details[open]')) { e.preventDefault(); api.clear(); } });
    api.sync = sync; sync(); return api;
}
