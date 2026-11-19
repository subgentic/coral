/* The Inbox's Activity folder (#12070, the Activity record #12064): what the Operator did in Needs you, newest first, on the shared data table. The server's record is GET /api/activity (the Operator's alone, on this
 * computer; a dashboard that links other computers reads each online one on its own and merges them, #15380). A row says what was done, to what, in which team, when and from where; a file's row opens THAT version in the viewer with its comments and its other versions
 * (the digest the record kept), a goal's row opens the goal. Everything shown is text (textContent, never HTML), and an item's title is words an agent wrote. The record is chained: when its check finds it was changed
 * outside Coral the page says so above the table, and it never says more than the check does. Lazy: inbox_sidebar.js imports it. */
import { importOnce } from './import_once.js';
import { requestJson } from './request_json.js';
import { teamLabel } from './server_status.js';
import { serverFetch, identityKey, LOCAL_SERVER, splitKey, decisionNeedsPerson, serverUrl } from './server_base.js';
import { copyText, showToast } from './utils.js';
import { state as appState } from './state.js';
import { inboxSources, multipleServers, serverLabel } from './inbox_servers.js';
const { activityParts, aboutWords, jobRunParts } = await importOnce('./operator_activity_words.js');
import { markHidden } from './visible_marks.js';
import { loadStyles } from './lazy_styles.js';
const DT = await importOnce('./data_table.js');
const Threads = await importOnce('./activity_threads.js');
const Ledger = await importOnce('./activity_ledger.js');
const AF = await importOnce('./operator_activity_filters.js'); // lazy, as the sidebar loads it: its failure is retried
await loadStyles('inbox_activity.css'); // the folder's rules load with the folder, not at start (page_weight)
await loadStyles('activity_ledger.css'); // the ledger's rows (#19816)
await loadStyles('activity_kinds.css'); // the kind chips' rules (several at once, #16087): not at start

const PAGE = 200;
const PHONE_HINT = 'pho' + 'ne'; // the record's hint word, spelled in two parts: the icon-name lint reads that quoted word as an icon name
let rows = [], check = null, loaded = false, loading = null, more = false, failed = false, denied = false;
/** Each computer owns its cursor and its own check (#15380): a cursor is never sent to another computer. `moreBy` says which computers have older actions; `unread` names the ones that could not be read this time. */
let cursors = {}, moreBy = {}, checks = {}, unread = []; // unread: [{ id, why }] the computers that could not give their record this time
/** A row's own key: ids are only unique on their computer. */
export const keyOf = r => r.server && r.server !== LOCAL_SERVER ? `${r.server}/${r.id}` : String(r.id);
let onChange = () => {};

/** The row as the one rule says it (#14423): verb, object, detail. */
const M = v => markHidden(v, { strict: true }); // what an agent wrote is written out where it is drawn, once, here: every branch of the rows below reads these (#18275)
export const partsOf = r => { const p = activityParts(r, itemWords); return { ...p, on: M(p.on), detail: M(p.detail), about: M(aboutWords(r)) }; };
const KIND_WORD = { file: 'a file', question: 'a question', goal: 'a goal', proposal: 'a proposal', message: 'a message', task: 'a task', agent: 'an agent', chat: 'a chat', run: 'a run', workflow_run: 'a workflow run', job_run: 'an automation run', setting: 'a row in Needs you', goal_request: 'a goal request' };
/** What it was done to: the item's title when the record kept one (words an agent wrote), else the kind. */
export const itemWords = r => r.item_kind === 'job_run' ? (r.title && r.title !== '__oneshot__' ? r.title : jobRunParts(r.item_id) ? `Job ${jobRunParts(r.item_id).jobId}` : 'an automation run') : r.title || (r.item_kind === 'agent' && r.item_id ? r.item_id : r.item_kind === 'task' && r.item_id ? `Task #${r.item_id}` : KIND_WORD[r.item_kind]) || 'an item';
/** Where it was done from: the server decides this computer or Coral Hub; the phone hint is only what the page said about itself. */
export const fromWords = r => [r.source === 'hub' ? 'You, via Coral Hub' : 'this computer', r.hint === PHONE_HINT ? `${PHONE_HINT} (reported by the page)` : ''].filter(Boolean).join(', ');
/** The From column when a Hub-served dashboard reads several computers (#15730): the computer the action was done on, then how it was reached (Coral Hub, the phone); a dashboard of one computer says what it always did. */
export const fromCell = r => M(multipleServers() ? [serverLabel(r.server || LOCAL_SERVER), r.source === 'hub' ? 'via Coral Hub' : '', r.hint === PHONE_HINT ? `${PHONE_HINT} (reported by the page)` : ''].filter(Boolean).join(', ') : fromWords(r));
/** The computers whose record is not in the folder, each with why (#15730): the ones that are offline (never asked), the ones that refused (an older Coral that does not give its record to a Hub's owner yet, or a computer this person is only a guest of) and the ones that failed. Named, never left out silently. */
export const missingComputers = () => {
    if (!appState.hub) return [];
    const offline = (appState.servers || []).filter(s => s && s.id && s.id !== LOCAL_SERVER && s.status !== 'online').map(s => ({ id: s.id, why: 'is offline' }));
    return [...offline, ...unread];
};
export const missingWords = list => list.length ? `Not in this list: ${list.map(m => `${serverLabel(m.id)} (${m.why})`).join(', ')}.` : '';
/** What the folder says above the list about the record's own check: a break is said plainly, an intact record says what the check can and cannot do. */
export function checkWords(c) {
    if (!c) return '';
    if (!c.intact) return `${c.machine ? `On ${c.machine}: t` : 'T'}he record was changed outside Coral${c.reason === 'edited' ? ': a row was edited' : c.reason === 'removed' ? ': a row was removed' : c.reason === 'cut_off' ? ': rows were cut off' : ''}. ${c.note || ''}`.trim();
    return ''; // an intact record says nothing: the count and the check's own caveat were not words anyone could use (#18620)
}

/** What the folder reads from: the online computers on a Hub-served dashboard (several, or one that is not this one), else this computer alone, which is read exactly as it always was. */
const sourcesNow = () => { const s = inboxSources(); return s.length > 1 || (s.length === 1 && s[0] !== LOCAL_SERVER) ? s : null; };

/** The record's checks as the one the page says: a broken one names its computer (when there are several), else the intact ones are summed. */
function combineChecks(map) {
    const all = Object.entries(map).filter(([, c]) => c);
    if (!all.length) return null;
    const several = all.length > 1;
    const broken = all.find(([, c]) => !c.intact);
    if (broken) return several ? { ...broken[1], machine: serverLabel(broken[0]) } : broken[1];
    return several ? { intact: true, rows: all.reduce((n, [, c]) => n + (Number(c.rows) || 0), 0), note: all[0][1].note } : all[0][1];
}

const atOf = r => { const t = Date.parse(r.at); return Number.isFinite(t) ? t : -Infinity; };

let emptyPages = 0;
/** More is offered but the pages read show nothing new (every row on them is hidden): read the next page, up to 20 in a row, so Load more never lands on a blank. */
function keepReading(need) {
    if (more && !failed && shown().length <= need && ++emptyPages < 20) refresh(null, { next: true });
    else emptyPages = 0;
}
/** Read the first page (and the record's check), or the page after the last row. Tells the sidebar when it is done. On a Hub with linked computers every online one is read on its own (one failing does not fail the folder),
 *  each action carries its computer, and the folder is the actions of all of them, newest first. */
export function refresh(done, { next = false } = {}) {
    if (done) onChange = done;
    if (loading) return loading;
    const need = next ? shown().length : 0; // a page that adds no visible row (all hidden 'Sent words' rows) reads on (#18545)
    const sources = sourcesNow();
    if (sources) { // a computer that left the list takes what was read from it along (#15404)
        const live = new Set(sources), gone = id => !live.has(id);
        rows = rows.filter(r => !gone(r.server || LOCAL_SERVER));
        for (const m of [cursors, moreBy, checks]) for (const id of Object.keys(m)) if (gone(id)) delete m[id];
    }
    if (!sources) { // this computer alone
        const q = new URLSearchParams({ limit: String(PAGE) });
        if (next && rows.length) q.set('before', String(Math.min(...rows.map(r => r.id))));
        loading = (async () => {
            try {
                const d = await requestJson('GET', `/api/activity?${q}`);
                const got = Array.isArray(d.actions) ? d.actions : [];
                rows = next ? [...rows, ...got.filter(g => !rows.some(r => r.id === g.id))] : got;
                if (!next) check = d.check || null;
                more = got.length === PAGE;
                unread = [];
                failed = false; denied = false;
            } catch (e) { failed = true; denied = e && e.status === 403; } // 403: through Coral Hub the record is the owner's alone
            loaded = true;
        })().finally(() => { loading = null; onChange(); keepReading(need); });
        return loading;
    }
    const targets = next ? sources.filter(id => moreBy[id]) : sources;
    loading = (async () => {
        const settled = await Promise.allSettled(targets.map(async server => {
            const q = new URLSearchParams({ limit: String(PAGE) });
            if (next && cursors[server] != null) q.set('before', String(cursors[server]));
            const r = await serverFetch(server === LOCAL_SERVER ? undefined : server, `/api/activity?${q}`);
            if (r.status === 403) return { server, denied: true };
            if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { server });
            const d = await r.json();
            const got = (Array.isArray(d.actions) ? d.actions : []).filter(a => a && Number.isSafeInteger(a.id)).map(a => ({ ...a, server, team: identityKey(server, a.team) }));
            return { server, got, check: d.check || null, more: got.length === PAGE };
        }));
        const answered = settled.filter(x => x.status === 'fulfilled' && !x.value.denied).map(x => x.value);
        const deniedAll = settled.length > 0 && settled.every(x => x.status === 'fulfilled' && x.value.denied);
        if (!next) { rows = []; cursors = {}; moreBy = {}; checks = {}; }
        const seen = new Set(rows.map(keyOf));
        for (const a of answered) {
            for (const row of a.got) if (!seen.has(keyOf(row))) { seen.add(keyOf(row)); rows.push(row); }
            moreBy[a.server] = a.more;
            if (a.got.length) cursors[a.server] = Math.min(...rows.filter(r => r.server === a.server).map(r => r.id));
            if (!next) checks[a.server] = a.check;
        }
        rows.sort((x, y) => atOf(y) - atOf(x));
        check = combineChecks(checks);
        more = Object.values(moreBy).some(Boolean);
        const kept = next ? unread.filter(u => !targets.includes(u.id)) : []; // a page of older actions asks only some computers: the others' gaps stay named
        unread = [...kept, ...settled.map((x, i) => x.status === 'rejected' ? { id: targets[i], why: 'could not be read' } : x.value.denied ? { id: targets[i], why: 'refused to give its record: an older Coral may need an update' } : null).filter(Boolean)];
        failed = answered.length === 0 && !deniedAll && settled.some(x => x.status === 'rejected');
        denied = deniedAll;
        loaded = true;
    })().finally(() => { loading = null; onChange(); keepReading(need); });
    return loading;
}

/** Forget what was read from computers (sign-out, a computer removed): nothing is kept past that, and none of it is ever written to storage. */
export function forget() { rows = []; check = null; loaded = false; more = false; failed = false; denied = false; cursors = {}; moreBy = {}; checks = {}; unread = []; }
document.addEventListener('coral:signed-out', forget); // a signed-out page keeps no computer's actions (#15404)

/** Team ids that appear in the record, with the names the page shows them by. */
const shown = () => rows.filter(r => r.action !== 'chat_send'); // 'Sent words to an agent' stays in the record (the server still writes it) but is not a row here (the Operator, 2026-11-15, #18466); the paging still goes by every row read
export const teams = () => [...new Set(shown().map(r => r.team))].sort((a, b) => teamLabel(a).localeCompare(teamLabel(b)));
/** The agents and the goals the record names, for the Filters panel's lists (#14445): the agents by name, the goals by title with No goal last when any row has none. */
export const agents = () => [...new Set(shown().map(AF.agentOf).filter(Boolean))].sort((a, b) => a.localeCompare(b));
export const goals = () => { const all = [...new Set(shown().map(AF.goalOf))]; return [...all.filter(g => g !== AF.NO_GOAL).sort((a, b) => a.localeCompare(b)), ...all.filter(g => g === AF.NO_GOAL)]; };
export const teamOf = r => M(teamLabel(r.team));
export const filtered = f => AF.ordered(shown().filter(r => AF.matches(r, f, teamOf)), f);
/** The rows the Important view keeps when `f` has it on (the same rule `matches` applies, so a count is what the list shows). */
const visible = f => shown().filter(r => AF.passesImportant(r, f));
export const total = f => visible(f).length;
/** How many of the rows read are of a kind (the chips' counts); '' is all of them. */
export const countKind = (k, f) => visible(f).filter(r => AF.inKind(r, k)).length;
/** The counts the Show pills draw, as one string for the toolbar's signature. */
export const countsKey = f => JSON.stringify([total(f), AF.KINDS.map(k => countKind(k, f))]);
/** The Show pills (#16087, #19149): Important leaves out delivery bookkeeping and is on when nothing was chosen before; a kind chip toggles its kind; Everything clears Important and every kind, and the last kind off is Everything again. change(important, kinds) keeps the choice. */
export const showPills = (f, change) => {
    const picked = AF.kindsOf(f.kind), imp = f.important === true;
    return { label: 'Show', panelLabel: 'Show', multi: true, current: [...(imp ? ['important'] : []), ...picked], items: [{ key: 'important', label: 'Important', count: total({ important: true }) }, { key: 'all', label: 'Everything', count: total() }, ...AF.KINDS.map(k => ({ key: k, label: AF.KIND_LABEL[k], count: countKind(k, f) }))], onPick: key => key === 'all' ? change(false, []) : key === 'important' ? change(!imp, picked) : change(imp, AF.kindsOf(picked.includes(key) ? picked.filter(k => k !== key) : [...picked, key])) };
};

/** The page's table spec for the sidebar's group table. `open` has { file(row), goal(row), question(row) }: how a row's item opens (the sidebar knows the routes). */
export function spec(f, open, { grouped = false, byTask = true, tasks, taskSignature = '' } = {}) {
    const list = filtered(f);
    const parts = r => { const p = partsOf(r); return grouped && byTask && r.goal_id && r.task_id ? { ...p, about: '' } : p; };
    const groupFor = grouped ? Threads.activityGroupLookup(list, teamLabel, parts, tasks, byTask) : null;
    const opens = r => (r.item_kind === 'job_run' && !!jobRunParts(r.item_id)) || (r.item_kind === 'file' && /^[a-f0-9]{64}$/i.test(r.version || r.item_id || '')) || (r.item_kind === 'agent' && r.item_id && r.action !== 'agents_record') || (['goal', 'question', 'task', 'message', 'workflow_run'].includes(r.item_kind) && /^\d+$/.test(r.item_id)) || (r.item_kind === 'chat' && !!r.item_id);
    const narrowed = AF.isFiltered(f), onlyNotes = !narrowed && f.important === true && shown().length > 0; // the view is Important (the default, not a filter the person set) and every row read is a delivery note (#19219)
    return { title: 'Activity', noun: ['action', 'actions'], rows: list,
        empty: { line: !loaded || loading ? 'Reading the record…' : failed ? (denied ? 'Only the account this computer is linked to can see the Activity record.' : 'The record could not be read.') : narrowed ? 'No action matches the search and filters.' : onlyNotes ? 'Nothing important yet.' : 'Nothing yet.',
            hint: loaded && !failed && onlyNotes ? 'Delivery notes, like words sent to an agent, are under Everything.' : loaded && !failed && !narrowed ? 'Each time you approve, ask for changes, deny, ignore or answer something in Needs you, a line is added here.' : undefined },
        signature: JSON.stringify([list.map(keyOf), check, loaded, failed, denied, more, missingComputers(), multipleServers(), grouped, grouped ? taskSignature : '']),
        node: () => {
            const wrap = DT.el('div', 'activity-folder');
            const words = checkWords(check);
            if (words) { const n = DT.el('p', `activity-check${check && !check.intact ? ' activity-check-broken' : ''}`, words); n.setAttribute('role', check && !check.intact ? 'alert' : 'status'); wrap.append(n); }
            const openRow = r => { if (!opens(r)) return; if (r.item_kind === 'file' && /^[a-f0-9]{64}$/i.test(r.version || r.item_id || '')) open.file(r); else if (r.item_kind === 'goal') open.goal(r); else if (r.item_kind === 'question' && opens(r)) open.question(r); else if (r.item_kind === 'task' && opens(r)) open.task(r); else if (r.item_kind === 'agent' && opens(r)) open.agent(r); else if (r.item_kind === 'message' && opens(r)) open.message(r); else if (r.item_kind === 'chat' && opens(r)) open.chat(r); else if (r.item_kind === 'workflow_run' && opens(r)) open.workflow(r); else if (r.item_kind === 'job_run' && opens(r)) open.job(r, jobRunParts(r.item_id)); }
            // the row's More menu: what else can be done with this record, from the actions the dialogs already have (#19828). A file's decision: its details and comments, back to review, its link. An answered question: the thread, back to Needs you, its board message, its task.
            const threadFor = async r => { // the question's thread, read on demand for the row's Q&A preview
                const { fetchMessages } = await importOnce('./board_fetch.js'), { threadOf } = await importOnce('./activity_dialog.js'), askId = Number(r.item_id);
                if (!r.team || !askId) return [];
                const all = []; let after = Math.max(0, askId - 1);
                for (let page = 0; page < 5; page++) { const { messages } = await fetchMessages(r.team, 200, { after_id: after }); all.push(...messages); const last = Math.max(after, ...messages.map(m => Number(m.id) || 0)); if (messages.length < 200 || last === after) break; after = last; }
                return threadOf(all, askId).map(m => ({ who: m.subscriber_id === 'dashboard' || /operator/i.test(m.subscriber_id || '') ? 'You' : M(m.subscriber_id || 'An agent'), text: String(m.content || '').replace(/\s+/g, ' ').trim() }));
            };
            const moreFor = r => {
                const items = [], team = r.team ? splitKey(r.team) : null;
                if (r.item_kind === 'file' && ['approve', 'changes', 'deny'].includes(r.action) && /^[a-f0-9]{64}$/i.test(r.version || r.item_id || '')) {
                    const hex = String(r.version || r.item_id).toLowerCase();
                    items.push({ label: 'Comment / details', run: () => open.file(r) });
                    if (!decisionNeedsPerson(team.server)) items.push({ label: 'Reopen for review', run: async () => { try { const { sendForReview } = await importOnce('./artifact_send_review.js'); await sendForReview(team.name, hex); showToast('The file is back in Needs you, waiting for a decision.'); } catch (e) { showToast(e.message || 'Could not send the file for review.', true); } } });
                    items.push({ label: 'Copy link', run: async () => { if (await copyText(`coral://artifacts/${hex}`)) showToast('Link copied.'); else showToast('Could not copy the link.', true); } });
                } else if (r.item_kind === 'question' && (r.action === 'answer' || r.action === 'dismiss') && /^\d+$/.test(r.item_id)) {
                    items.push({ label: 'Reply in thread', run: () => open.question(r) });
                    if (!decisionNeedsPerson(team.server)) items.push({ label: 'Reopen question', run: async () => { try { const { reopenAsk } = await importOnce('./ask_ignore.js'); await reopenAsk({ server: team.server, board: team.name, id: Number(r.item_id) }, { unanswer: true }); showToast('The question is back in Needs you, unanswered.'); } catch (e) { showToast(e.message || 'Could not reopen the question.', true); } } });
                    if (open.board) items.push({ label: 'Open on Board', run: () => open.board(r) });
                    if (open.taskOf && r.task_id) items.push({ label: 'Open task', run: () => open.taskOf(r) });
                }
                else if (r.item_kind === 'goal' && r.action === 'goal_close' && /^\d+$/.test(r.item_id) && team && !decisionNeedsPerson(team.server)) {
                    items.push({ label: 'Reopen goal', run: async () => { try { const { reopenGoal } = await importOnce('./goal_write.js'), id = Number(r.item_id), res = await reopenGoal(r.team, id); if (!res.ok) throw new Error(`HTTP ${res.status}`); showToast(`Goal #${id} reopened. The team read it on the board.`); } catch (e) { showToast(`Not reopened: ${e && e.message || 'try again'}`, true); } } });
                }
                return items;
            };
            const openPrimary = r => (r.item_kind === 'file' && open.viewer && ['approve', 'changes', 'deny'].includes(r.action)) ? open.viewer(r) : openRow(r); // "Open file" opens the file; the row's title opens its decision
            const teamWords = r => multipleServers() ? `${teamOf(r)} \u00b7 ${serverLabel(r.server || LOCAL_SERVER)}` : teamOf(r); // with several computers read, the computer is named beside the team (#15730)
            const ordered = grouped ? Threads.arrangeActivityRows(list) : list;
            wrap.append(Ledger.ledger(ordered, { label: `Activity, ${list.length}`, parts, opens, openRow, openPrimary, moreFor, threadFor, thumbUrl: (path, r) => serverUrl(path, r.server || LOCAL_SERVER), openLabel: r => M(itemWords(r)), teamWords, fromWords: r => AF.agentOf(r) ? `from ${M(AF.agentOf(r))}` : '', doneFrom: fromCell, keyOf }, { groupFor }));
            const gaps = missingWords(missingComputers());
            if (gaps) { const n = DT.el('p', 'activity-check', gaps); n.setAttribute('role', 'status'); wrap.prepend(n); }
            if (more) { const b = DT.el('button', 'btn btn-small activity-more', 'Show older actions'); b.type = 'button'; b.addEventListener('click', () => refresh(null, { next: true })); wrap.append(b); }
            return wrap;
        } };
}
