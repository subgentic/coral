import { multipleServers, serverColumns, serverMatches, syncServerField } from './inbox_servers.js';
import { keepMenuOnScreen } from './menu_fit.js';
import { needsYou, askedRow } from './asked_before_restart.js';
import { unrecordedItem, recordAllAgents } from './waiting.js';
import { welcomeRows, runWelcome, dismissWelcome, hideAllWelcome } from './welcome_items.js';
import { loadPendingSkills, skillRows, skillLine, skillName, skillCount, openSkill } from './needs_skills.js';
import { doneGoals, nextQuietEnd, quietEndsAt, hideGoalDone, setGoalDoneCount, isGoalDoneRead, markGoalDoneRead, markGoalDoneUnread, SETTING as GOAL_DONE_SETTING } from './goal_done.js';
/* The dashboard's own Inbox on the shared sidebar (#7472), loaded the first time the Inbox tab is shown (inbox_tab.js keeps the badge and the counts, which are always there).
 *
 * Three groups, the hub's /inbox order: Needs you (the agents waiting for input, from the live list the dashboard already holds), Tasks (the open tasks assigned to the Operator) and Saved (the
 * messages saved for later). A group's name opens it as a table in the centre (sidebar_groups.js): Needs you is Item, Team, When; Tasks is Task, Priority, State, Team; Saved is Message, Saved, State and
 * one quiet Done or Reopen button per row, with Open and Done as two chips with counts above it. Each row opens its item: an agent (the Agents tab), a task (a page here, which mounts the shared Inbox
 * component, inbox_panel.js, for that one task: its full text and its reply box are the component's own) or a saved message (a page here with Open, Read the whole message and, behind More, Remove).
 * The one search box searches the group on screen: it narrows the rows of Needs you and Tasks, and is the Saved search (the server matches, so it covers every saved message). Saved's Filters and Sort
 * are in Display options. The hub's own framed /inbox is not this: it keeps the frame, full width (inbox_tab.js). */
import { state } from './state.js';

import { mutedReviewItems, mutedWords, reviewItems, unreadReviewItems, reviewErrors, refreshReviews, reviewGroups, setReviewRead, markOpenedReadVisibly, isRead, savedFiles } from './inbox_reviews.js';
import { failedUnread, finishedUnread, refreshRuns, markSeen, runRoute, failureWords } from './automation_runs.js';
import { operatorAsks, refreshOperatorAsks, askLine, askPlain, askKey, openAskDialog, askSubjects, askSubjectWords } from './operator_asks.js';
import { go, note, backIs, currentRoute } from './nav.js';

import { build, keyRoute, parse as parseRoute, inboxFolderPath, BOARDS_FOLDER, BOARDS_SUB } from './routes.js';
import { sessionServer, normServer, keyLabel, identityKey, splitKey, goalTeamKey, nativeInbox, decisionNeedsPerson, LOCAL_SERVER, boardFetch } from './server_base.js';
import { teamLabel } from './server_status.js';
import { showView, showToast, OPERATOR_ID } from './utils.js';
import { registerActions, textOf } from './actions.js';
import { tableMarkup, registerGroupSource, refreshGroupTable, openGroupTable, foldWayBack } from './sidebar_groups.js';
import { isPhoneLayout } from './phone_layout.js';
import { showConfirmModal } from './confirm_dialog.js';
import { markReady } from './ready.js';
import { browserLocal } from './safe_storage.js';
import { resolveSessionIdentity, sessionStateInfo } from './session_state.js';
import { pollEvery } from './overload.js';
import { setHidden } from './dom_write.js';
import { loadStyles } from './lazy_styles.js';
import { syncDisplayPanels } from './display_panel.js';
import { onViewShown } from './view_switch.js';
import { importOnce } from './import_once.js';
import { markHidden } from './visible_marks.js';
import { onInboxHooks, setInboxCount, askOf, updateInboxTab } from './inbox_tab.js';
const { coralInboxAdapter, savedExpandFor, listInboxGoals } = await importOnce('./inbox_coral.js');
const { agentLink } = await importOnce('./agent_link.js'); // an agent's name is one shared helper everywhere (#12168)
const { openedFrom, backLabelFor } = await importOnce('./inbox_back_label.js'); // the Back words of the Inbox's task and goal screens (#8861)
const saved = await importOnce('./saved.js');
const DT = await importOnce('./data_table.js'); // the one table (#7743): the Tasks group's page is its Tasks columns
await loadStyles('needs_actions.css'); // the actions cell's fixed slots (moved out of the start CSS, #12231)
await loadStyles('needs_phone.css'); // a phone's Needs you rows: not in the start's stylesheet (page_weight), loaded with the Inbox before a row is drawn
const { el } = DT;
const TF = await importOnce('./task_filters.js');
const TV = await importOnce('./tasks_view.js'); // the one Tasks view
const VL = await importOnce('./view_list.js'); // the mailbox's view list (#7785)
const TB = await importOnce('./task_bulk.js'); // what the selection bar does to the selected tasks
const Toolbar = await importOnce('./team_toolbar.js'); // the selection bar takes the page's toolbar line (mountSelection)
const GC = await importOnce('./goal_columns.js');
const GW = await importOnce('./goal_words.js'); // a goal's state word, said in a phone row's button name (#9747)
const { mountGoal } = await importOnce('./goal_view.js');
const { mountInboxItem } = await importOnce('./inbox_item_page.js');
const { quietFocus } = await importOnce('./quiet_focus.js');
const GF = await importOnce('./goal_filters.js'); // the Goals folder's search, pills and Filters (#8596)
const IT = await importOnce('./inbox_toolbar.js'); // the folders' toolbar on the shared list bar
const NF = await importOnce('./needs_filters.js'); // the Needs you folder's search, pills and Filters (#8604)
const CF = await importOnce('./chat_filters.js'); // the chat folders' Filters (#8603)
const AC = await importOnce('./inbox_activity.js'); // the Activity folder (#12070): what the Operator did in Needs you, from the server's record (this computer only)
const AF = await importOnce('./operator_activity_filters.js'); // its search and Filters
const IA = await importOnce('./inbox_artifacts.js'); // the Artifacts folder (Goal #62): every team's files in one list
const { answerCell, rowActions } = await importOnce('./inbox_answer.js'); // the choices of a question or a permission, answered from the row (#10400)

/** The agent's own chat card, on the Agents tab (a row that needs an answer shows the chat card, not the terminal saved last, #10141). */
const openInAgents = s => { window.switchNavTab?.('agents'); Promise.resolve(window.selectLiveSession?.(s.name, s.agent_type, s.session_id, sessionServer(s))).then(() => window.showChatView?.()); };
const DN = await importOnce('./desktop_notify.js'); // lazy: its failure is retried
/** A quiet line under Needs you for as long as alerts are off and could be turned on (#11837: the one-time banner was dismissed and two questions waited 14 and 29 minutes): the same call as the banner's button and Settings > Notifications. */
const alertsOffered = () => DN.desktopNotifySupported() && !DN.desktopNotifyEnabled() && !DN.desktopNotifyBlocked();
/** The one quiet line under Needs you when the Operator's own switches keep files out of it (#12144): what and how many, and the way to them (their folder, Artifacts). Never counted, never pushed: a line, not an item. */
// A muted file that is more than a day old and still unread surfaces ONCE, in this quiet line only (never in the badge or a push): the ones already shown in an earlier visit are remembered in this browser, the ones shown
// in this page session stay while it lasts. A muted finished request, release summary or decision is not shown again after that.
const OLD_SEEN_KEY = 'coral-muted-old-seen';
const oldSeen = (() => { try { const v = JSON.parse(browserLocal.get(OLD_SEEN_KEY) || '[]'); return new Set(Array.isArray(v) ? v.map(String) : []); } catch { return new Set(); } })();
const oldShownNow = new Set();
const dayOldMutedFiles = () => mutedReviewItems().filter(a => (a.kind || 'file') === 'file' && !isRead(a) && Date.parse(a.created_at) < Date.now() - 24 * 3600 * 1000 && (oldShownNow.has(a.hex) || !oldSeen.has(a.hex)));
function dayOldWords(rows) {
    if (!rows.length) return '';
    const names = rows.slice(0, 2).map(a => String(a.name || 'a file').slice(0, 60)).join(', ') + (rows.length > 2 ? ` and ${rows.length - 2} more` : '');
    return rows.length === 1 ? `1 muted file is more than a day old: ${names}. ` : `${rows.length} muted files are more than a day old: ${names}. `;
}
function mutedLine() {
    const words = mutedWords(mutedReviewItems());
    if (!words) return null;
    const old = dayOldMutedFiles();
    for (const a of old) { oldShownNow.add(a.hex); oldSeen.add(a.hex); }
    if (old.length) browserLocal.set(OLD_SEEN_KEY, JSON.stringify([...oldSeen].slice(-200)));
    const p = DT.el('p', 'goals-note inbox-muted-line', `Muted by your settings: ${words}. ${dayOldWords(old)}`);
    const b = DT.el('button', 'btn btn-quiet btn-small', 'Show them'); b.type = 'button';
    b.addEventListener('click', () => openInboxGroup('artifacts'));
    p.append(b);
    return p;
}
const needsFoot = () => { const parts = [mutedLine(), alertsLine()].filter(Boolean); if (!parts.length) return null; const wrap = DT.el('div', 'inbox-needs-foot'); wrap.append(...parts); return wrap; };
function alertsLine() {
    if (!alertsOffered()) return null;
    const p = DT.el('p', 'goals-note inbox-alerts-link', 'Get an alert when an agent waits for you while you are in another tab. ');
    const b = DT.el('button', 'btn btn-quiet btn-small', 'Turn on alerts'); b.type = 'button';
    b.addEventListener('click', async () => {
        const granted = await DN.enableDesktopNotify();
        const { showToast } = await importOnce('./notifications.js');
        showToast(granted ? 'Alerts are on. Change them in Settings > Notifications.' : 'Alerts stay off: your browser did not allow them. You can try again in Settings > Notifications.');
        if (granted) p.remove();
    });
    p.append(document.createElement('br'), b); // the button on its own line: beside the words it made a 44 px line box between them
    return p;
}
const CH = await importOnce('./mailbox_chats.js'); // the chat folders (#7776): All chats, Board history, By CLI, Tags
const IR = await importOnce('./inbox_read.js'); // which chats, boards and tasks the person has opened since they changed (#9687)
const { providerName } = await importOnce('./model_labels.js'); // a CLI by its name (Claude, Codex, Antigravity), as the Chats list says it
const { proposalItems, pendingProposals, refreshProposals, onProposalsChanged, proposalActions, openProposalDialog, proposalSummary, proposalSnippet, markedText, carriesInstructions } = await importOnce('./inbox_proposals.js'); // what agents asked to add, waiting for the Operator (#11389)
const { waitingText } = await importOnce('./waiting_text.js'); // a lazy module imports only what loads at startup (import_hygiene): this one loads with it

const $ = id => document.getElementById(id);
/** The Hub-served dashboard's own Inbox (Goal #100, nativeInbox()): Needs you, Tasks and Saved are the Hub's own pages, drawn in the centre in a frame at the constant addresses below (the addresses coral-hub gave on the board, Oct 27);
 *  the chat folders are native, and so are Goals (GET /api/goals, a View route of every online computer) and Artifacts (GET /api/team-artifacts: a View route the Hub answers owner_only for a grantee, who then has no Artifacts folder, #11071). */
const HUB_FRAMES = { needs: '/inbox/hub/needs', tasks: '/inbox/hub/tasks', saved: '/inbox/hub/saved' };
const GROUPS = nativeInbox() ? [{ key: 'needs', label: 'Needs you', frame: HUB_FRAMES.needs }, { key: 'tasks', label: 'Tasks', frame: HUB_FRAMES.tasks }, { key: 'goals', label: 'Goals' }, { key: 'artifacts', label: 'Artifacts' }, { key: 'saved', label: 'Saved for later', frame: HUB_FRAMES.saved }].map(g => ({ ...g, search: g.frame ? 'Search the Inbox' : g.key === 'goals' ? 'Search goals' : 'Search artifacts', short: 'Search' })) : [
    { key: 'needs', label: 'Needs you', search: 'Search needs you', short: 'Search' },
    { key: 'tasks', label: 'Tasks', search: 'Search tasks', short: 'Search' },
    { key: 'goals', label: 'Goals', search: 'Search goals', short: 'Search' }, // the open goals of every team the person runs (GET /api/goals): the team page's goal row plus a Team column (#7776)
    { key: 'artifacts', label: 'Artifacts', search: 'Search artifacts', short: 'Search' }, // every team's artifacts (GET /api/team-artifacts): the team page's list plus a Team filter (Goal #62)
    { key: 'saved', label: 'Saved', search: 'Search saved messages', short: 'Search' }, // the box beside Display options and Expand is narrow: its placeholder is the short words, its name the whole ones
    { key: 'activity', label: 'Activity', search: 'Search activity', short: 'Search' }, // what you did in Needs you (GET /api/activity, the owner's alone, read only; #12070)
];
const GROUP_KEY = 'coral.inbox.tab'; // the group last on screen, kept in this browser
let tasks = [];
/** A folder's name and its search words: the groups above, or a chat folder (its title comes from the chat folders' own list). */
const groupMeta = key => GROUPS.find(g => g.key === key) || (CH.CHAT_KEY.test(key) && CH.chatFolder(key) ? { key, label: CH.chatFolder(key).title, search: CH.searchWords(key), short: 'Search' } : null);
const DEFAULT_GROUP = nativeInbox() ? 'chats' : 'needs';
let group = (() => { const v = browserLocal.get(GROUP_KEY); return groupMeta(v) ? v : DEFAULT_GROUP; })();
const queries = { needs: '', tasks: '', goals: '', artifacts: '', saved: '', activity: '' }; // a chat folder keeps its search as typed under its own key // each group's own search text (lower case; Saved's goes to the server as typed)
let goalMount = null, goalOpener = null, goalScroll = 0, itemMount = null;
const itemOpeners = new Map();
const folderRoute = { view: 'inbox-goals', sub: 'goals' };
const routeForFolder = key => key === 'goals' ? folderRoute : key === 'tasks' ? { view: 'inbox-tasks', sub: 'tasks' } : key === BOARDS_FOLDER ? { view: 'inbox-' + BOARDS_SUB, sub: BOARDS_SUB } : null;
const pageGroup = () => page?.kind === 'goal' ? 'goals' : page?.kind === 'tasks' ? 'tasks' : page?.kind === BOARDS_SUB ? BOARDS_FOLDER : page ? 'saved' : group;
function openItemRoute(kind, team, id, rowKey) {
    const key = kind === 'tasks' ? 'tasks' : BOARDS_FOLDER, route = routeForFolder(key);
    quietFocus($('inbox-view'));
    itemOpeners.set(key, { key: rowKey, scroll: $('group-table-view')?.scrollTop || 0 });
    note(route);
    go({ ...route, id: team, ...(kind === 'tasks' ? { item: id } : {}) });
}
let page = null; // { kind: 'task', project, id } | { kind: 'saved', id }: the item on screen, or null

// ── Needs you ────────────────────────────────────────────────────────────
const waitingSessions = () => (state.liveSessions || []).filter(needsYou).map(askedRow); // an agent that asked something before Coral restarted is listed with its words (#10368)
const teamOf = s => s.board_project ? teamLabel(identityKey(sessionServer(s), s.board_project), s.board_label || '') : ''; // with its computer when a hub has more than one (#8774)
const fromOf = (s, withTeam) => { if (s.operatorAsk) return [`from ${markHidden(s.operatorAsk.asker, { strict: true }).trim() || 'an agent'}`, teamOf(s)].filter(Boolean).join(' \u00b7 '); if (!s.review) return ''; const who = markHidden(s.review.produced_by, { strict: true }).trim(), team = withTeam ? teamOf(s) : ''; const n = (s.review.earlier || []).length; return [who ? `from ${who}` : 'sender unknown', team, n ? `${n} earlier version${n === 1 ? '' : 's'}` : ''].filter(Boolean).join(' \u00b7 '); }; // who uploaded a file for review, from the upload's record, what hides or reorders the name written out (markHidden strict), and its team (#11456)
/** The line under a review row that says who sent it: "from <agent> · <earlier versions>", the agent's name the shared link (#12168). */
const fromNode = s => {
    const p = DT.el('span', 'inbox-review-from'), who = String(s.review.produced_by || '').trim(), n = (s.review.earlier || []).length, rest = n ? `${n} earlier version${n === 1 ? '' : 's'}` : '';
    if (!who) { p.textContent = fromOf(s, false); return p; }
    p.append('from ', agentLink(who, { board: s.review.team }), rest ? ' \u00b7 ' + rest : '');
    return p;
};
/** The question the uploader put on a file for review (#11555): one line, an agent's text, so hidden characters are written out and it is drawn as text only. */
const questionOf = s => (s.review && s.review.review_question ? markHidden(s.review.review_question, { strict: true }).replace(/\s+/g, ' ').trim() : '');
/** What a review row says under its name: the question first (what the person is to decide), then who uploaded it and their team (the name stays beside it, Security's condition on #11555). */
const subOf = (s, withTeam) => [s.review ? questionOf(s) : '', fromOf(s, withTeam)].filter(Boolean).join(' \u00b7 ');
/** Whether a Needs you row is unread (#11668): everything that counts in the badge is; a read review and the welcome items (listed, not alarms) are not. */
/** The marker a file's row carries while agents have replied in the Operator's comment thread and they have not opened it (#12026). */
const newCommentsTag = () => { const t = DT.tag('New comments'); t.classList.add('inbox-new-comments'); return t; };
const needsUnread = s => !(s.welcome || (s.review && isRead(s.review)) || (s.goalDone && isGoalDoneRead(goalTeamHere(s.goalDone), s.goalDone) && !(s.goalDone.new_comments > 0))); // a read file and an opened goal item are listed, not counted (#11983); either is counted again while agents have replied in the Operator's thread on it (#12026, #12073)
/** A wide screen with a real pointer shows a row's actions on its hover or focus, and the waiting time where they are the rest of the time (#11669, the operator's Gmail shot); a touch screen and a phone keep the buttons drawn. */
const hoverRows = () => !isPhoneLayout() && matchMedia('(hover: hover) and (pointer: fine) and (min-width: 768px)').matches;
const hoverWrap = (s, box) => { if (!box || !hoverRows()) return box; const wrap = DT.el('div', 'inbox-actions-hover'), when = waitingText(s.waiting_since); wrap.append(box); if (when) wrap.append(DT.el('span', 'inbox-row-when', when)); return wrap; };
/** What goes under a question to the Operator: the whole question when the name above is only its first words, and "Needs your answer" when the name already says all of it (a short question was on the row twice, #11776). */
const askUnder = a => { // the line under a question's title: the rest of its words. A title that is the start of the text is not said twice (#12649: the row said "Sorry, the test question..." and again, under it, "Sorry, the test question...")
    const whole = askPlain(a), one = whole.replace(/\s+/g, ' ').trim(), line = askLine(a), head = line.endsWith('\u2026') ? line.slice(0, -1).trimEnd() : line;
    if (one === line) return 'Needs your answer';
    if (head && one.startsWith(head)) { const rest = one.slice(head.length).replace(/^[\s.,;:\u2026-]+/, ''); return rest || 'Needs your answer'; }
    return whole;
};
/** "3 earlier versions": the older uploads of one artifact that this row stands for (#11533), muted after the file's name on the top line and in the spoken name (#11719). */
/** The number the row's "version N" says: the server's, when the artifact is in a series it recorded, else the older versions of the same file and uploader that this row stands for, and itself (#12081: a second upload by name, with no series, said only "1 earlier version"). */
const versionOf = r => Number(r.version) > 1 ? Number(r.version) : (r.earlier || []).length ? r.earlier.length + 1 : 0;
const earlierWords = r => { const n = Math.max((r.earlier || []).length, (r.version || 1) - 1); return n ? `${n} earlier version${n === 1 ? '' : 's'}` : ''; };
const needsName = s => s.skillReview ? skillName(s.skillReview) : s.goalDone ? `Goal #${s.goalDone.id}` : s.proposal ? markedText(s.proposal.proposer) : s.review ? s.review.produced_by || 'Unknown agent' : s.autorun ? s.autorun.name : s.operatorAsk ? s.operatorAsk.asker : s.welcome ? s.welcome.title : s.unrecorded ? s.display_name : resolveSessionIdentity(s);
const reviewRows = () => reviewItems().map(a => ({ review: a, goal: a.goal_id && a.goal_title ? { id: a.goal_id, title: String(a.goal_title), board: a.team } : null, task: a.task_id ? { id: a.task_id, title: String(a.task_title || '') } : null, session_id: a.reviewKey, display_name: a.name, board_project: splitKey(a.team).name, server: splitKey(a.team).server, waiting_kind: 'review', waiting_summary: 'For review', waiting_since: a.created_at }));
/** A failed run of a job or workflow that nobody has opened (#9296): a row of Needs you like a review, opened on its job's or workflow's page, dismissed (marked opened) without opening it. */
const runRows = () => failedUnread().map(r => ({ autorun: r, session_id: `automation-run:${r.key}`, display_name: r.name, board_project: '', server: '', waiting_kind: 'run', waiting_summary: failureWords(r) ? `Run failed: ${failureWords(r)}` : 'Run failed', waiting_since: r.finishedAt || r.at }));
/** What agents asked to add to a team, waiting for the Operator (#11389): a row of Needs you like a review, opened in its dialog. */
const proposalRows = () => proposalItems().map(p => ({ proposal: p, session_id: p.rowKey, display_name: markedText(p.proposer), board_project: splitKey(p.board_id).name, board_label: markedText(p.board_label || ''), server: LOCAL_SERVER, waiting_kind: 'proposal', waiting_summary: proposalSummary(p), waiting_since: p.created_at }));
/** An active goal whose tasks are all done (#11825): ONE row of Needs you, "Goal #N looks done: <title>" with its Done-when line; Close goal, Not yet and Dismiss. This computer's goals only. */
const goalTeamHere = g => { const k = splitKey(g.board_id); return k.server === LOCAL_SERVER ? k.name : ''; };
const goalDoneRows = () => doneGoals(goals, goalTeamHere).map(g => ({ goalDone: g, session_id: `goal_done:${goalTeamHere(g)}:${g.id}`, display_name: `Goal #${g.id}`, board_project: goalTeamHere(g), server: LOCAL_SERVER, waiting_kind: 'goal_done', waiting_summary: (g.done_when || g.doneWhen) ? `Done when: ${markedText(g.done_when || g.doneWhen)}` : 'Every task is done.', waiting_since: quietEndsAt(g) ? new Date(quietEndsAt(g)).toISOString() : (g.looks_done_at || g.updated_at) })); // since the row appeared: its last task's completion (#12081) plus the quiet period (#12161), not since the goal was made or edited
const goalDoneLine = g => `Goal #${g.id} looks done: ${markedText(g.title)}`;
/** A question an agent asked the Operator (post --ask, wait --operator, #11417): a row of Needs you, opened whole in a dialog with a Reply box. */
const askRows = () => operatorAsks().map(a => ({ operatorAsk: a, session_id: askKey(a), display_name: a.asker, board_project: a.board, board_label: a.board_label || '', server: a.server || '', waiting_kind: 'ask', waiting_summary: askLine(a), waiting_since: a.at }));
/** After an update, agents whose notices are held until they are recorded: ONE item that opens the Record for all agents confirm (#11415). */
const recordRows = () => { const it = unrecordedItem(state.liveSessions); return it ? [it] : []; };
const isItem = s => !!(s.review || s.autorun || s.proposal || s.goalDone || s.skillReview || s.operatorAsk || s.unrecorded || s.welcome); // a row that is not an agent: a review or a run, shown as an item
const needsDetails = s => !isItem(s) && !!s.agent_type && !askOf(s); // #12740: a missing agent question gets a placeholder in any table
// What waits on each row (#11442, #11455): the server's waits_on_this on an agent row and on a review row, said by inbox_blockers.js (lazy); until it has loaded, or on a row without the field, the row says nothing and looks as it did.
let BL = null;
const markTitle = t => markHidden(t, { strict: true }); // a task's or a goal's title is an agent's text: what hides or reorders it is written out (#11442, #11399)
const waitsOf = s => (BL ? BL.infoOf(s.review ? s.review.waits_on_this : s.waits_on_this) : null);
const blocksOf = s => (BL ? BL.phraseOf(waitsOf(s), markTitle) : '');
const blocksShortOf = s => (BL ? BL.shortPhraseOf(waitsOf(s), markTitle) : ''); // a phone's one-line row
function askBlockers() { // loaded once, when a row carries the field; the table is drawn again with the phrases
    if (BL || !allNeeds().some(s => (s.review || s).waits_on_this)) return;
    importOnce('./inbox_blockers.js').then(m => { BL = m; refreshGroupTable('hub-inbox'); }).catch(() => {});
}
let answered = ''; // what an answer given here went through as, for five minutes: the row is gone and the list says so (#10720)
document.addEventListener('coral:inbox-answered', e => { answered = e.detail.said; setTimeout(() => { answered = ''; }, 3e5); });
const allNeeds = () => [...waitingSessions(), ...reviewRows(), ...runRows(), ...proposalRows(), ...goalDoneRows(), ...skillRows(), ...askRows(), ...recordRows(), ...welcomeRows()]; // the welcome items of a new install come last: real work first (#11443)
const needsText = s => [s.operatorAsk ? `${s.operatorAsk.asker} ${askLine(s.operatorAsk)}` : '', s.proposal ? `${s.proposal.title} ${s.proposal.proposer}` : '', s.goalDone ? `${s.goalDone.title} ${s.waiting_summary}` : '', s.skillReview ? `${skillName(s.skillReview)} ${s.waiting_summary}` : '', s.review?.name || '', s.autorun ? `${s.autorun.name} ${s.waiting_summary}` : '', needsName(s),resolveSessionIdentity(s), sessionStateInfo(s).label, askOf(s), teamOf(s), s.goal?.title || '', s.task?.title || ''].join(' ').toLowerCase();
let needsFilters = NF.loadFilters(), needsBar = null;
const NO_GOAL = 'No goal';
const goalLabel = s => (s.goal && s.goal.id && s.goal.title ? String(s.goal.title) : NO_GOAL); // the goal a row's task serves (a review's artifact roll-up, #8579; an agent's task, #7302), or the words for none
const needsCtx = { text: needsText, teamOf, nameOf: needsName, goalOf: goalLabel };
const orderedNeeds = () => NF.ordered(allNeeds().filter(s => NF.matches(s, needsFilters, needsCtx) && serverMatches(s, needsFilters)), needsFilters, s => (BL ? BL.weightOf(waitsOf(s)) : 0));
let needsOrder = null; // what the person has seen, in its order (#12636): a computer that answers late adds its rows at the end, it never moves the ones under the finger
const needsKey = s => `${sessionServer(s)}:${s.session_id}`;
const filteredNeeds = () => { const kept = NF.keepOrder(orderedNeeds(), needsKey, needsOrder, JSON.stringify([needsFilters, queries.needs])); needsOrder = kept.memory; return kept.rows; };
const needsOverflow = () => reviewGroups(filteredNeeds().filter(s => s.review).map(s => s.review)).filter(g => g.more.length);
const needsRows = () => {
    const all = filteredNeeds(), visible = new Set(reviewGroups(all.filter(s => s.review).map(s => s.review)).flatMap(g => g.rows.map(a => a.reviewKey)));
    return all.filter(s => !s.review || visible.has(s.review.reviewKey));
};
const kindShown = k => (k !== 'review' || reviewItems().length || needsFilters.kind === 'review') && (k !== 'run' || failedUnread().length || needsFilters.kind === 'run') && (k !== 'proposal' || proposalItems().length || needsFilters.kind === 'proposal') && (k !== 'goal_done' || goalDoneRows().length || needsFilters.kind === 'goal_done') && (k !== 'skill_review' || skillRows().length || needsFilters.kind === 'skill_review') && (k !== 'welcome' || welcomeRows().length || needsFilters.kind === 'welcome'); // a pill for what is not there is not drawn, unless it is the one on
/** The Needs you folder's toolbar (#8604): the search, the kind pills (All, Permission, Question, Needs input), the Filters icon (Team, Agent, Waiting longer than, Sort), the chips of what is on. */
function inboxNeedsToolbar() {
    if (!needsBar) {
        needsBar = IT.folderToolbar({
            idp: 'inbox-needs', noun: 'agent', searchLabel: 'Search needs you',
            sorts: { values: NF.SORTS, labels: NF.SORT_LABEL, aria: 'Sort by how long they have waited' },
            fields: [
                { type: 'select', key: 'team', id: 'inbox-needs-team', label: 'Team', values: [], labels: {}, any: 'Any team' },
                { type: 'select', key: 'agent', id: 'inbox-needs-agent', label: 'Agent', values: [], labels: {}, any: 'Any agent' },
                { type: 'select', key: 'goal', id: 'inbox-needs-goal', label: 'Goal', values: [], labels: {}, any: 'Any goal' },
                { type: 'select', key: 'longer', id: 'inbox-needs-longer', label: 'Waiting longer than', values: NF.LONGER, labels: NF.LONGER_LABEL, any: 'Any time' },
            ],
            model: { EMPTY: NF.EMPTY, clean: NF.clean, chips: NF.chips, isFiltered: NF.isFiltered, without: NF.without },
        }, next => {
            needsFilters = next; NF.saveFilters(next); queries.needs = next.q.toLowerCase();
            const input = $('inbox-search'); if (input && group === 'needs') input.value = next.q; // the sidebar's box shows the same words
            renderInboxNav(true);
        });
    }
    const all = allNeeds();
    const teams = [...new Set(all.map(teamOf).filter(Boolean))].sort(), names = [...new Set(all.map(needsName))].sort();
    const goalNames = [...new Set(all.filter(s => s.review || s.goal).map(goalLabel))].sort((a, b) => (a === NO_GOAL) - (b === NO_GOAL) || a.localeCompare(b)); // review rows and rows with a goal: "No goal" last
    const rows = all.filter(s => NF.matches(s, { ...needsFilters, kind: '' }, needsCtx));
    const counts = NF.KINDS.filter(kindShown).map(k => rows.filter(s => NF.kindOf(s) === k && (k === 'welcome' || needsUnread(s))).length); // a pill counts what the badge counts (the Welcome pill its own items)
    const listed = NF.KINDS.filter(kindShown).map(k => rows.filter(s => NF.kindOf(s) === k).length), said = (n, m) => (n === m ? n : `${n} of ${m}`); // the rows read ones are listed too: 'For review 0 of 4', one number (the unread) and the list's size when they differ (#11886)
    const node = needsBar.draw({
        filters: needsFilters,
        options: { team: { values: teams, labels: {} }, agent: { values: names, labels: {} }, goal: { values: goalNames, labels: {} } },
        pills: { label: 'Show agents waiting on', current: needsFilters.kind || 'all',
            items: [{ key: 'all', label: 'All', count: said(rows.filter(needsUnread).length, rows.length) }, ...NF.KINDS.filter(kindShown).map((k, i) => ({ key: k, label: NF.KIND_LABEL[k], count: said(counts[i], listed[i]) }))],
            onPick: key => { needsFilters = { ...needsFilters, kind: key === 'all' ? '' : key }; NF.saveFilters(needsFilters); renderInboxNav(true); } },
    });
    return { node, signature: JSON.stringify([needsFilters, teams, names, goalNames, counts, rows.length, rows.filter(needsUnread).length]) };
}

// ── Tasks ────────────────────────────────────────────────────────────────
const RANK = { high: 0, medium: 1, low: 2 };
const TASK_GLYPH = { Waiting: 'schedule', Queued: 'schedule', 'In progress': 'hourglass_top', Blocked: 'block', 'In review': 'rate_review', Done: 'check_circle' }; // a phone row's leading glyph: the task's state
const stateOf = t => TV.taskWord(t);
const inboxTasksState = DT.tableState();
const needsState = DT.tableState();

export async function openReview(row, extra = {}) {
    const { openArtifactViewer } = await importOnce('./artifact_viewer.js', 'the file viewer').catch(() => ({})); // a failed load is said (importOnce's toast) and the next click tries again: a page left open across an update must not have rows that do nothing (#11963)
    if (!openArtifactViewer) return;
    openArtifactViewer(row.hex, { server: splitKey(row.team).server, filename: row.name, mediaType: row.media_type, board: splitKey(row.team).name, goal: row.goal_id && row.goal_title ? String(row.goal_title) : '', goalId: row.goal_id ? String(row.goal_id) : '', goalTeam: row.team || '', task: row.task_id ? String(row.task_title || `Task #${row.task_id}`) : '', from: subOf({ review: row, board_project: splitKey(row.team).name, server: splitKey(row.team).server }, true), ...extra }); // the newest version itself: a diff only when Compare is pressed (#11628)
    markOpenedReadVisibly(row.hex, sayLive); // opening is reading it: the 'read' tag, so it stops counting everywhere (#9277); the viewer does the same for any for-review artifact, once; a failed save is said, and the item keeps counting
}
/** A row's action clears it from the list: the list is drawn again, and the person keeps their place (#11558). Called before the write, it notes where the page and the list are scrolled and the row beside this one (the next, or the
 * previous at the end); the function it returns, called after the write, waits for the redraw (the frame the row is gone, before it is painted), puts the scroll back and puts the focus on that neighbour's first button. */
function keepPlace(button) {
    const tr = button.closest('tr'), near = tr && (tr.nextElementSibling || tr.previousElementSibling), key = near && near.dataset.key, spots = [document.scrollingElement];
    for (let e = tr; e; e = e.parentElement) if (e.scrollTop > 0) spots.push(e);
    const tops = spots.map(e => e.scrollTop);
    return async () => {
        for (let i = 0; i < 90 && tr && tr.isConnected; i++) await new Promise(r => requestAnimationFrame(r));
        spots.forEach((e, i) => { e.scrollTop = tops[i]; });
        const next = key && $('group-table-view')?.querySelector(`tr[data-key="${CSS.escape(key)}"]`), to = next ? [...next.querySelectorAll('button, .dt-primary')].find(b => b.getBoundingClientRect().width && !b.classList.contains('dt-star') && !(isPhoneLayout() && b.closest('.inbox-review-actions'))) : $('group-table-view')?.querySelector('input[type=search]'); // the first control that is drawn (a phone row's star is not)
        to?.focus({ preventScroll: true });
    };
}
/** Four words, the item's name, the task link and the goal need about 1360 px of window (the sidebar takes 320 of it): narrower, and on a phone, the other rows' second action is in the row's menu. */
const compactActions = () => isPhoneLayout() || !matchMedia('(min-width: 1360px)').matches;
let moreMenus = 0;
/** The bookmark of Save for later, drawn like the Saved folder's (the icon font has no glyph for it). */
/** Request changes, drawn as a speech bubble (the icon font has no glyph for it either). */
function changesIcon() { const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'), path = document.createElementNS(NS, 'path'); for (const [k, v] of Object.entries({ viewBox: '0 0 16 16', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v); path.setAttribute('d', 'M2.5 3h11v7.5H7L4 13.5v-3H2.5z'); svg.append(path); return svg; }
function bookmarkIcon() { const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'), path = document.createElementNS(NS, 'path'); for (const [k, v] of Object.entries({ viewBox: '0 0 16 16', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v); path.setAttribute('d', 'M4 2.5h8v11L8 10.5l-4 3z'); svg.append(path); return svg; }

/** A row's less used actions in one menu behind a three-dot button (menu_button.js: arrow keys, Escape back to the button, Tab or a tap elsewhere closes). items: [{ label, title, run(button) }]. */
function moreMenu(items, label) {
    const id = `inbox-more-${++moreMenus}`, wrap = DT.el('span', 'inbox-row-more'), toggle = DT.el('button', 'btn btn-quiet btn-icon inbox-row-more-toggle');
    toggle.type = 'button'; toggle.id = id; toggle.setAttribute('aria-haspopup', 'menu'); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', `${id}-menu`); toggle.setAttribute('aria-label', `More actions for ${label}`);
    toggle.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></svg>';
    const menu = DT.el('div', 'menu dt-mail-menu'); menu.id = `${id}-menu`; menu.hidden = true; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', `Actions for ${label}`);
    for (const it of items) {
        const b = DT.el('button', `menu-item${it.danger ? ' inbox-deny' : ''}`, it.label); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.setAttribute('aria-label', `${it.label}: ${label}`); if (it.title) b.title = it.title; // the word, then the file: the same name the row's own buttons have
        b.addEventListener('click', async e => { e.stopPropagation(); (await importOnce('./menu_button.js')).closeMenus({ restoreFocus: !isPhoneLayout() || wrap.contains(document.activeElement) }); it.run(b); }); // a phone row's dots are out of sight (#11671): focus goes back to them only for the keyboard that was in the menu
        menu.append(b);
    }
    toggle.addEventListener('click', async e => { e.stopPropagation(); (await importOnce('./menu_button.js')).toggleMenu(toggle); });
    wrap.append(toggle, menu); return wrap;
}

let needsTable = null; // the Needs you table on screen: a bulk action clears its selection when it is done
/** A phone's Needs you selection (#11671, the operator's Gmail-style rows): long-press a row to select it, tap to add more, and the bar that takes the toolbar's line acts on all of them, one request per item through the same routes as a row's own buttons (no bulk route). An action that does not fit every selected row is off. */
function needsBulkActions() {
    const reviews = rows => rows.length > 0 && rows.every(s => s.review && !decisionNeedsPerson(splitKey(s.review.team).server));
    const markable = rows => rows.length > 0 && rows.every(s => s.goalDone || (s.review && !decisionNeedsPerson(splitKey(s.review.team).server))); // a file and a goal that looks done are read and unread the same way (#12029)
    const readOf = s => s.goalDone ? isGoalDoneRead(goalTeamHere(s.goalDone), s.goalDone) : isRead(s.review);
    const setReadOf = (s, read) => s.goalDone ? (read ? markGoalDoneRead : markGoalDoneUnread)(goalTeamHere(s.goalDone), s.goalDone) : setReviewRead(s.review, read);
    const tell = async (text, announce = text, opts) => { const { showToast, announceNotice } = await importOnce('./notifications.js'); showToast(text, false, undefined, opts); announceNotice(announce); };
    const each = async (rows, fn) => { let ok = 0; const bad = []; for (const s of rows) { try { await fn(s); ok++; } catch (e) { bad.push(e && e.message ? e.message : 'not saved'); } } return { ok, bad }; };
    const words = (verb, r, total) => r.bad.length ? `${verb} ${r.ok} of ${total}: ${r.bad[0]}` : `${verb} ${r.ok}`;
    const done = () => { needsTable?.clear(); };
    const unopened = rows => rows.filter(s => s.review && !isRead(s.review)).length;
    return [
        { label: 'Approve', hidden: rows => rows.length > 0 && rows.every(s => s.goalDone), icon: () => { const i = DT.el('span', 'material-icons', 'check'); i.setAttribute('aria-hidden', 'true'); return i; }, disabled: rows => !reviews(rows), askWhen: (n, rows) => n > 1 || unopened(rows) > 0, confirm: (n, rows) => { const m = unopened(rows || []); return n === 1 ? 'Approve this file? It is not opened yet.' : `Approve ${n} files?${m ? ` ${m} of them ${m === 1 ? 'is' : 'are'} not opened yet.` : ''}`; }, /* several files, or one nobody opened (#12059, #11999) */ run: async rows => { const { approveRow } = await importOnce('./artifact_review.js'); const r = await each(rows, s => approveRow(s.review.team, s.review)); done(); tell(words('Approved', r, rows.length)); } },
        { label: 'Dismiss', icon: () => { const i = DT.el('span', 'material-icons', 'block'); i.setAttribute('aria-hidden', 'true'); return i; }, disabled: rows => rows.some(s => s.proposal), /* a proposal is approved or rejected, not ignored (selecting one is for later actions) */ run: async rows => {
            const { ignoreRow, unignoreRow } = await importOnce('./artifact_review.js'), asks = await importOnce('./ask_ignore.js'), undo = [];
            const r = await each(rows, async s => {
                if (s.review) { await ignoreRow(s.review.team, s.review); undo.push(() => unignoreRow(s.review.team, s.review)); }
                else if (s.operatorAsk && s.operatorAsk.kind === 'ask') { await asks.closeAsk(s.operatorAsk); undo.push(() => asks.reopenAsk(s.operatorAsk)); }
                else if (s.welcome && s.welcome.dismiss) dismissWelcome(s.welcome.id);
                else if (s.autorun) markSeen(s.autorun);
                else if (s.goalDone) undo.push(await hideGoalDone(goalTeamHere(s.goalDone), s.goalDone, 'ignore'));
                else throw new Error('that one cannot be dismissed');
            });
            asks.refreshOperatorAsks(true); syncGoalDoneCount(); done();
            tell(words('Dismissed', r, rows.length), `${words('Dismissed', r, rows.length)}.${undo.length ? ' Undo is in the notice.' : ''}`, undo.length ? { action: { label: 'Undo', onClick: async () => { for (const f of undo) { try { await f(); } catch { /* it stays ignored */ } } asks.refreshOperatorAsks(true); refreshReviews(true); syncGoalDoneCount(); renderInboxNav(true); tell('Back in Needs you'); } } } : undefined); // one after the other: goals share one hidden list that each undo rewrites (#12328)
        } },
        { label: 'Close goal', hidden: rows => rows.length > 0 && !rows.some(s => s.goalDone), more: true, disabled: rows => !(rows.length === 1 && rows[0].goalDone), run: rows => { done(); openGoalDone(rows[0].goalDone, true); } }, // a goal that looks done: its two answers are in the bar's menu on a phone, where the row has no buttons; a ninth icon made the bar wider than a 360 px toolbar (#12328)
        { label: 'Not yet', hidden: rows => rows.length > 0 && !rows.some(s => s.goalDone), more: true, disabled: rows => !(rows.length > 0 && rows.every(s => s.goalDone)), run: async rows => {
            const undo = [], r = await each(rows, async s => { undo.push(await hideGoalDone(goalTeamHere(s.goalDone), s.goalDone, 'not-yet')); });
            syncGoalDoneCount(); done();
            tell(words('Hidden until a task is added:', r, rows.length), `${words('Hidden until a task is added:', r, rows.length)}.${undo.length ? ' Undo is in the notice.' : ''}`, undo.length ? { action: { label: 'Undo', onClick: async () => { for (const f of undo) { try { await f(); } catch { /* it stays hidden */ } } syncGoalDoneCount(); renderInboxNav(true); } } } : undefined); // one after the other: each undo rewrites the hidden list, and two at once keep only the last write (#12328)
        } },
        { label: 'Save for later', hidden: rows => rows.length > 0 && rows.every(s => s.goalDone), icon: bookmarkIcon, disabled: rows => !reviews(rows), run: async rows => { const { saveRow } = await importOnce('./artifact_review.js'); const r = await each(rows, s => saveRow(s.review.team, s.review)); done(); tell(words('Saved', r, rows.length)); } },
        { label: 'Changes', hidden: rows => rows.length > 0 && rows.every(s => s.goalDone), more: true, disabled: rows => !(rows.length === 1 && reviews(rows)), run: rows => { done(); openReview(rows[0].review, { requestChanges: true }); } }, // a change request is words for one file: with several selected it is off,
        { label: 'Mark read', more: true, disabled: rows => !markable(rows) || rows.every(readOf), run: async rows => { const r = await each(rows.filter(s => !readOf(s)), s => setReadOf(s, true)); syncGoalDoneCount(); done(); tell(words('Marked read', r, r.ok + r.bad.length)); } },
        { label: 'Mark unread', more: true, disabled: rows => !markable(rows) || !rows.some(readOf), run: async rows => { const r = await each(rows.filter(readOf), s => setReadOf(s, false)); syncGoalDoneCount(); done(); tell(words('Marked unread', r, r.ok + r.bad.length)); } },
    ];
}

/** A review row's actions, the one set on every screen (#11552, approved by the operator): Approve, Changes, Deny, Dismiss as words, in that order; Mark unread (a read row) in More, and on a phone Deny and Dismiss too. The row itself opens the file. Each action that clears the row keeps the person's place. */
export function reviewActions(row, inSaved = false) { // inSaved (#11641, #11799): a saved file has the same actions as a Needs you row; its menu has Move to Needs you, not Save for later
    const compact = compactActions(), box = DT.el('div', 'inbox-review-actions inbox-slots'); // option B's four slots: Approve, Request changes, Save, the dots (the same on every width)
    const file = markHidden(row.name, { strict: true }); // what a button, a menu and a spoken line call the file: hidden characters written out (Security's SHOULD, #11552)
    const errorText = DT.el('span', 'inbox-review-error'); errorText.setAttribute('role', 'alert');
    const failed = (b, error) => { if (b.isConnected) b.disabled = false; errorText.textContent = error.message; };
    const word = (text, name, cls, run) => { const b = DT.el('button', `btn btn-small ${cls}`.trim(), text); b.type = 'button'; b.setAttribute('data-slot', text.toLowerCase()); b.setAttribute('aria-label', `${name}: ${file}`); b.addEventListener('click', () => run(b)); if (text === 'Approve') b.classList.add('inbox-main-action'); return b; }; // a button's place is its column (data-slot): the same x on every row (#11630)
    const approve = b => { b.disabled = true; errorText.textContent = ''; const settle = keepPlace(b); // replaces Mark reviewed (#136584): it clears the row, marks the review approved and tells the agent that uploaded it
        return importOnce('./artifact_review.js').then(async ({ approveRow, sayApproved }) => { sayApproved(row.name, await approveRow(row.team, row)); sayLive(`Approved ${file}.`); await settle(); }).catch(error => failed(b, error)); };
    const approveUnopened = b => showConfirmModal('Approve without opening?', `${file} has not been opened. Approve it without reading it?`, () => approve(b), () => openReview(row), { label: 'Approve', cancelLabel: 'Open it first', danger: false }); // a stray click on the hover button approved a report unread (#11999, the operator): an unread file asks first; Open it first (or Escape) opens it
    const approveNote = b => { const settle = keepPlace(b); return importOnce('./artifact_review.js').then(({ openApproveNoteDialog }) => openApproveNoteDialog(row.team, row, async () => { sayLive(`Approved ${file} with a note.`); await settle(); })).catch(error => failed(b, error)); }; // #11888: approved with one short comment for the agent, not shown again
    const deny = b => { const settle = keepPlace(b); return importOnce('./artifact_review.js').then(({ openDenyDialog }) => openDenyDialog(row.team, row, async () => { sayLive(`Denied ${file}.`); await settle(); })).catch(error => failed(b, error)); };
    const ignore = b => { b.disabled = true; errorText.textContent = ''; const settle = keepPlace(b);
        return importOnce('./artifact_review.js').then(async ({ ignoreRow, sayIgnored }) => { await ignoreRow(row.team, row); sayIgnored(row.team, row); sayLive(`Dismissed ${file}.`); await settle(); }).catch(error => failed(b, error)); };
    const save = b => { b.disabled = true; errorText.textContent = ''; const settle = keepPlace(b); // Save for later (#11641): out of Needs you, kept in Saved, nobody told
        return importOnce('./artifact_review.js').then(async ({ saveRow, saySaved }) => { await saveRow(row.team, row); saySaved(row.team, row); sayLive(`Saved ${file} for later.`); await settle(); }).catch(error => failed(b, error)); };
    const unsave = b => { b.disabled = true; errorText.textContent = '';
        return importOnce('./artifact_review.js').then(async ({ unsaveRow }) => { await unsaveRow(row.team, row); sayLive(`${file} is back in Needs you.`); }).catch(error => failed(b, error)); };
    box._ignore = ignore; // a swipe on a phone is the same Dismiss (#11642)
    const unread = b => { b.disabled = true; errorText.textContent = ''; return setReviewRead(row, false).then(() => sayLive(`Marked ${file} unread.`)).catch(error => failed(b, error)); };
    const bookmark = !inSaved && !isPhoneLayout() && !decisionNeedsPerson(splitKey(row.team).server); // the star's slot is Save for later (#11672, the operator): a bookmark button; a phone has it in the three dots
    let saveButton = null; // Save for later: an icon beside Request changes (the third button of the row), in the dots on a phone
    if (bookmark) { const mark = DT.el('button', 'btn btn-quiet btn-icon inbox-bookmark'); mark.type = 'button'; mark.setAttribute('data-slot', 'save'); mark.setAttribute('aria-label', `Save for later: ${file}`); mark.title = 'Save for later'; mark.append(bookmarkIcon()); mark.addEventListener('click', () => save(mark)); saveButton = mark; }
    const menu = [];
    if (!decisionNeedsPerson(splitKey(row.team).server)) { // through Coral Hub a guest cannot decide
        box.append(word('Approve', 'Approve', 'btn-primary', b => (isRead(row) ? approve(b) : approveUnopened(b))));
        const changes = DT.el('button', 'btn btn-quiet btn-icon inbox-changes'); changes.type = 'button'; changes.setAttribute('data-slot', 'changes'); changes.setAttribute('aria-label', `Request changes: ${file}`); changes.title = 'Request changes'; changes.append(changesIcon()); changes.addEventListener('click', () => openReview(row, { requestChanges: true })); box.append(changes); if (saveButton) box.append(saveButton); // option B (the operator's pick, #12231): one Approve, a quiet icon for Request changes, Save beside it, the rest in the dots
        menu.push({ label: 'Approve with a note', title: 'Approve it with one short comment for the agent; it is not shown again', run: approveNote }, { label: 'Dismiss', title: 'Take it out of Needs you; nobody is told', run: ignore }, { label: 'Deny', title: 'A final no: the agent is told', danger: true, run: deny });
        if (inSaved) menu.push({ label: 'Move to Needs you', title: 'Put it back in Needs you as it was', run: unsave });
        else if (!bookmark) menu.push({ label: 'Save for later', title: 'Keep it in Saved, out of Needs you; nobody is told', run: save });
    }
    if (isRead(row) && !inSaved) { box.classList.add('inbox-review-actions-read'); menu.push({ label: 'Mark unread', title: 'Count it in Needs you again', run: unread }); }
    if (menu.length) { const more = moreMenu(menu, file); more.setAttribute('data-slot', 'dots'); box.append(more); }
    box.append(errorText); return box;
}

/** A failed run opens on its job's or workflow's page; opening it is what clears it from Needs you. */
function openRun(run) { markSeen(run); go(runRoute(run)); }
/** What a button an agent put on a question may open (#11643): the page runs these only after the server claimed the button and named its stored action. */
const askRunners = {
    task: (a, id) => openItemRoute('tasks', a.board, id, `${a.board}#${id}`),
    goal: (a, id) => go({ ...folderRoute, id: a.board, item: id }),
    artifact: async (a, hex) => { const { openArtifactViewer } = await importOnce('./artifact_viewer.js'); openArtifactViewer(hex, { server: splitKey(a.board).server, board: splitKey(a.board).name, filename: `File from ${markHidden(a.asker, { strict: true })}` }); },
};
/** A question to the Operator: Answer opens it whole with the reply box (#11417). */
function askActions(a) {
    const box = DT.el('div', `inbox-review-actions inbox-slots${compactActions() ? ' inbox-slots-compact' : ''}`);
    const who = markHidden(a.asker, { strict: true });
    const reply = DT.el('button', 'btn btn-small', 'Answer'); reply.type = 'button'; reply.setAttribute('data-slot', 'approve'); // Answer sits where Approve does (#11630); it is the row's main button
    reply.classList.add('inbox-main-action'); // Answer, as the approved action set names it (#11552); the dialog it opens still has the reply box
    reply.setAttribute('aria-label', `Answer the question of ${who}`); reply.addEventListener('click', () => openAskDialog(a, () => $('group-table-view')?.querySelector('input[type=search]')?.focus({ preventScroll: true }), askRunners));
    box.append(reply);
    if (a.kind === 'ask') { // a wait has no ask row to close: only a question is ignorable
        const failed = DT.el('span', 'inbox-review-error'); failed.setAttribute('role', 'alert');
        const ignore = no => { no.disabled = true; failed.textContent = ''; const settle = keepPlace(no);
            return importOnce('./ask_ignore.js').then(async ({ ignoreAsk }) => { await ignoreAsk(a, who); sayLive(`Dismissed the question of ${who}.`); await settle(); }).catch(error => { no.disabled = false; failed.textContent = error.message; }); };
        box._ignore = ignore;
        if (isPhoneLayout()) box.append(moreMenu([{ label: 'Dismiss', title: 'Take it out of Needs you; nobody is told', run: ignore }], `the question of ${who}`), failed); // a phone row has no Dismiss button: the menu, or a swipe (#11642)
        else { const no = DT.el('button', 'btn btn-small btn-quiet', 'Dismiss'); no.type = 'button'; no.setAttribute('data-slot', 'ignore'); no.setAttribute('aria-label', `Dismiss the question of ${who}`); no.addEventListener('click', () => ignore(no)); box.append(no, failed); }
    }
    return box;
}

function runActions(run) {
    const box = DT.el('div', 'inbox-review-actions');
    const open = DT.el('button', 'btn btn-small', 'Open'); open.type = 'button';
    open.classList.add('inbox-main-action'); open.setAttribute('aria-label', `Open ${run.name}, failed run`); open.addEventListener('click', () => openRun(run));
    const ignore = () => { markSeen(run); sayLive(`Dismissed the failed run of ${run.name}.`); $('group-table-view')?.querySelector('input[type=search]')?.focus({ preventScroll: true }); };
    box._ignore = ignore;
    if (isPhoneLayout()) { box.append(open, moreMenu([{ label: 'Dismiss', title: 'Take it out of Needs you; nobody is told', run: ignore }], run.name)); return box; } // no Dismiss button on a phone row: the menu, or a swipe (#11642)
    const done = DT.el('button', 'btn btn-small', 'Dismiss'); done.type = 'button';
    done.setAttribute('aria-label', `Dismiss the failed run of ${run.name}`); done.addEventListener('click', ignore);
    box.append(open, done); return box;
}

/** The tab's badge counts the goal items too: told after every read of the goals and of what was hidden (#11825). */
let quietTimer = 0;
function syncGoalDoneCount() {
    setGoalDoneCount(goalDoneRows().filter(needsUnread).length); updateInboxTab();
    clearTimeout(quietTimer); // a goal still in its quiet period (#12161) is drawn when the period ends, with no refresh needed
    const due = nextQuietEnd(goals, goalTeamHere);
    if (due !== null) quietTimer = setTimeout(() => { syncGoalDoneCount(); renderInboxNav(true); }, Math.min(due, 2 ** 31 - 1) + 250);
}
/** The goal's page, from its item; with close the Close dialog is opened on it, set to Done, once the page is up (#11825). */
let closeAfterOpen = null;
function openGoalDone(g, close = false, rowKey = '') {
    markGoalDoneRead(goalTeamHere(g), g).then(() => { syncGoalDoneCount(); renderInboxNav(true); }).catch(error => sayLive(`Not marked read: ${error && error.message ? error.message : 'try again'}.`)); // opening it is reading it (#11983)
    closeAfterOpen = close ? { team: g.board_id, id: g.id } : null;
    const row = rowKey || document.activeElement?.closest?.('tr[data-key]')?.dataset.key || '', place = $('group-table-view')?.scrollTop || 0; // read before the focus moves off the row (#11964)
    quietFocus($('inbox-view'));
    itemOpeners.set('needs', { key: row, scroll: place }); // Back returns to Needs you as it was (its place), not to the Goals tab (#11950)
    go({ ...folderRoute, id: g.board_id, item: g.id });
}
/** A "Goal looks done" item's actions (#11825): Close goal (the goal's Close dialog, set to Done), Not yet (hidden until a task is added) and Dismiss (hidden for good, Undo in the notice); on a phone Dismiss is in the menu. */
/** A skill waiting for approval has one action: Review opens it in the Skills tab, where the files are read before anything is approved. */
function skillActions(r) {
    const box = DT.el('div', 'inbox-review-actions'), b = DT.el('button', 'btn btn-small', 'Review'); b.type = 'button'; b.setAttribute('aria-label', `Review the skill ${skillName(r)}`);
    b.addEventListener('click', e => { e.stopPropagation(); openSkill(r); });
    box.append(b); return box;
}

function goalDoneActions(g) {
    const box = DT.el('div', 'inbox-review-actions inbox-goaldone-actions'), title = markedText(g.title), team = goalTeamHere(g);
    const said = text => { sayLive(text); };
    const hide = async (mode, toast) => {
        try {
            const undo = await hideGoalDone(team, g, mode);
            const { showToast } = await importOnce('./notifications.js');
            showToast(toast, false, 30000, { action: { label: 'Undo', onClick: async () => { try { await undo(); } catch { /* it stays hidden */ } syncGoalDoneCount(); renderInboxNav(true); } } });
            said(`${toast}.`);
        } catch (e) { said(`Not saved: ${e && e.message ? e.message : 'try again'}.`); }
        syncGoalDoneCount();
        renderInboxNav(true);
    };
    const btn = (label, aria, cls, run) => { const b = DT.el('button', `btn btn-small ${cls}`, label); b.type = 'button'; b.setAttribute('aria-label', aria); b.addEventListener('click', e => { e.stopPropagation(); run(); }); return b; };
    box.append(btn('Close goal', `Close goal ${g.id}: ${title}`, 'btn-primary inbox-main-action', () => openGoalDone(g, true)), btn('Not yet', `Not yet for goal ${g.id}: ${title}`, '', () => hide('not-yet', 'Hidden until a task is added')));
    const menu = [];
    if (isPhoneLayout()) menu.push({ label: 'Dismiss', title: 'Take it out of Needs you; nobody is told', run: () => hide('ignore', 'Dismissed') });
    else box.append(btn('Dismiss', `Dismiss goal ${g.id}: ${title}`, 'btn-quiet', () => hide('ignore', 'Dismissed')));
    if (isGoalDoneRead(team, g)) { // opened: listed, not counted, as a read file is (#11983)
        box.classList.add('inbox-review-actions-read');
        menu.push({ label: 'Mark unread', title: 'Count it in Needs you again', run: async () => { try { await markGoalDoneUnread(team, g); said(`Goal ${g.id} is back in Needs you.`); } catch (e) { said(`Not saved: ${e && e.message ? e.message : 'try again'}.`); } syncGoalDoneCount(); renderInboxNav(true); } });
    }
    if (menu.length) box.append(moreMenu(menu, title));
    return box;
}

/** A welcome item's actions (#11443): its own action, and a quiet Dismiss for all but the welcome itself. */
function welcomeActions(w) {
    const box = DT.el('div', 'inbox-review-actions inbox-welcome-actions');
    const go = DT.el('button', 'btn btn-small btn-primary', w.go); go.type = 'button';
    go.classList.add('inbox-main-action'); go.setAttribute('aria-label', `${w.go}: ${w.title}`);
    go.addEventListener('click', () => runWelcome(w.id));
    box.append(go);
    if (w.dismiss) {
        const ignore = () => { dismissWelcome(w.id); sayLive(`Dismissed: ${w.title}.`); };
        if (isPhoneLayout()) box.append(moreMenu([{ label: 'Dismiss', title: 'Take it out of Needs you; nobody is told', run: ignore }], w.title)); // no Dismiss button on a phone row: the menu, or a swipe (#11642)
        else {
            const no = DT.el('button', 'btn btn-small btn-quiet', 'Dismiss'); no.type = 'button';
            no.setAttribute('aria-label', `Dismiss: ${w.title}`); no.addEventListener('click', ignore);
            box.append(no);
        }
    }
    return box;
}

function unrecordedActions() {
    const box = DT.el('div', 'inbox-review-actions');
    const b = DT.el('button', 'btn btn-small', 'Record for all agents'); b.type = 'button';
    b.setAttribute('aria-label', "Record for all agents: check each program before they are recorded");
    b.addEventListener('click', () => recordAllAgents());
    box.append(b); return box;
}

const dockSavedState = DT.tableState();
const savedState = DT.tableState(); // one word set for a task's state (Queued, In progress, Blocked, In review, Done), here as everywhere
const goalsState = DT.tableState();
const taskText = t => [t.title, t.board, t.priority, stateOf(t), t.created_by].join(' ').toLowerCase();
let taskFilters = { ...TF.EMPTY }, taskState = 'all', taskBar = null;
const taskMatches = t => serverMatches(t, taskFilters) && (!queries.tasks || taskText(t).includes(queries.tasks.toLowerCase()))
    && (!taskFilters.team || t.project === taskFilters.team)
    && (!taskFilters.priority || t.priority === taskFilters.priority)
    && (!taskFilters.from || Date.parse(t.updated_at || t.created_at) >= new Date(taskFilters.from + 'T00:00:00').getTime());
const taskRows = () => tasks.filter(t => taskMatches(t) && (taskState === 'all' || stateOf(t) === taskState)).sort((a, b) => (RANK[a.priority] ?? 3) - (RANK[b.priority] ?? 3));
function inboxTaskToolbar() {
    if (!taskBar) {
        taskBar = TV.tasksToolbar('mine', next => {
            inboxTasksState.selected.clear();
            taskFilters = next;
            queries.tasks = next.q;
            const input = $('inbox-search');
            if (input && group === 'tasks') input.value = next.q;
            renderInboxNav(true);
        });
        taskBar.node.classList.add('inbox-tasks-toolbar', 'inbox-folder-toolbar');
        taskBar.node.querySelector('.list-bar-search-row').classList.add('gt-toolbar');
    }
    const taskTeams = [...new Set(tasks.map(t => t.project))].sort((a, b) => teamLabel(a).localeCompare(teamLabel(b)));
    TF.setTeamNames(new Map(taskTeams.map(k => [k, teamLabel(k)])));
    taskBar.setOptions('team', taskTeams, Object.fromEntries(taskTeams.map(k => [k, teamLabel(k)])));
    taskBar.set({ ...taskFilters, q: queries.tasks });
    syncServerField(taskBar);
    if (!inboxTasksState.selected.size) Toolbar.mountSelection(taskBar.node.querySelector('.list-bar-search-row'), null);
    const states = ['Queued', 'Waiting', 'In progress', 'In review', 'Blocked'];
    const rows = tasks.filter(taskMatches);
    const active = document.activeElement;
    const held = taskBar.node.contains(active) ? (active.matches('.team-tb-select') ? 'select' : active.dataset.filter) : null;
    IT.adoptPills(taskBar.node, { label: 'Show tasks that are', current: taskState,
            items: [{ key: 'all', label: 'All', count: rows.length }, ...states.map(key => ({ key, label: key, count: rows.filter(t => stateOf(t) === key).length }))],
            onPick: key => { inboxTasksState.selected.clear(); taskState = key; renderInboxNav(true); } });
    if (held) {
        const next = held === 'select' ? taskBar.node.querySelector('.team-tb-select') : [...taskBar.node.querySelectorAll('[data-filter]')].find(el => el.dataset.filter === held);
        next?.focus({ preventScroll: true });
    }
    return { node: taskBar.node, signature: JSON.stringify([taskFilters, queries.tasks, taskState, taskTeams]) };
}
async function refreshTasks() {
    try {
        tasks = await coralInboxAdapter.listTasks();
        setInboxCount('tasks', tasks.length, tasks.filter(t => t.priority === 'high').length);
    } catch { tasks = []; }
    renderInboxNav(true);
}

// ── Goals ────────────────────────────────────────────────────────────────
let goals = []; // the open goals of every team (GET /api/goals): id, board_id, title, outcome, state, rollup, updated_at
const goalKey = g => `${g.board_id}#${g.id}`;
/** The phone's bulk action on selected goals of any team: Close as Done or Dropped with a reason, one request per goal on its own team (#12230). */
const closeGoalsActions = () => [{ label: 'Close goals', danger: true,
    choose: { label: 'Close as', options: () => [{ value: 'done', label: 'Done' }, { value: 'dropped', label: 'Dropped' }], text: { label: 'Reason for closing', maxLength: 300 } },
    confirm: n => `Close ${n} goals? Any open tasks stay open.`,
    run: async (picked, keys, as, reason) => { if (!reason) return; let done = 0, failed = 0;
        for (const g of picked) { try { const r = await boardFetch(g.board_id, `/goals/${g.id}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: OPERATOR_ID, state: as, reason }) }); if (!r.ok) throw new Error('Close failed'); goalsState.selected.delete(goalKey(g)); done++; } catch { failed++; } }
        showToast(`Closed ${done} goals${failed ? `; ${failed} failed and remain selected` : ''}`, !!failed); await refreshGoals(); renderInboxNav(true); } }];
const goalTeam = g => teamLabel(g.board_id); // with its computer when a hub has more than one: two teams called alpha are two (#8774)
let goalFilters = GF.loadFilters(), goalBar = null;
let activityFilters = AF.loadFilters(), activityBar = null;
const goalRows = () => GF.ordered(goals.filter(g => GF.matches(g, goalFilters, goalTeam) && serverMatches(g, goalFilters)), goalFilters);
/** New goal at the right of the Goals toolbar (#11593, the operator): the existing New goal form (goals_view.js, lazy), on the team the Team filter names, else the first; with more than one team the form asks which. */
function newGoalAction() {
    const b = DT.el('button', 'btn btn-primary goals-new', 'New goal'); b.type = 'button';
    b.addEventListener('click', async () => {
        const [{ fetchProjects }, GV] = await Promise.all([importOnce('./board_fetch.js'), importOnce('./goals_view.js')]);
        let list = []; try { list = (await fetchProjects()).map(p => ({ key: String(p.project), label: teamLabel(p.project, p.board_label || '') })).filter(t => t.key); } catch { /* the teams the goals name are the fallback */ }
        if (!list.length) list = [...new Set(goals.map(g => g.board_id))].map(k => ({ key: k, label: goalTeam({ board_id: k }) }));
        list.sort((x, y) => x.label.localeCompare(y.label));
        GV.openCreate({ project: list.some(t => t.key === goalFilters.team) ? goalFilters.team : list[0]?.key, teams: list, onCreated: () => refreshGoals() });
    });
    return b;
}
/** The Goals folder's toolbar (#8596): the search, the Filters icon beside it (Team, Driver, Updated since, Sort), the state pills, and the chips of what is on. */
function inboxGoalsToolbar() {
    if (!goalBar) {
        goalBar = IT.folderToolbar({
            idp: 'inbox-goals', noun: 'goal', searchLabel: 'Search goals',
            sorts: { values: GF.SORTS, labels: GF.SORT_LABEL, aria: 'Sort goals' },
            fields: [
                { type: 'select', key: 'team', id: 'inbox-goals-team', label: 'Team', values: [], labels: {}, any: 'Any team' },
                { type: 'select', key: 'driver', id: 'inbox-goals-driver', label: 'Driver', values: [], labels: {}, any: 'Any driver' },
                { type: 'date', key: 'from', id: 'inbox-goals-from', label: 'Updated since' },
            ],
            model: { EMPTY: GF.EMPTY, clean: GF.clean, chips: GF.chips, isFiltered: GF.isFiltered, without: GF.without },
        }, next => {
            goalFilters = next; GF.saveFilters(next);
            const input = $('inbox-search'); if (input && group === 'goals') input.value = next.q; // the sidebar's box shows the same words
            renderInboxNav(true);
        });
    }
    const teams = [...new Set(goals.map(g => g.board_id))].sort((a, b) => goalTeam({ board_id: a }).localeCompare(goalTeam({ board_id: b })));
    const drivers = [...new Set(goals.map(g => g.driver).filter(Boolean))].sort();
    GF.setTeamNames(new Map(teams.map(t => [t, goalTeam({ board_id: t })])));
    const rows = goals.filter(g => GF.matches(g, { ...goalFilters, state: '' }, goalTeam));
    const counts = GF.STATES.map(key => rows.filter(g => String(g.state || '').toLowerCase() === key).length);
    const node = goalBar.draw({
        filters: goalFilters,
        options: { team: { values: teams, labels: Object.fromEntries(teams.map(t => [t, goalTeam({ board_id: t })])) }, driver: { values: drivers } },
        pills: { label: 'Show goals that are', current: goalFilters.state || 'all',
            items: [{ key: 'all', label: 'All', count: rows.length }, ...GF.STATES.map((key, i) => ({ key, label: GF.STATE_LABEL[key], count: counts[i] }))],
            onPick: key => { goalFilters = { ...goalFilters, state: key === 'all' ? '' : key }; GF.saveFilters(goalFilters); renderInboxNav(true); } },
        action: newGoalAction(),
    });
    return { node, signature: JSON.stringify([goalFilters, teams, drivers, counts, rows.length]) };
}
/** The Activity folder's toolbar (#12070): the search, Filters (Team, Action, Since) and the order, on the shared list bar. The Computer field is not offered: the record is this computer's alone. */
function inboxActivityToolbar() {
    if (!activityBar) {
        activityBar = IT.folderToolbar({
            idp: 'inbox-activity', noun: 'action', searchLabel: 'Search activity',
            sorts: { values: AF.SORTS, labels: AF.SORT_LABEL, aria: 'Sort activity' },
            fields: [
                { type: 'select', key: 'team', id: 'inbox-activity-team', label: 'Team', values: [], labels: {}, any: 'Any team' },
                { type: 'select', key: 'action', id: 'inbox-activity-action', label: 'Action', values: AF.ACTIONS, labels: AF.ACTION_LABEL, any: 'Any action' },
                { type: 'date', key: 'from', id: 'inbox-activity-from', label: 'Since' },
            ],
            model: { EMPTY: AF.EMPTY, clean: AF.clean, chips: AF.chips, isFiltered: AF.isFiltered, without: AF.without },
        }, next => {
            activityFilters = next; AF.saveFilters(next);
            const input = $('inbox-search'); if (input && group === 'activity') input.value = next.q; // the sidebar's box shows the same words
            renderInboxNav(true);
        });
    }
    const teams = AC.teams();
    AF.setTeamNames(new Map(teams.map(t => [t, teamLabel(t)])));
    const node = activityBar.draw({ filters: activityFilters, options: { team: { values: teams, labels: Object.fromEntries(teams.map(t => [t, teamLabel(t)])) } } });
    activityBar.bar.showField('server', false);
    return { node, signature: JSON.stringify([activityFilters, teams, AC.total()]) };
}
async function refreshGoals() {
    try {
        goals = await listInboxGoals();
    } catch { goals = []; }
    try { // what was hidden from another browser or the phone (Not yet, Dismiss) is on the machine: read it with the goals
        const r = await fetch('/api/settings');
        if (r.ok) { const saved = (await r.json()).settings || {}; state.settings = { ...(state.settings || {}), [GOAL_DONE_SETTING]: saved[GOAL_DONE_SETTING] || '' }; }
    } catch { /* the list this page has stays */ }
    if (!nativeInbox()) await loadPendingSkills(); // the skills that wait for the Operator are items of Needs you too (#12139); the Hub has no such route, so its Inbox does not ask (the Hub census, #12260)
    syncGoalDoneCount();
    renderInboxNav(true);
}

// ── Chats ────────────────────────────────────────────────────────────────
const chatFilters = new Map(), chatBars = new Map(); // folder key -> its filters, its toolbar
const chatFiltersOf = key => { if (!chatFilters.has(key)) chatFilters.set(key, { ...CF.loadFilters(key), q: queries[key] || '' }); return chatFilters.get(key); };
/** A chat folder's toolbar (#8603): the search and the Filters icon beside it (CLI, Agent, Tag, Dates: the fields the folder does not already decide), the chips below; one bar per folder, kept. */
function inboxChatsToolbar(key) {
    if (!chatBars.has(key)) {
        const has = new Set(CF.fieldsFor(key)), fields = [];
        if (has.has('cli')) fields.push({ type: 'select', key: 'cli', id: 'inbox-chats-cli', label: 'CLI', values: CF.CLIS.map(c => c[0]), labels: Object.fromEntries(CF.CLIS), any: 'Any CLI' });
        if (has.has('agent')) fields.push({ type: 'text', key: 'agent', id: 'inbox-chats-agent', className: 'list-bar-by', label: 'Agent', max: 80, placeholder: 'Agent name' });
        if (has.has('tagId')) fields.push({ type: 'select', key: 'tagId', id: 'inbox-chats-tag', label: 'Tag', values: [], labels: {}, any: 'Any tag' });
        if (has.has('dates')) fields.push({ type: 'date', key: 'from', id: 'inbox-chats-from', label: 'From' }, { type: 'date', key: 'to', id: 'inbox-chats-to', label: 'To' });
        chatBars.set(key, IT.folderToolbar({ idp: 'inbox-chats', noun: 'chat', searchLabel: CH.searchWords(key), fields, commitOnEnter: nativeInbox(), model: { EMPTY: CF.EMPTY, clean: CF.clean, chips: CF.chips, isFiltered: CF.isFiltered, without: CF.without } }, next => {
            chatFilters.set(key, next); CF.saveFilters(key, next);
            queries[key] = next.q;
            const input = $('inbox-search'); if (input && group === key) input.value = next.q; // the sidebar's box shows the same words
            if (nativeInbox()) CH.resetChatLists(key); // a search sent on Enter is one read of each online computer, even for words read before (a list kept from then would answer it with no request)
            renderInboxNav(true);
        }));
    }
    const tags = CH.chatTags();
    CF.setTagNames(new Map(tags.map(t => [String(t.id), t.name])));
    const filters = chatFiltersOf(key);
    const node = chatBars.get(key).draw({ filters, options: { tagId: { values: tags.map(t => String(t.id)), labels: Object.fromEntries(tags.map(t => [String(t.id), t.name])) } } });
    return { node, signature: JSON.stringify([key, filters, tags.map(t => [t.id, t.name])]) };
}

// ── Saved ────────────────────────────────────────────────────────────────
let savedBar = null;
/** The Saved page's toolbar (#8602): the search, the Open | Done pills and the Filters icon (Type, Team, From, Saved since, Sort) on the same filters as the sidebar's Display options. */
function inboxSavedToolbar() {
    if (!savedBar) {
        savedBar = IT.folderToolbar(saved.savedPageSpec(), next => {
            saved.setSavedFilters(next);
            const input = $('inbox-search'); if (input && group === 'saved') input.value = next.q || ''; // the sidebar's box shows the same words
        });
    }
    const v = saved.savedView(), filters = saved.savedFiltersNow(), options = saved.savedPageOptions();
    const node = savedBar.draw({ filters, options,
        pills: { label: 'Show', current: v.tab, items: [{ key: 'open', label: 'Open', count: v.totals.open + savedFiles().length }, { key: 'done', label: 'Done', count: v.totals.done }], onPick: key => saved.setSavedTab(key) } });
    return { node, signature: JSON.stringify([filters, v.tab, v.totals, options, savedFiles().length]) };
}
const savedCounts = () => saved.savedView().totals;

// ── The sidebar list ─────────────────────────────────────────────────────
/** The number beside a folder. Needs you counts what the Inbox badge counts (an alarm: an agent, a review, a run, a proposal, a question); the welcome items are listed but are not alarms, so they are not in either (#11622). */
/** The goals agents proposed that wait for the Operator (a row in Needs you): the Goals folder counts them, it said 0 while one waited (#11894). */
const goalProposals = () => pendingProposals().filter(p => p.kind === 'goal');
const countOf = key => key === 'needs' ? waitingSessions().length + unreadReviewItems().length + failedUnread().length + pendingProposals().length + goalDoneRows().filter(needsUnread).length + skillCount() + operatorAsks().length + recordRows().length : key === 'tasks' ? taskRows().length : key === 'goals' ? goals.length + goalProposals().length : key === 'artifacts' ? IA.artifactCount() ?? undefined : key === 'saved' ? savedCounts().open + savedFiles().length : undefined;
/** The folders of the Inbox (#7785, the mailbox mock): one view list, a name and a count each. Needs you, Tasks and Saved open their table in the centre; */
const FOLDER_ICONS = { needs: 'notifications', tasks: 'checklist', goals: 'flag', saved: 'saved-bookmark', artifacts: 'inventory_2', activity: 'checklist',
    chats: 'chat_bubble_outline', [BOARDS_FOLDER]: 'forum', 'chats-notes': 'edit_note', 'chats-starred': 'star', 'chats-active': 'bolt', 'chats-archived': 'folder' }; // UI/UX's existing subset choices (#8866); tagged folders keep their colour dot
/** The phone drawer's Boards group (#9583, UI/UX's spec #9529): each team's board by its name, opening its messages in the Inbox. No unread count: nothing records what was read yet. A desktop's sidebar has the Board history folder only. */
let boardList = []; // { key: team key, label }
async function refreshBoards() {
    if (!isPhoneLayout()) return;
    try {
        const { fetchProjects } = await importOnce('./board_fetch.js');
        boardList = (await fetchProjects()).map(p => ({ key: String(p.project), label: teamLabel(p.project, p.board_label || '') })).filter(b => b.key).sort((a, b) => a.label.localeCompare(b.label));
    } catch { boardList = []; }
    renderInboxNav(true);
}
const BOARD_ITEM = 'board:';
const boardSection = () => (isPhoneLayout() && boardList.length ? [{ title: 'Boards', items: boardList.map(b => ({ key: BOARD_ITEM + b.key, label: b.label })) }] : []);
/** What the folder list shows as current: on a phone an open board is its own entry of the Boards group (the folder it belongs to elsewhere is Board history). */
const navCurrent = () => (isPhoneLayout() && page?.kind === BOARDS_SUB ? BOARD_ITEM + page.project : pageGroup());
const FOLDER_TIPS = { needs: 'Agents waiting for you: a question, a permission or a review', tasks: 'Tasks assigned to you', goals: 'The open goals of your teams', saved: 'Messages you saved for later', artifacts: 'Files agents shared', activity: 'What you did in Needs you' }; // one line each (#10074)
// The Needs you number is the unread ones, and when the list holds more (read files are listed, not counted: #9277) it says so as the kind pills do, "1 of 4" (#12789, the Operator: "Needs you 0" over a table of read files). The welcome items are listed and never counted (#11622): they do not make it "0 of 5" on a new install.
const needsCountSaid = () => { const unread = countOf('needs'), listed = allNeeds().filter(s => !s.welcome).length; return listed > unread ? `${unread} of ${listed}` : unread; };
const folderSections = () => (nativeInbox() ? [{ title: 'Needs attention', items: GROUPS.filter(g => g.key !== 'artifacts' || !IA.artifactsOwnerOnly()).map(g => ({ key: g.key, label: g.label, count: g.key === 'goals' || g.key === 'artifacts' ? countOf(g.key) : undefined })) }, ...CH.chatSections(), ...boardSection()] : [{ title: 'Needs attention', items: [
    { key: 'needs', label: 'Needs you', count: needsCountSaid(), alert: countOf('needs') > 0 }, { key: 'tasks', label: 'Tasks', count: countOf('tasks') },
    { key: 'goals', label: 'Goals', count: countOf('goals') },
    { key: 'saved', label: 'Saved', count: countOf('saved') }] },
    { title: 'Files', items: [{ key: 'artifacts', label: 'Artifacts', count: countOf('artifacts') }] }, { title: 'History', items: [{ key: 'activity', label: 'Activity' }] }, ...CH.chatSections(), ...boardSection()]).map(section => ({ ...section, items: section.items.map(item => ({ ...item, tip: FOLDER_TIPS[item.key], icon: FOLDER_ICONS[item.key] || (item.key.startsWith(BOARD_ITEM) ? 'forum' : undefined) || (item.key.startsWith('chats-cli-') ? `cli:${item.key.slice(10)}` : undefined) })) }));
let _navKey = null, _folders = null, _poll = 0;
/** A folder was picked: a page that is open gives way, and the folder's table opens with the keyboard at its heading. */
function pickFolder(key) {
    if (key.startsWith(BOARD_ITEM)) { openItemRoute(BOARDS_SUB, key.slice(BOARD_ITEM.length), null, key); return; } // a board of the phone drawer's Boards group: its messages, in the Inbox
    if (page) closePage(false);
    setGroup(key);
    noteFolder(key);
    openGroupTable('hub-inbox', key, { focus: true });
    const route = routeForFolder(key); if (route) note(route);
}
/** The address follows the folder (#8652): /inbox/<folder>, so a link, Back and a reload keep it. Goals, Tasks and Board history are other page families' paths (#8571, #8633) where this build has them. A folder that has no path (the route
 *  parser does not know it) leaves the address as it is; the old /chats address is replaced by the folder's, not stacked under it (Back would otherwise come back to it and rewrite it). */
function noteFolder(key) {
    if (document.body.getAttribute('data-nav-tab') !== 'hub-inbox') return;
    const path = inboxFolderPath(key), route = path ? parseRoute(path) : null;
    if (!route) return;
    const cur = currentRoute();
    if (cur && cur.view === route.view && cur.sub === route.sub && cur.folder === route.folder) return; // already on this folder's family (an item's page is under the folder's path: its own handler owns the address)
    if (cur && cur.view === 'chats' && (cur.id || cur.query)) return; // a chat's own address, or the Chats list with its search in the address (/chats?q=...): the filters are in it, so it stays
    note(route, { replace: !!cur && cur.view === 'chats' });
}
/** The folders in the sidebar. Only drawn when a count or the current folder changed (this runs for every message of the feed). */
let dragging = null; // the review row being dragged toward Saved (#11641)
/** A review row dropped on the Saved folder is saved for later, as its three dots' item does. */
function wireSaveDrop(list) {
    if (list._saveDrop) return; list._saveDrop = true;
    const target = e => e.target.closest?.('.view-list-item[data-key="saved"]');
    list.addEventListener('dragover', e => { if (dragging && target(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; target(e).classList.add('drop-over'); } });
    list.addEventListener('dragleave', e => target(e)?.classList.remove('drop-over'));
    list.addEventListener('drop', e => { const t = target(e); if (!t || !dragging) return; e.preventDefault(); t.classList.remove('drop-over'); const row = dragging; dragging = null;
        importOnce('./artifact_review.js').then(async ({ saveRow, saySaved }) => { await saveRow(row.team, row); saySaved(row.team, row); sayLive(`Saved ${markHidden(row.name, { strict: true })} for later.`); }).catch(error => sayLive(error.message)); });
}
function renderInboxNav(force = false) {
    const list = $('inbox-nav-list');
    if (!list) return;
    wireSaveDrop(list);
    if (group === 'artifacts' && nativeInbox() && IA.artifactsOwnerOnly()) setGroup('needs', { auto: true }); // the Artifacts folder on screen (or kept from last time) is gone for a grantee: Needs you, not an empty page (#11071)
    const here = navCurrent(), sections = folderSections();
    // what the tables show is part of the key too: the folder list is drawn from the counts, but the table on screen is refreshed (refreshGroupTable below) only when a row of it changed
    const needs = needsRows(), tk = taskRows(), sv = saved.savedView().shown.map(saved.savedItemFacts);
    const key = JSON.stringify([here, sections, queries.needs, queries.tasks, page && `${page.kind}:${page.project || ''}#${page.id}`,
        needs.map(s => [sessionServer(s), s.session_id, s.display_name, s.waiting_kind, s.waiting_since, teamOf(s), askOf(s)]), tk.map(t => [t.project, t.id, t.title, t.priority, t.status, t.board, t.updated_at, t.artifact_count]), sv.map(f => [f.id, f.which, f.saved, f.state]), savedFiles().map(a => a.reviewKey)]);
    if (!force && key === _navKey) return;
    _navKey = key;
    if (needsRows().some(s => s.waiting_since) && !_poll) _poll = pollEvery(() => { refreshReviews(); refreshProposals(); refreshGoals(); renderInboxNav(true); }, 30000); // "waiting 4 min" in the Needs you table moves on while the tab is open
    if (_folders && list.contains(_folders)) VL.update(_folders, { sections, current: here });
    else { _folders = VL.build({ id: 'inbox-folders', label: 'Inbox views', sections, current: here, onPick: pickFolder }); list.replaceChildren(_folders); }
    const pageList = page && $('inbox-page')?.querySelector('[data-view-list="inbox-goal-folders"], [data-view-list="inbox-item-folders"]'); // an opened item's own folder list (a phone's select) follows the counts too: it was drawn once, with the counts of that moment (#8681)
    if (pageList) VL.update(pageList, { sections, current: here });
    setHidden(document.querySelector('.sidebar-header[data-header="hub-inbox"] [data-group-toggle]'), true); // folders do not fold: the collapse-all button has nothing to fold
    syncLeadStrip(sections, here);
    refreshGroupTable('hub-inbox');
}

// The folder strip's COUNTS are not in the signature that rebuilds a phone's table (the lead's signature below): they are written into the strip where it is (syncLeadStrip), so a count that arrives does not draw the rows again (#11692).
/** The folder strip a phone's table carries on top of its rows follows the counts where it is, instead of the table being drawn again for it (#11692). */
function syncLeadStrip(sections, here) {
    const strip = $('group-table-view')?.querySelector('[data-view-list="inbox-folders-page"]');
    if (strip) VL.update(strip, { sections, current: here });
}
/** A count arrived (the Artifacts folder's): the folder list and an open item's own list follow it, and nothing else is drawn. The table on screen is not touched: renderInboxNav ends by drawing it again, and for the Artifacts folder that
 *  emptied the list and built it a second time within a few milliseconds when the count came in (#11692: a visible flash, and a click that landed between the two). The folder going away (a grantee) still takes the full draw. */
function renderFolderCounts() {
    const list = $('inbox-nav-list');
    if (!list || !_folders || !list.contains(_folders) || (group === 'artifacts' && nativeInbox() && IA.artifactsOwnerOnly())) { renderInboxNav(true); return; }
    const here = navCurrent(), sections = folderSections();
    VL.update(_folders, { sections, current: here });
    syncLeadStrip(sections, here);
    const pageList = page && $('inbox-page')?.querySelector('[data-view-list="inbox-goal-folders"], [data-view-list="inbox-item-folders"]');
    if (pageList) VL.update(pageList, { sections, current: here });
}

// ── The tables ───────────────────────────────────────────────────────────
/** Saved uses the same columns in the Inbox and dock; only its opener and table state differ. */
function savedListSpec(where = '') {
    const v = saved.savedView();
    const rows = v.shown.map(saved.savedItemFacts);
    const dock = where === 'dock-tab';
    const multi = rows.some(f => f.serverName);
    const empty = v.loading ? 'Loading saved items' : v.error ? v.error : v.filtered ? 'No saved messages match this search.' : v.scoped || (v.tab === 'done' ? 'Nothing is marked done.' : 'Nothing is saved for later.');
    const files = dock ? [] : savedFiles(); // the saved review files, listed above the messages (#11641)
    const spec = { title: 'Saved', noun: ['item', 'items'], headless: dock, chipsLabel: 'Show',
        chips: !dock ? [] : [{ action: 'inbox-saved-chip', data: { tab: 'open' }, label: 'Open', count: v.totals.open, pressed: v.tab === 'open' }, { action: 'inbox-saved-chip', data: { tab: 'done' }, label: 'Done', count: v.totals.done, pressed: v.tab === 'done' }],
        empty: { line: empty, hint: v.loading || v.error || v.filtered || v.tab === 'done' ? '' : 'Save a message from a chat or a board with its bookmark.' },
        note: [v.query ? 'The search covers every saved message, not only these.' : '', ...v.down.map(d => `${d.label || d.id} did not answer, so its saved messages are not shown.`)].filter(Boolean).join(' '), rows,
        signature: JSON.stringify([multi, rows.map(f => [f.id, f.which, f.saved, f.state, f.gone, f.done, f.serverName])]),
        node: () => DT.dataTable({ label: `Saved, ${rows.length}`, compact: true, rows, rowKey: f => f.id, state: dock ? dockSavedState : savedState, sortBar: !dock, rowName: f => f.which,
            open: (f, row) => dock ? openDockSavedSheet(f.id, row.querySelector('.dt-primary')) : openSavedPage(f.id),
            mail: f => ({ lead: { text: f.title || f.which, name: f.title || f.which }, title: f.title || f.which, medium: true, snippet: f.snip, time: f.saved, data: { id: String(f.id) }, tip: multi && f.serverName ? `${f.which} \u00b7 ${f.serverName}` : '' }), // the snippet as the name cuts it, so the words on the row are the words in its name // a phone's row (#9583): who it is from, the message, when it was saved, one line, in the Inbox and in the agent dock alike (Done is inside the item, not on every row, #9786)
            columns: [
                { key: 'message', label: 'Message', primary: true, width: 'grow', line: 1, cell: f => { // the sender (14/600), then the message in the secondary colour: a list of who said what reads at a glance; the button's name is still the whole words
                    const b = DT.primaryButton('', f.which); b.dataset.id = f.id; b.title = multi && f.serverName ? `${f.which} · ${f.serverName}` : f.which;
                    b.classList.add('dt-saved-message');
                    const lead = f.title && f.which.startsWith(`${f.title}, `) ? f.title : ''; // the button's text stays the whole words (f.which: "Agent One, The release plan"): the comma between is read by a screen reader and not drawn
                    if (lead) { const sep = DT.el('span', 'sr-only', ', '); b.append(DT.el('span', 'dt-saved-who', lead), sep, DT.el('span', 'dt-saved-text', f.which.slice(lead.length + 2))); } else b.append(DT.el('span', 'dt-saved-text', f.which));
                    return b; } }, // a narrow row drops the Computer column (#8981): its name stays one hover or one sheet away
                ...(dock ? (multi ? [{ key: 'machine', label: 'Computer', line: 0, cell: f => f.serverName || '' }] : []) : serverColumns().map(c => ({ ...c, line: 0 }))), // a folded row is one line: the message, when it was saved and its action (#8981); the machine and the state stay as columns where the table is wide
                { key: 'saved', label: 'Saved', tone: 'tertiary', align: 'end', line: 1, tiny: true, cell: f => f.saved },
                ...(rows.some(f => f.state && f.state.toLowerCase() !== v.tab) ? [{ key: 'state', label: 'State', line: 0, cell: f => (f.state ? DT.tag(f.state) : '') }] : []), // the Open and Done filter already says it: a State column that repeats it on every row is drawn only when a row's state is something else (gone)
                { key: 'action', label: 'Action', hideLabel: true, line: 1, tiny: true, cell: f => {
                    if (f.gone) return '';
                    const b = DT.el('button', 'btn btn-small dt-quiet dt-hover-action', f.done ? 'Reopen' : 'Done'); b.type = 'button'; b.setAttribute('aria-label', `${f.done ? 'Reopen, move back to Open' : 'Mark done'}: ${f.which}`); // drawn on the row's hover and keyboard focus (css); always on a touch screen
                    b.addEventListener('click', async () => { const it = saved.findSavedItem(f.id); if (!it) return; const done = !it.done_at; if (await saved.savedSetDone(it, done)) sayLive(done ? 'Marked done' : 'Moved back to Open'); });
                    return b; } },
            ] }).el };
    if (!files.length) return spec;
    return { ...spec, count: rows.length + files.length, empty: rows.length ? spec.empty : null, signature: JSON.stringify([spec.signature, files.map(a => [a.reviewKey, a.name])]), node: () => { const wrap = DT.el('div', 'saved-files-wrap'), host = DT.el('div', 'saved-files'); wrap.append(host); if (rows.length) wrap.append(DT.el('h3', 'saved-files-title', 'Saved messages'), spec.node()); importOnce('./saved_files.js').then(m => m.fillSavedFiles(host, files, { DT, reviewActions: a => hoverWrap(a, reviewActions(a, true)), openReview, shown: a => markHidden(a.name, { strict: true }), subtitleOf: a => subOf({ review: a, board_project: splitKey(a.team).name, server: splitKey(a.team).server }, true) })).catch(() => {}); return wrap; } };
}

/** A message of the agent's Saved tab, as a sheet over the dock panel (the pane the Artifacts tab uses, detail_pane.js): what the Inbox's page holds (the text, why it cannot be opened, Read the whole message) with Open (the chat) and Remove from saved in its bar. Back, the close button and Escape return to the Saved table, the focus on the row. */
let dockSheetId = '';
async function openDockSavedSheet(id, opener) {
    const it = saved.findSavedItem(id);
    if (!it) return;
    const f = saved.savedItemFacts(it);
    const { openDetailPane, closeDetailPane } = await importOnce('./detail_pane.js');
    let snippetEl = null; // the saved snippet gives way to the whole text once it has come (#7660)
    const x = f.gone ? null : savedExpandFor(it, f.which, { auto: true, onText: has => { if (snippetEl) snippetEl.hidden = has; } });
    const back = () => closeDetailPane({ restoreFocus: true });
    const cannotOpen = f.gone || f.noopen;
    const actions = [];
    if (!cannotOpen) actions.push({ label: f.open.text, primary: true, ariaLabel: f.open.name, run: () => saved.savedOpen(it) });
    if (!f.gone) actions.push({ label: f.done ? 'Reopen' : 'Done', ariaLabel: `${f.done ? 'Reopen, move back to Open' : 'Mark done'}: ${f.which}`, run: async () => { const now = saved.findSavedItem(id); if (!now) return; const done = !now.done_at; if (await saved.savedSetDone(now, done)) { sayLive(done ? 'Marked done' : 'Moved back to Open'); back(); } } }); // a phone's rows have no Done button: it is in the item (#9786)
    actions.push({ label: 'Remove from saved', ariaLabel: `Remove from saved: ${f.which}`, run: async () => { if (await saved.savedRemove(it)) { sayLive('Removed from saved'); back(); } } });
    dockSheetId = id;
    openDetailPane({
        key: `saved:${id}`, title: f.title, sub: [f.said ? `Said ${f.said}` : '', `Saved ${f.saved}`, f.state, f.serverName].filter(Boolean).join(' · '),
        host: $('agentic-saved-detail-pane'), opener, actions,
        body: doc => {
            const link = el('button', 'back-link', '\u2190 Saved'); link.type = 'button'; link.addEventListener('click', back);
            snippetEl = el('p', 'inbox-saved-snippet', f.snippet || '(no text)');
            doc.append(link, snippetEl);
            if (cannotOpen && f.why) doc.append(el('p', 'inbox-saved-why', f.why));
            if (x && !x.root.hidden) doc.append(x.region); // the whole text, read at once; a long one scrolls in the sheet
        },
        onClose: () => {
            dockSheetId = '';
            if (!opener.isConnected) $('saved-table')?.querySelector('.group-chip, .dt-primary')?.focus({ preventScroll: true }); // the row went (removed, or the table was drawn again)
        },
    });
}

/** Needs you, narrowed to one goal's rows (a goal page's "Review them", #11885): the page's own Goal filter, set to the goal's title for this view only. */
export function showNeedsForGoal(title) {
    needsFilters = NF.clean({ ...NF.EMPTY, goal: String(title || '') }); queries.needs = ''; // not saved: the person's own filters stay what they were for the next visit (#11913)
    const input = $('inbox-search'); if (input && group === 'needs') input.value = '';
    renderInboxNav(true);
}

/** The dock's Saved tab (#saved-table, saved.js render): the same table for the page's scope, drawn into the dock; the keyboard stays on the control it was on when it is still there. */
export function drawDockSaved(host) {
    const held = host.contains(document.activeElement) ? document.activeElement : null;
    const was = held && { cls: held.className, id: held.dataset.id || held.closest('tr')?.dataset.key || '', tab: held.dataset.tab || '' };
    const spec = savedListSpec('dock-tab'), html = tableMarkup(spec), signature = html + spec.signature;
    if (host.dataset.drawn !== signature) {
        const folded = !!host.querySelector('.dt-box.dt-folded');
        host.innerHTML = html;
        const slot = host.querySelector('.group-table-node');
        if (slot) { const table = spec.node(); table.classList.toggle('dt-folded', folded); slot.replaceWith(table); }
        host.dataset.drawn = signature;
    }
    if (dockSheetId && !saved.savedView().shown.some(i => saved.savedItemFacts(i).id === dockSheetId)) importOnce('./detail_pane.js').then(m => m.closeDetailPane()); // another agent's Saved is on screen, or the message left the list: its sheet goes
    if (!was) return;
    const same = [...host.querySelectorAll('.dt-primary, .dt-quiet, .group-chip')].find(e => e.className === was.cls && (e.dataset.id || e.closest('tr')?.dataset.key || '') === was.id && (e.dataset.tab || '') === was.tab);
    (same || host.querySelector('.group-chip, .dt-primary'))?.focus({ preventScroll: true }); // a removed row leaves focus on the first control

}

/** A chat of a folder opens in the chat viewer with its way back ("<- folder"): the folder is kept in state for the viewer and for the browser's Back. */
async function openChat(c) {
    if (nativeInbox() && !c.server) return; // a Hub's row names its computer: with none there is no "local" to fall back to, so nothing opens (fail closed)
    state.inboxFolder = { key: group, label: (groupMeta(group) || {}).label || 'All chats' };
    CH.chatOpened(c); renderInboxNav(true); // opened: read at its stamp, and the folders' unread numbers go down in memory, no request (#9687, #9703)
    const isGroup = c.type === 'group' || String(c.session_id || '').startsWith('board:');
    if (isGroup) { const { historyServer } = await importOnce('./history_source.js'); openItemRoute('boards', identityKey(c.server || historyServer(), c.title || String(c.session_id).replace(/^board:/, '')), null, c.session_id); return; }
    const live = (state.liveSessions || []).find(s => s.session_id === c.session_id && normServer(sessionServer(s)) === normServer(c.server || LOCAL_SERVER)); // an agent this computer has running now: its chat is the live one, with the message box (#12654); the history view is a transcript only
    if (live) { openInAgents(live); return; }
    const { setHistorySource } = await importOnce('./history_source.js');
    if (!setHistorySource(c.server || 'local')) return;
    window.selectHistorySession?.(c.session_id, null, c);
}

/** A Hub page in the centre (Needs you, Tasks, Saved for later): one iframe, its address a constant from HUB_FRAMES, never built from a URL, a hash or a message; nothing is posted to it or read from it, so the
 *  folder has no count of ours. The frame is made the first time the folder is shown and the same element is handed back on a redraw of that folder; picking another folder takes it out, and its page loads again. */
const hubFrames = new Map();
function hubFrameTable(key) {
    const meta = GROUPS.find(g => g.key === key);
    return { title: meta.label, count: null, noun: ['item', 'items'], rows: [{}], signature: `hub-frame:${key}`, node: () => {
        if (!hubFrames.has(key)) {
            const f = document.createElement('iframe');
            f.className = 'inbox-frame'; f.title = meta.label;
            f.setAttribute('referrerpolicy', 'no-referrer');
            f.setAttribute('allow', ''); // no camera, microphone, geolocation or other powerful features
            f.setAttribute('src', HUB_FRAMES[key]);
            hubFrames.set(key, f);
        }
        return hubFrames.get(key);
    } };
}

registerGroupSource('hub-inbox', {
    holdRedraw: true, // not redrawn under a held pointer (#12636): a row answered elsewhere would move the one under the finger
    signature: () => JSON.stringify([state.hub, state.servers]),
    toolbar: key => HUB_FRAMES[key] && nativeInbox() ? null : key === 'needs' ? inboxNeedsToolbar() : key === 'tasks' ? inboxTaskToolbar() : key === 'goals' ? inboxGoalsToolbar() : key === 'saved' ? inboxSavedToolbar() : key === 'activity' ? inboxActivityToolbar() : CH.CHAT_KEY.test(key) ? inboxChatsToolbar(key) : key === 'artifacts' ? IA.artifactsToolbar(() => renderFolderCounts()) : ({ search: { id: 'inbox-search', label: 'Search the Inbox' } }), // the page's toolbar line, the same shape for Needs you, Tasks and Saved (#7723)
    keys: () => GROUPS.map(g => g.key),
    redraw: () => renderInboxNav(true),
    table: key => {
        if (nativeInbox() && HUB_FRAMES[key]) return hubFrameTable(key);
        if (key === 'needs') {
            askBlockers();
            // the goal its task serves (#7302) is a column when any row has one; the goal's cell opens it on its board
            const rows = needsRows(), dirOf = s => String(s.working_directory || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
            const goalOf = s => s.goal && s.goal.id && s.goal.title;
            const goal = rows.some(goalOf);
            const total = filteredNeeds().length, hidden = allNeeds().length - total, rowsCounted = rows.filter(needsUnread).length, totalCounted = filteredNeeds().filter(needsUnread).length; // what the filters hide is said above the list, with the way to show it (#10399)
            const manyTeams = new Set(allNeeds().map(teamOf).filter(Boolean)).size > 1; // with two or more teams waiting, a one-line row names its team
            return { title: 'Needs you', noun: ['item', 'items'], rows, count: totalCounted > rowsCounted ? `${rowsCounted} of ${totalCounted}` : totalCounted, note: reviewErrors().join(' '), empty: { line: NF.isFiltered(needsFilters) ? 'Nothing that needs you matches the search and filters.' : 'Nothing needs you', hint: NF.isFiltered(needsFilters) ? undefined : answered || 'An agent that asks a question or wants permission, and a review artifact, appear here. A task assigned to you is under Tasks.', go: NF.isFiltered(needsFilters) ? undefined : { action: 'inbox-go-agents', label: 'Go to Agents' } },
                foot: needsFoot, signature: JSON.stringify([alertsOffered(), mutedWords(mutedReviewItems()), dayOldMutedFiles().map(a => a.hex), hidden, finishedUnread().length, answered || '', manyTeams, needsOverflow().map(g => [g.name, g.more.map(a => a.reviewKey)]), reviewErrors(), rows.map(blocksOf), rows.map(s => [s.operatorAsk ? [s.operatorAsk.id, s.operatorAsk.text] : 0, sessionServer(s), s.session_id, s.display_name, s.waiting_kind, s.waiting_since, waitingText(s.waiting_since), teamOf(s), askOf(s), goalOf(s) ? s.goal.id : 0, s.task ? [s.task.id, s.task.title] : 0, dirOf(s), s.review ? isRead(s.review) : 0, s.proposal ? s.proposal.state : 0])]), // the words move on with the clock: they are part of what was drawn
                node: () => { const wrap = DT.el('div', 'inbox-needs-results'); const oneLineNeeds = !rows.some(isItem); const table = DT.dataTable({ label: `Needs you, ${rows.length}`, rows, keepOrder: true, orderKey: JSON.stringify([needsFilters, queries.needs]), rowKey: s => `${sessionServer(s)}:${s.session_id}`, unread: needsUnread, ...(isPhoneLayout() ? { selectable: { contextKey: 'inbox-needs', longPress: true, iconBar: true, clearLabel: 'Cancel', canSelect: s => !!(s.review || s.operatorAsk || s.welcome || s.autorun || s.proposal || s.goalDone), actions: needsBulkActions(), onChange: keys => Toolbar.mountSelection(document.querySelector('#group-table-view .gt-toolbar'), keys.size ? table.bar : null) } } : {}), decorate: (s, tr) => { if (!needsUnread(s)) tr.classList.add('dt-read'); if (s.welcome && s.welcome.dismiss) tr.dataset.welcomeId = s.welcome.id; if (s.review && !decisionNeedsPerson(splitKey(s.review.team).server)) { tr.draggable = true; tr.addEventListener('dragstart', e => { e.dataTransfer.setData('application/x-coral-review', s.review.reviewKey); e.dataTransfer.effectAllowed = 'move'; dragging = s.review; }); tr.addEventListener('dragend', () => { dragging = null; }); } }, state: needsState, rowName: s => s.review ? `${s.review.name}${earlierWords(s.review) ? `, ${earlierWords(s.review)}` : ''}, for review, ${teamOf(s)}` : s.autorun ? `${s.autorun.name}, run failed` : s.operatorAsk ? `${s.operatorAsk.asker}, asks you` : s.welcome ? s.welcome.title : resolveSessionIdentity(s),
                    open: s => { if (s.skillReview) { openSkill(s.skillReview); return; } if (s.goalDone) { openGoalDone(s.goalDone, false, `${sessionServer(s)}:${s.session_id}`); return; } if (s.proposal) { openProposalDialog(s.proposal, 'view'); return; } if (s.review) { openReview(s.review); return; } if (s.autorun) { openRun(s.autorun); return; } if (s.operatorAsk) { openAskDialog(s.operatorAsk, undefined, askRunners); return; } if (s.unrecorded) { recordAllAgents(); return; } if (s.welcome) { runWelcome(s.welcome.id); return; } if (!s.review && !s.autorun && s.waiting_kind === 'permission') { importOnce('./inbox_agent_card.js').then(m => { if (m.canOpenCard(s)) m.openAgentCard(s); else openInAgents(s); }); return; } openInAgents(s); }, // a row that needs an answer shows the chat card, not the terminal saved last (#10141)
                    columns: [
                        { key: 'agent', label: 'Item', primary: true, width: 'grow', ...(rows.some(s => s.proposal) ? (rows.some(s => s.review || s.operatorAsk) ? { min: rows.every(isItem) ? 30 : 14, share: 3 } : { min: 14, share: 1 }) : rows.some(isItem) ? { min: 24, share: 2 } : {}), sort: true, sortValue: s => resolveSessionIdentity(s), line: 1, ...(oneLineNeeds || rows.some(s => s.review || s.operatorAsk || s.autorun) || !rows.some(s => s.proposal) || rows.some(needsDetails) ? { subtitle: s => (needsDetails(s) ? 'Waiting for details…' : s.operatorAsk ? askUnder(s.operatorAsk) : s.review ? (questionOf(s) || 'For review') : s.autorun && !oneLineNeeds ? askOf(s) : oneLineNeeds ? (askOf(s) || 'Waiting for details…') : !rows.some(x => x.proposal) ? askOf(s) : ''), subtitleTitle: s => (s.review || s.operatorAsk ? subOf(s, true) : oneLineNeeds || !rows.some(x => x.proposal) ? askOf(s) : '') } : {}), // a permission agent's "Wants to run: ..." starts its own preview line where no proposal has the What was asked column (the Operator: no Waiting for column, #12649) // a list of agents: the ask is the row's one second line, under the name (UI/UX: the row's purpose is to decide from the list); a file for review says who uploaded it there, and its team when two or more teams wait (#11456)
                            cell: s => { if (s.operatorAsk) { const name = DT.el('span', 'inbox-review-name inbox-ask-name', askLine(s.operatorAsk) || markHidden(s.operatorAsk.asker, { strict: true })); const wrap = DT.el('span', 'inbox-review-item'); wrap.append(agentLink(markHidden(s.operatorAsk.asker, { strict: true }).trim() || 'an agent', { board: s.operatorAsk.board, cls: 'inbox-review-from' }), name); const about = askSubjectWords(s.operatorAsk); if (about) { const m = DT.el('span', 'inbox-review-earlier', about); m.title = askSubjects(s.operatorAsk).map(x => `${x.kind === 'goal' ? 'Goal' : 'Task'} #${x.id}${x.title ? `: ${x.title}` : ''}`).join('\n') + `\n(named by ${markHidden(s.operatorAsk.asker, { strict: true })})`; wrap.append(m); } return wrap; } // a question to the Operator reads like a review row: its first line, then who asked and their team
                             if (s.skillReview) { const line = skillLine(s.skillReview), name = DT.el('span', 'inbox-review-name', line); DT.tipIf(name, line, () => name.scrollWidth > name.clientWidth); return name; } if (s.goalDone) { const line = goalDoneLine(s.goalDone), name = DT.el('span', 'inbox-review-name', line); DT.tipIf(name, line, () => name.scrollWidth > name.clientWidth); if (!(s.goalDone.new_comments > 0)) return name; const lead = DT.el('span', 'inbox-review-item'); lead.append(name, newCommentsTag()); return lead; /* agents replied in the Operator's thread on this goal (#12073) */ } if (s.welcome) { const name = DT.el('span', 'inbox-review-name inbox-welcome-name', s.welcome.title); DT.tipIf(name, s.welcome.title, () => name.scrollWidth > name.clientWidth); if (s.welcome.optional) name.append(DT.tag('optional')); return name; } if (s.unrecorded) { const name = DT.el('span', 'inbox-review-name', s.display_name); DT.tipIf(name, s.display_name, () => name.scrollWidth > name.clientWidth); return name; } if (s.proposal) { const name = DT.el('span', 'inbox-review-name', markedText(s.proposal.title)); DT.tipIf(name, markedText(s.proposal.title), () => name.scrollWidth > name.clientWidth); if (!isPhoneLayout()) return name; const lead = DT.el('span', 'inbox-review-item'); lead.append(DT.el('span', 'inbox-review-from', markedText(s.proposal.proposer)), name); return lead; /* a phone: who proposed it leads the line, as the sender of a file does */ } if (s.autorun) { const name = DT.el('span', 'inbox-review-name', s.autorun.name); DT.tipIf(name, s.autorun.name, () => name.scrollWidth > name.clientWidth); return name; } if (s.review) { const name = DT.primaryButton(markTitle(s.review.name), `Open ${markTitle(s.review.name)}`); name.classList.add('inbox-review-name'); name.dataset.reviewArtifact = s.review.id; const wrap = DT.el('span', 'inbox-review-item'), ver = DT.el('span', 'inbox-review-version', versionOf(s.review) > 1 ? ` · version ${versionOf(s.review)}` : ''); ver.hidden = !(versionOf(s.review) > 1); wrap.append(agentLink(markHidden(s.review.produced_by, { strict: true }).trim() || 'sender unknown', { board: s.review.team, cls: 'inbox-review-from' }), name, ver, ...(earlierWords(s.review) ? [DT.el('span', 'inbox-review-earlier', earlierWords(s.review))] : []), ...(s.review.new_comments > 0 ? [newCommentsTag()] : []), DT.el('span', 'sr-only', isRead(s.review) ? ', read' : ', unread')); return wrap; } const w = DT.personButton(resolveSessionIdentity(s), `Open ${resolveSessionIdentity(s)}`); Object.assign(w.querySelector('.dt-primary').dataset, { name: s.name, agentType: s.agent_type, sessionId: s.session_id, server: sessionServer(s) }); return w; } },
                        ...(rows.some(s => s.proposal) && !oneLineNeeds ? [{ key: 'asks', label: rows.some(x => x.proposal) ? 'What was asked' : 'Waiting for', ...(rows.some(x => x.proposal) ? (rows.some(s => s.review || s.operatorAsk) ? { lineGrow: true, min: 18, share: 1 } : { lineGrow: true, min: 22, share: 4 }) : { width: 'content', max: 20, drop: 2 }), line: 2, cell: s => {
                            if (s.proposal) { const pr = s.proposal, wrap = DT.el('span', 'inbox-proposal-what'); wrap.append(DT.el('span', 'inbox-proposal-line', `${isPhoneLayout() ? 'Proposes' : `${markedText(pr.proposer)} proposes`} a ${pr.kind === 'goal' ? 'goal' : 'task'}`)); const snip = proposalSnippet(pr); if (snip) wrap.append(DT.el('span', 'inbox-proposal-body', snip)); if (carriesInstructions(pr)) wrap.append(DT.tag('Carries instructions')); wrap.title = markedText(pr.title); return wrap; } // the proposer's name and the proposal's words are text: the row says what is asked
                            if (s.review || s.operatorAsk || s.autorun) return ''; if (s.unrecorded || s.welcome || s.goalDone || s.skillReview) { const why = DT.el('span', null, askOf(s)); why.title = askOf(s); return why; } // the whole reason is the tooltip: the line is one
                            if (!s.review) { if (s.operatorAsk) return ''; const ask = askOf(s); if (!ask) return ''; const why = DT.el('span', null, ask); why.title = ask; return why; } // the whole ask is the tooltip: the row is one line
                            const metadata = DT.el('span', 'inbox-review-metadata'); metadata.append(fromNode(s), ...(questionOf(s) ? [DT.el('span', 'inbox-review-question', questionOf(s))] : []), DT.el('span', null, 'For review'), DT.el('span', 'inbox-review-team', teamOf(s))); // on a phone the uploader leads this line (the line under the name is cut beside the buttons); elsewhere it is the one under the name (#11456)
                            if (s.task) { const t = DT.link(s.task.title || `Task ${s.task.id}`, () => openItemRoute('tasks', s.review.team, String(s.task.id), `${s.review.team}#${s.task.id}`)); t.classList.add('inbox-review-task'); t.setAttribute('aria-label', `Task: ${s.task.title || s.task.id}`); t.dataset.taskLink = String(s.task.id); t.title = `Task: ${s.task.title || `#${s.task.id}`}`; metadata.append(t); } // the task a review is for opens in the Inbox, in place (#8917): with the item's own words, not under the goal where it read as a second goal (#9060)
                            return metadata;
                        } }] : []), // no row has a question: no empty column
                        ...(rows.some(s => s.agent_type) ? [{ key: 'cli', label: 'CLI', ...(oneLineNeeds ? { width: '6rem', dropAt: 36 } : { drop: 7 }), sort: true, sortValue: s => providerName(s.agent_type) || '', line: 2, cell: s => (s.agent_type ? DT.tag(providerName(s.agent_type)) : '') }] : []),
                        ...(rows.some(dirOf) ? [{ key: 'folder', label: 'Folder', ...(oneLineNeeds ? { width: '10rem', dropAt: rows.some(blocksOf) ? 62 : 52 } : { drop: 5 }), sort: true, sortValue: s => dirOf(s) || '', line: 0, cell: s => dirOf(s) || '' }] : []), // the folder an agent works in tells two of one name apart (#7122)
                        ...serverColumns().map(c => (oneLineNeeds ? { ...c, width: '8rem', dropAt: 52 } : c)),
                        ...(rows.every(s => s.autorun || s.unrecorded || s.welcome) ? [] : [{ key: 'team', label: 'Team', ...(oneLineNeeds ? { width: '13rem', dropAt: 36 } : { max: 26, drop: 1 }), sort: true, sortValue: s => teamOf(s), line: 0, cell: s => ((s.review || s.autorun) && !oneLineNeeds ? '' : teamOf(s)) }]), // a run belongs to no team: with only runs there is no Team column
                        ...(goal || rows.some(s => s.review) ? [{ key: 'goal', label: 'Goal', ...(oneLineNeeds ? { width: '10rem', dropAt: 36 } : { min: 16, share: 1, drop: 3 }), sort: true, sortValue: s => (goalOf(s) ? s.goal.title : '\uffff'), line: rows.some(isItem) ? 2 : 0, cell: s => {
                            // a review's goal and task come from its artifact's roll-up (#8579); they open in the Inbox, in place; "No goal" when it serves none
                            if (s.review && !oneLineNeeds) return ''; // the goal and the task are in the opened file and the filters (#11719)
                            if (!s.review) { if (!goalOf(s)) return ''; const l = DT.link(s.goal.title, () => { const team = goalTeamKey(s), id = Number(s.goal.id); if (team && id) go({ view: 'inbox-goals', sub: 'goals', id: team, item: id }); }); l.setAttribute('aria-label', `Goal: ${s.goal.title}`); return l; }
                            const cell = DT.el('span', 'inbox-review-goal');
                            if (goalOf(s)) { const l = DT.link(s.goal.title, () => go({ ...folderRoute, id: s.review.team, item: String(s.goal.id) })); l.setAttribute('aria-label', `Goal: ${s.goal.title}`); l.dataset.goalLink = String(s.goal.id); cell.append(l); } else cell.append(DT.el('span', 'inbox-review-nogoal', NO_GOAL));
                            // one line, one goal (#9060): the task is not a second link under the goal (a task named like its goal read as two goals): it is in the tooltip, and the review's preview has it as a fact
                            cell.title = [goalOf(s) ? `Goal: ${s.goal.title}` : NO_GOAL, s.task ? `Task: ${s.task.title || `#${s.task.id}`}` : ''].filter(Boolean).join(' \u00b7 ');
                            return cell;
                        } }] : []),
                        ...(rows.some(blocksOf) ? [{ key: 'blocks', label: 'Blocks', ...(oneLineNeeds ? { width: '9rem', dropAt: 52 } : { width: 'content', max: 30, drop: 4 }), line: 2, cell: s => { const p = blocksOf(s); if (!p) return ''; const e = DT.el('span', 'inbox-blocks', oneLineNeeds ? blocksShortOf(s) : p); e.title = p; return e; } }] : []), // a list of agents is one line a row: the short form fits its 9 rem, the whole sentence is the tooltip // what waits on the row (#11442)
                        { key: 'waiting', label: 'Waiting', ...(oneLineNeeds ? { width: '9rem', dropAt: 36 } : { min: rows.some(isItem) ? 12 : 18 }), tone: 'tertiary', align: 'end', sort: true, sortValue: s => s.waiting_since || '', firstDir: 'desc', line: 1, cell: s => (hoverRows() && rows.some(isItem) ? '' : waitingText(s.waiting_since) || '') },
                        { key: 'review', label: 'Actions', fixed: true, align: 'end', width: rows.some(s => s.proposal) ? '15rem' : rows.some(s => s.review) ? '15rem' : '13.5rem', line: 1, cell: s => (!isItem(s) && s.agent_type && !s.review && !s.autorun ? answerCell(s) : s.welcome ? welcomeActions(s.welcome) : hoverWrap(s, s.proposal ? proposalActions(s.proposal) : s.skillReview ? skillActions(s.skillReview) : s.goalDone ? goalDoneActions(s.goalDone) : s.review ? reviewActions(s.review) : s.autorun ? runActions(s.autorun) : s.operatorAsk ? askActions(s.operatorAsk) : s.unrecorded ? unrecordedActions() : '')) },
                    ], ...(oneLineNeeds ? { oneLine: true, resize: true, sortBar: false } : {}), ...(oneLineNeeds ? { mail: s => ({ lead: { text: needsName(s), name: needsName(s) }, title: needsName(s), medium: true, starred: !!(s.review && s.review.starred), team: teamOf(s), teamAlways: multipleServers() || manyTeams, nameTeam: true, snippetTip: true, snippet: [blocksShortOf(s), askOf(s) || sessionStateInfo(s).label].filter(Boolean).join(' \u00b7 '), snippetTitle: [blocksOf(s), askOf(s) || sessionStateInfo(s).label].filter(Boolean).join(' \u00b7 '), state: askOf(s) || sessionStateInfo(s).label, time: DT.shortTime(s.waiting_since), unread: true, mark: 'attention', answers: answerCell(s, { dismiss: false }), actions: rowActions(s) }) } : {}) }); // a phone's row is the mail row: the agent, then the ask on a second line, amber and bold (every row of Needs you is unanswered); a list with a review or a run keeps its own actions. One line a row (Goal #79) for a list of agents: the ask is the row's tooltip, a narrow list drops it, then the team, the folder and the CLI; a list with a review item or a failed run keeps its own folded rows
                    wrap.append(table.el); needsTable = table;
                    if (isPhoneLayout()) { const bar = document.querySelector('#group-table-view .gt-toolbar'); Toolbar.mountSelection(bar, needsState.selected.size ? table.bar : null); bar?.querySelectorAll('.dt-select-toggle').forEach(b => b.remove()); } // the bar takes the toolbar's line while rows are selected; no Select button: the long press is the way in
                    if (rows.some(r => r.welcome)) { const hide = DT.el('button', 'btn btn-quiet btn-small inbox-welcome-hide', 'Hide all welcome items'); hide.type = 'button'; hide.addEventListener('click', () => { hideAllWelcome(); sayLive('The welcome items are hidden.'); }); wrap.append(hide); } // one quiet way out (#11443)
                    if (hidden > 0) {
                        const only = needsFilters.kind && !needsFilters.q && !needsFilters.team && !needsFilters.agent && !needsFilters.goal && !needsFilters.longer && !needsFilters.server;
                        const p = DT.el('p', 'goals-note inbox-filter-hidden', `${hidden} hidden by the ${only ? `${NF.KIND_LABEL[needsFilters.kind] || needsFilters.kind} filter` : 'filters'}. `);
                        p.append(DT.link('Show all', () => { needsFilters = NF.clean({ ...NF.EMPTY }); NF.saveFilters(needsFilters); queries.needs = ''; const input = $('inbox-search'); if (input && group === 'needs') input.value = ''; renderInboxNav(true); }));
                        wrap.prepend(p);
                    }
                    for (const g of needsOverflow()) {
                        const p = DT.el('p', 'inbox-review-more', `${g.name}: ${g.more.length} more for review. `);
                        for (const team of new Set(g.more.map(a => a.team))) p.append(DT.link(`Open ${keyLabel(team)} artifacts`, () => go(keyRoute('team', team, 'artifacts'))));
                        wrap.append(p);
                    }
                    const finished = finishedUnread().length;
                    if (finished > 0) { // a run that passed is not something that needs the person, so it is a line under the list, not a row (#10515)
                        const p = DT.el('p', 'goals-note inbox-runs-finished', `${finished} ${finished === 1 ? 'run' : 'runs'} finished since you looked. `);
                        p.append(DT.link('See them', () => go({ view: 'automations', folder: 'recent' })));
                        wrap.append(p);
                    }
                    if (rows.some(r => (r.welcome && r.welcome.dismiss) || r.review || (r.operatorAsk && r.operatorAsk.kind === 'ask') || r.autorun) && (isPhoneLayout() || matchMedia('(pointer: coarse)').matches)) importOnce('./welcome_swipe.js').then(m => m.attachWelcomeSwipe(wrap)).catch(() => {}); // a touch screen, or a phone-sized window whatever its pointer says (#11765), swipes a row away (#11542); lazy
                    return wrap; } };
        }
        if (key === 'tasks') {
            const rows = taskRows();
            return { title: 'Tasks', noun: ['task', 'tasks'], rows, empty: { line: queries.tasks || TF.isFiltered(taskFilters) || taskState !== 'all' ? 'No task matches the filters.' : 'No tasks assigned to you.', hint: queries.tasks || TF.isFiltered(taskFilters) || taskState !== 'all' ? undefined : "The tasks of your agents are in each team's Tasks tab." },
                signature: JSON.stringify([rows.map(t => [t.project, t.id, t.title, t.priority, t.status, t.board, t.updated_at, t.artifact_count, IR.isUnread('task', `${t.project}#${t.id}`, t.updated_at || t.created_at)])]), // the read state is part of what is drawn (#9687)
                node: () => {
                    const row = document.querySelector('#group-table-view .gt-toolbar');
                    const t = TV.tasksTable('mine', rows, { tweak: columns => columns.flatMap(c => c.key === 'team' ? [...serverColumns(), c] : [c]), ctx: { teamOf: t => teamLabel(t.project) }, rowKey: t => `${t.project}#${t.id}`, // only my tasks: no who; the Team column because the group spans teams
                        open: t => { IR.markRead('task', `${t.project}#${t.id}`, t.updated_at || t.created_at); openItemRoute('tasks', t.project, t.id, `${t.project}#${t.id}`); }, unread: t => IR.isUnread('task', `${t.project}#${t.id}`, t.updated_at || t.created_at), state: inboxTasksState, mail: t => ({ unread: IR.isUnread('task', `${t.project}#${t.id}`, t.updated_at || t.created_at), lead: { icon: TASK_GLYPH[stateOf(t)] || 'pending', square: true, name: stateOf(t) }, title: t.title, team: teamLabel(t.project), snippet: stateOf(t), state: stateOf(t), time: DT.shortTime(t.updated_at || t.created_at), data: { taskId: String(t.id) } }),
                        selectable: { contextKey: 'inbox-tasks', actions: TB.inboxTaskActions(() => { inboxTasksState.selected.clear(); refreshTasks(); }), onChange: keys => row && Toolbar.mountSelection(row, keys.size ? t.bar : null) } }); // the bar takes the toolbar's line while tasks are selected
                    if (row) { Toolbar.mountSelection(row, inboxTasksState.selected.size ? t.bar : null); row.querySelectorAll('.dt-select-toggle').forEach(b => b.remove()); if (isPhoneLayout()) row.append(t.selectButton); }
                    return t.el;
                } };
        }
        if (CH.CHAT_KEY.test(key)) {
            return CH.chatsSpec(key, { selection: bar => Toolbar.mountSelection($('group-table-view')?.querySelector('.gt-toolbar'), bar), query: chatFiltersOf(key).q, params: CF.toParams(key, chatFiltersOf(key)), server: chatFiltersOf(key).server, redraw: () => refreshGroupTable('hub-inbox'), nav: () => renderInboxNav(true), open: openChat,
                after: () => { CH.loadChatCounts(() => renderInboxNav(true)); refreshGroupTable('hub-inbox'); } });
        }
        if (key === 'goals') {
            const rows = goalRows();
            const waitingGoals = goalProposals().length, waitingNote = waitingGoals ? `${waitingGoals} goal${waitingGoals === 1 ? '' : 's'} an agent proposed ${waitingGoals === 1 ? 'is' : 'are'} waiting for your approval in Needs you.` : '';
            return { title: 'Goals', noun: ['goal', 'goals'], rows, ...(waitingNote ? { note: waitingNote } : {}), empty: { line: GF.isFiltered(goalFilters) ? 'No goal matches the search and filters.' : 'No open goals.', hint: waitingNote || (GF.isFiltered(goalFilters) ? undefined : "A team's Goals tab has New goal; an Orchestrator can propose one too.") },
                signature: JSON.stringify(rows.map(g => [g.board_id, g.id, g.title, g.outcome, g.state, g.updated_at, g.rollup])),
                node: () => { const phone = isPhoneLayout(), mountBar = () => { const bar = document.querySelector('#group-table-view .gt-toolbar'); if (bar) { Toolbar.mountSelection(bar, goalsState.selected.size ? table.bar : null); bar.querySelectorAll('.dt-select-toggle').forEach(b => b.remove()); } }; const table = DT.dataTable({ label: `Goals, ${rows.length}`, rows, rowKey: goalKey, state: goalsState, rowName: g => g.title,
                    ...(phone ? { selectable: { contextKey: 'inbox-goals', longPress: true, iconBar: true, clearLabel: 'Cancel', canSelect: g => ['proposed', 'active', 'blocked'].includes(String(g.state || '').toLowerCase()), actions: closeGoalsActions(), onChange: () => mountBar() } } : {}), // a phone: a long press selects, as in Needs you (#12230)
                    open: g => {
                        quietFocus($('inbox-view')); // same pointer-only heading focus rule as the team page
                        goalOpener = { team: g.board_id, id: g.id };
                        goalScroll = $('group-table-view')?.scrollTop || 0;
                        note(folderRoute);
                        go({ ...folderRoute, id: g.board_id, item: g.id });
                    },
                    oneLine: true, resize: true, sortBar: false,
                    mail: g => ({ lead: { icon: 'flag', square: true, name: g.state }, title: g.title, team: goalTeam(g), ask: [g.new_comments > 0 ? 'New comments' : '', g.outcome || ''].filter(Boolean).join(' \u00b7 '), state: GW.stateWord(g), time: `${GW.stateWord(g)}${GW.allTasksOf(g.rollup) ? ` \u00b7 ${(g.rollup || {}).done || 0}/${GW.allTasksOf(g.rollup)}` : ''}` }), // a phone's row (#9583): a flag, the goal, its outcome, when it moved
                    columns: GC.goalColumns({ teamOf: goalTeam }, ['state', 'goal', 'team', 'progress', 'updated']).flatMap(c => c.key === 'team' ? [...serverColumns().map(x => ({ ...x, width: '8rem', dropAt: 52 })), c] : [c]) }); if (phone) setTimeout(mountBar, 0); return table.el; } };
        }
        if (key === 'artifacts') return IA.artifactsSpec();
        if (key === 'activity') return AC.spec(activityFilters, { file: r => importOnce('./artifact_viewer.js').then(m => m.openArtifactViewer(r.version, { filename: r.title || 'file', board: r.team })), goal: r => go({ ...folderRoute, id: r.team, item: Number(r.item_id) }), question: r => go(keyRoute('team', r.team, 'messages', Number(r.item_id))) });
        if (key === 'saved') return savedListSpec();
        return null;
    },
    lead: () => { const here = navCurrent(), sections = folderSections(); return { signature: JSON.stringify([here, sections.map(sec => [sec.title, sec.items.map(i => i.key)])]), node: () => VL.build({ id: 'inbox-folders-page', label: 'Inbox views', sections, current: here, onPick: pickFolder, drawer: true, tabs: true }) }; }, // a phone: the folders are one select on top of the table
    isEmpty: () => false, // the tab opens its group's table itself (showInbox)
    showList: () => { closePage(false); window.switchNavTab?.('hub-inbox'); },
    empty: () => { closePage(false); window.switchNavTab?.('hub-inbox'); },
});

/** Which group is on screen: the search box is named for it and holds its text, and Display options (Saved's Filters and Sort) is there for Saved only. */
function setGroup(key, { auto = false } = {}) {
    if (!groupMeta(key)) key = 'needs';
    const was = group;
    group = key;
    if (key === 'activity' && was !== 'activity') AC.refresh(() => renderInboxNav(true)); // the record is read when its folder is picked (#12070)
    if (!auto) { _autoFrom = ''; browserLocal.set(GROUP_KEY, key); } // a folder the person chose is the remembered one; Needs you opened for them (auto) is not (#10212)
    const input = $('inbox-search'), g = groupMeta(key);
    if (input) {
        const text = key === 'saved' ? (saved.savedView().query || queries.saved) : (queries[key] || '');
        if (input.placeholder !== (g.short || g.search)) input.placeholder = g.short || g.search;
        if (input.getAttribute('aria-label') !== g.search) input.setAttribute('aria-label', g.search); // the name stays whole whatever the placeholder says (a placeholder as short as the box's default no longer skips it)
        if (input.value !== text) input.value = text;
        const hubPage = nativeInbox() && !!HUB_FRAMES[key]; input.disabled = hubPage; setHidden(input.closest('.sidebar-search'), hubPage || !!g); importOnce('./phone_bar.js').then(m => m.repaintPhoneBarSearch()); // a tab with its own search box (a Hub page, and each of the Inbox's own tabs) has one search: this box is not shown above it, and the phone's top bar drops its field (#11838, #11859)
    }
    const btn = document.querySelector('.sidebar-pane[data-pane="hub-inbox"] [data-display-button]');
    if (btn) { setHidden(btn, key !== 'saved'); syncDisplayPanels(); }
    const rail = $('sidebar-rail-search');
    if (rail && document.body.getAttribute('data-nav-tab') === 'hub-inbox') { rail.title = g.search; rail.setAttribute('aria-label', g.search); }
    if (was !== key) renderInboxNav(true);
}

// The table on screen names the group (its data-group), a page names its own: the search and Display options follow.
onViewShown(id => {
    if (itemMount && id !== 'inbox-view') closePage(false); // release the shared Board before another page takes it
    if (document.body.getAttribute('data-nav-tab') !== 'hub-inbox') return;
    if (id === 'group-table-view') {
        const g = ($('group-table-view')?.dataset.group || '').split(':');
        if (g[0] === 'hub-inbox' && g[1] !== group) setGroup(g[1]); // a table that is already the group on screen sets nothing again (it would store Needs you, opened for the person, as the remembered folder, #10212)
        if (page) { const wasGoal = page.kind === 'goal'; goalMount?.dispose(); goalMount = null; page = null; if (wasGoal) refreshGoals(); /* a goal closed on its page leaves Needs you */ $('inbox-page').hidden = true; $('inbox-view')?.removeAttribute('data-phone-item'); renderInboxNav(true); }
    }
});

/** Words searched from elsewhere (the sidebar's Search all chats, #10263): they go into the group's box and the search runs as if typed. */
export function setInboxSearch(value) {
    const input = $('inbox-search');
    if (input) input.value = String(value || '');
    filterInbox(value);
}

/** The search box was typed in: it narrows the group on screen (Saved's is the server's search). */
export function filterInbox(value) {
    const text = String(value || '').trim();
    if (nativeInbox() && HUB_FRAMES[group]) return; // a Hub page has its own search
    if (group === 'saved') { queries.saved = text; saved.setSavedQuery(text); return; }
    if (group === 'artifacts') { IA.setArtifactSearch(text); return; } // the folder's own search box shows the same text
    queries[group] = CH.CHAT_KEY.test(group) || group === 'tasks' ? text : text.toLowerCase();
    if (group === 'tasks') { inboxTasksState.selected.clear(); taskFilters = { ...taskFilters, q: text }; } // a chat search goes to the server as typed
    if (CH.CHAT_KEY.test(group)) { chatFilters.set(group, { ...chatFiltersOf(group), q: text }); if (nativeInbox()) CH.resetChatLists(group); } // the sidebar's box and the page's share the one search (#8603); on a Hub it is sent on Enter, one read of each online computer every time
    if (group === 'needs') { needsFilters = { ...needsFilters, q: text }; NF.saveFilters(needsFilters); } // the sidebar's box and the page's share the one search (#8604)
    if (group === 'activity') { activityFilters = { ...activityFilters, q: text }; AF.saveFilters(activityFilters); } // the sidebar's box and the page's share the one search (#12070)
    if (group === 'goals') { goalFilters = { ...goalFilters, q: text }; GF.saveFilters(goalFilters); } // the sidebar's box and the page's share the one search (#8596)
    renderInboxNav(true);
}

// ── Saved message page ──────────────────────
function openPageShell(kindLabel, groupKey) {
    const host = $('inbox-page');
    host.hidden = false;
    host.dataset.saved = '';
    showView('inbox-view'); // a group's table may be on screen: the item is the page now
    $('inbox-local').hidden = false;
    if (isPhoneLayout()) $('inbox-view')?.setAttribute('data-phone-item', '');
    host.replaceChildren();
    const back = el('button', 'back-link', `\u2190 ${kindLabel}`); // the link back to the group's table (the shared one, sidebar_groups.js)
    back.type = 'button'; back.setAttribute('data-on-click', 'inbox-back'); back.dataset.kind = 'hub-inbox'; back.dataset.group = groupKey; // the way back puts the focus on the row it came from
    const phoneBack = el('button', 'back-link inbox-phone-back'); phoneBack.append(el('span', null, `\u2190 ${kindLabel}`)); /* the words in a span: a phone's bar draws the arrow and hides them (layout.css) */ // a phone: back to the folder's table, which has the folders' select on top
    phoneBack.type = 'button'; phoneBack.setAttribute('data-on-click', 'inbox-phone-back');
    host.append(back, phoneBack);
    return host;
}

let openMore = null;
function closeMore(focus) { const m = openMore; openMore = null; if (!m) return; m.menu.hidden = true; m.toggle.setAttribute('aria-expanded', 'false'); if (focus) m.toggle.focus(); }
document.addEventListener('click', e => { if (openMore && !openMore.wrap.contains(e.target)) closeMore(false); });

function openSavedPage(id) {
    const it = saved.findSavedItem(id);
    if (!it) return;
    const f = saved.savedItemFacts(it);
    page = { kind: 'saved', id };
    const host = openPageShell('Saved', 'saved');
    host.dataset.saved = id;
    host.append(el('h2', 'wf-item-title', f.title));
    host.append(el('p', 'item-meta', [f.said ? `Said ${f.said}` : '', `Saved ${f.saved}`, f.state, f.serverName].filter(Boolean).join(' · ')));
    const snippetEl = el('p', 'inbox-saved-snippet', f.snippet || '(no text)'); // the snippet gives way to the whole text once it has come (#7660)
    host.append(snippetEl);
    if ((f.gone || f.noopen) && f.why) host.append(Object.assign(el('p', 'inbox-saved-why', f.why), {}));
    const bar = el('div', 'item-bar inbox-saved-actions');
    const x = f.gone ? null : savedExpandFor(it, f.which, { auto: true, onText: has => { snippetEl.hidden = has; } }); // the shared component, in its read-at-once mode: the whole text is in the page, no button
    if (x && !x.root.hidden) host.append(x.region);
    const wrap = el('div', 'wf-more'), toggle = el('button', 'btn btn-small', 'More'), menu = el('div', 'menu wf-more-menu'), rm = el('button', 'menu-item menu-item-danger', 'Remove from saved');
    toggle.type = 'button'; toggle.setAttribute('aria-haspopup', 'menu'); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-label', `More for ${f.which}`);
    menu.hidden = true; menu.id = 'inbox-saved-more'; menu.setAttribute('role', 'menu'); toggle.setAttribute('aria-controls', menu.id); rm.setAttribute('role', 'menuitem'); rm.type = 'button'; rm.setAttribute('aria-label', `Remove from saved: ${f.which}`);
    const openMenu = () => { closeMore(false); openMore = { wrap, menu, toggle }; menu.hidden = false; toggle.setAttribute('aria-expanded', 'true'); keepMenuOnScreen(menu, toggle); rm.focus(); };
    toggle.addEventListener('click', () => { if (openMore && openMore.wrap === wrap) closeMore(true); else openMenu(); });
    wrap.addEventListener('keydown', e => {
        const isOpen = !!openMore && openMore.wrap === wrap;
        if (e.key === 'Escape' && isOpen) { e.preventDefault(); e.stopPropagation(); closeMore(true); }
        else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target === toggle) { e.preventDefault(); if (!isOpen) openMenu(); }
        else if (isOpen && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && e.target === rm) e.preventDefault(); // one item: the arrows stay on it
    });
    wrap.addEventListener('focusout', e => { if (openMore && openMore.wrap === wrap && !wrap.contains(e.relatedTarget)) closeMore(false); }); // Tab out of the menu closes it
    rm.addEventListener('click', async () => { closeMore(false); if (await saved.savedRemove(it)) { sayLive('Removed from saved'); closePage(true); } });
    menu.append(rm); wrap.append(toggle, menu); bar.append(wrap);
    const open = el('button', 'btn btn-small btn-primary', f.open.text);
    open.type = 'button'; open.setAttribute('aria-label', f.open.name);
    if (f.gone || f.noopen) { open.disabled = true; open.title = f.why; } else open.addEventListener('click', () => saved.savedOpen(it));
    bar.append(open);
    host.append(bar);
    setGroup('saved');
    focusTitle(host);
}

/** A page was opened: the keyboard and a screen reader start at its heading, not on the body. */
function focusTitle(host) { foldWayBack(host, '.inbox-phone-back', '.wf-item-title'); const h = host.querySelector('.wf-item-title'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } }

/** Back from a page: the focus goes to the row it came from in the table (a phone's list is that table too), else to the table's title. */
function focusCameFrom(was) {
    if (!was) return;
    const root = $('group-table-view');
    const id = CSS.escape(String(was.id));
    const row = root && root.querySelector(`.dt-primary[data-id="${id}"]`);
    if (row) row.focus({ preventScroll: true }); else $('group-table-title')?.focus({ preventScroll: true });
}

function sayLive(text) { const live = $('inbox-live'); if (live) { const s = document.createElement('span'); s.textContent = text; live.replaceChildren(s); } }

/** Leave a page for its group's table (a phone's table has the folders' select on top). */
function closePage(openTable = true, focusBack = false) {
    const was = page, g = pageGroup();
    goalMount?.dispose(); goalMount = null;
    itemMount?.dispose(); itemMount = null;
    page = null;
    const host = $('inbox-page');
    if (host) { host.hidden = true; host.replaceChildren(); host.dataset.saved = ''; host.classList.remove('inbox-goal-page', 'inbox-item-page'); }
    $('inbox-view')?.removeAttribute('data-phone-item');
    renderInboxNav(true);
    if (openTable) openGroupTable('hub-inbox', g);
    if (focusBack) focusCameFrom(was);
}

// ── The tab ──────────────────────────────────────────────────────────────
let _mounted = false;
let _wasShown = false; // the Inbox tab is on screen: cleared when another tab is (below), so the next show is a reopen
let _asked = false; // a folder was named for the next show (rememberGroup): the reopen rule does not move it to Needs you
let _autoFrom = ''; // the folder that was open before Needs you was opened for the person (#10205): it is the remembered one, and comes back when nothing waits again
/** Called by switchNavTab('hub-inbox') (where the dashboard builds its own Inbox): the lists are read again and the group last on screen opens as a table (a phone shows the list). */
export async function showInbox({ folder = '', quiet = false } = {}) {
    let auto = false; // Needs you was chosen for the person: it is not stored as the remembered folder
    if (!_mounted) {
        _mounted = true;
        new MutationObserver(() => { if (document.body.getAttribute('data-nav-tab') !== 'hub-inbox') { _wasShown = false; needsOrder = null; needsState.shown = null; if (needsFilters.kind) { needsFilters = { ...needsFilters, kind: '' }; NF.saveFilters(needsFilters); } } }).observe(document.body, { attributes: true, attributeFilter: ['data-nav-tab'] });
        $('inbox-view').addEventListener('click', () => quietFocus($('inbox-view')), true);
        if (nativeInbox()) $('inbox-search')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (e.repeat) return; /* a held Enter is one search */ filterInbox(e.target.value); } }); // a chat search runs when it is asked for, not on each key (coral-hub's rate condition)
        onInboxHooks({ needs: () => { if (!$('inbox-local')?.hidden) renderInboxNav(); }, counts: () => { if (!$('inbox-local')?.hidden) renderInboxNav(); } });
        saved.onSavedRender(() => { if (!$('inbox-local')?.hidden) renderInboxNav(true); });
        saved.mountInboxSavedBar($('inbox-saved-bar'));
    }
    $('inbox-local').hidden = false;
    if (folder && groupMeta(folder)) { closePage(false); page = null; $('inbox-page') && ($('inbox-page').hidden = true); group = folder; } // a link to a folder: the folder, not the page that was open
    else if (_asked) _autoFrom = ''; // the folder the person asked for stays
    else if (!_wasShown && !page && !nativeInbox()) { // a reopen: with something waiting for the person, Needs you first, not the folder last on screen (#10205); with nothing waiting again, the folder that was open before it
        if (countOf('needs') + welcomeRows().length > 0) { if (group !== 'needs') { _autoFrom = group; group = 'needs'; auto = true; } else if (_autoFrom) auto = true; }
        else if (_autoFrom && group === 'needs') { group = _autoFrom; _autoFrom = ''; }
    }
    _wasShown = true; _asked = false;
    setGroup(group, { auto });
    renderInboxNav(true);
    CH.loadChatCounts(() => renderInboxNav(true));
    refreshBoards(); // the phone drawer's Boards group
    if (nativeInbox()) { // the Hub-served Inbox draws the chat folders, Goals and Artifacts: Needs you, Tasks and Saved are the Hub's own framed pages (no request for them)
        refreshGoals();
        IA.refreshArtifactCount(() => renderFolderCounts());
    } else {
        refreshTasks();
        refreshReviews(true);
        refreshProposals(true);
        refreshRuns(true);
        refreshOperatorAsks(true); // the questions agents asked the Operator (#11417)
        if (group === 'activity') AC.refresh(() => renderInboxNav(true));
        refreshGoals();
        IA.refreshArtifactCount(() => renderFolderCounts());
        saved.loadSaved(); // everything's list (the Inbox is the all scope), read for the table and the count
    }
    if (quiet || (folder && state.currentSession && state.currentSession.type === 'history')) return; // a chat is on screen, or being opened (a saved message, a link to a chat): the Inbox is drawn under it, for the way back
    if (page) {
        if (isPhoneLayout()) $('inbox-view')?.setAttribute('data-phone-item', '');
        const route = routeForFolder(pageGroup());
        if (route && !currentRoute()?.view.startsWith('inbox-')) note({ ...route, id: page.project, ...(page.id ? { item: page.id } : {}) });
        return;
    } // the tab returns to its open item
    $('inbox-view')?.removeAttribute('data-phone-item');
    if (document.body.getAttribute('data-nav-tab') !== 'hub-inbox') return; // the module arrived after the person had moved on (a notification's click, a chosen agent): its table must not cover that
    noteFolder(group);
    openGroupTable('hub-inbox', group); // a phone too: the table has the folders' select on top
    const came = folder && group === 'needs' && itemOpeners.get('needs'), tbl = $('group-table-view'); if (came && tbl) { itemOpeners.delete('needs'); putBack(tbl, came); } // Back from a goal opened off Needs you: the list's place and the row's focus (#11950, #11964); the note is spent once used, so a later fresh open of Needs you does not jump back to it (#12319)
    markReady('inboxListDrawn'); // window.__coralReady (#12124)
}

/** The group the Inbox opens on the next time it is shown, with nothing drawn (the Saved button names it before it switches to the tab, so the last group is not on screen first). */
export function rememberGroup(name) { if (groupMeta(name)) { group = name; _asked = true; browserLocal.set(GROUP_KEY, name); } } // a folder asked for by name (Saved, Back to Saved) is the one the next show opens on, with something waiting or not

/** A group wanted on screen from elsewhere (the Saved button of the top bar): its table opens. */
export async function openInboxGroup(name) {
    if (!groupMeta(name)) name = DEFAULT_GROUP;
    $('inbox-local') && ($('inbox-local').hidden = false);
    closePage(false);
    page = null;
    $('inbox-page') && ($('inbox-page').hidden = true);
    setGroup(name);
    noteFolder(name);
    openGroupTable('hub-inbox', name);
    markReady('inboxListDrawn');
    const route = routeForFolder(name); if (route) note(route);
    if (name === 'goals') restoreGoalList();
    const opener = itemOpeners.get(name), table = $('group-table-view');
    if (opener && table) { itemOpeners.delete(name); putBack(table, opener); } // spent once used (#12319)
}

/** The list a person came back to is drawn (and redrawn) after the route, so its rows may not be there yet and a draw can put the scroll back to the top: for about a second keep its place and the row's focus where they were, until
 * the person scrolls, presses a key or clicks (#11964). */
function putBack(table, opener) {
    let frames = 60, steady = 0, stop = false;
    const off = () => { stop = true; for (const t of ['wheel', 'touchstart', 'keydown', 'pointerdown']) table.removeEventListener(t, off, true); };
    for (const t of ['wheel', 'touchstart', 'keydown', 'pointerdown']) table.addEventListener(t, off, { capture: true, once: true, passive: true });
    const step = () => {
        if (stop || !table.isConnected || --frames < 0 || steady >= 12) { off(); return; }
        const tr = opener.key && table.querySelector(`tr[data-key="${CSS.escape(opener.key)}"]`), row = tr && (tr.querySelector('.dt-primary') || (tr.hasAttribute('tabindex') || tr.setAttribute('tabindex', '-1'), tr)); // a row with no link of its own takes the focus itself, so Tab goes on to its buttons and Enter does nothing
        const a = document.activeElement, lost = row && !tr.contains(a) && !(a && a.closest && a.closest('input, textarea, select, dialog, [contenteditable]')); // the draw (or the Inbox's own focus reset) moved it off the row
        if (lost) { row.focus({ preventScroll: true }); steady = 0; }
        if (tr || !opener.key) { if (Math.abs(table.scrollTop - opener.scroll) > 1) { table.scrollTop = opener.scroll; steady = 0; } else steady++; }
        requestAnimationFrame(step);
    };
    step();
}

function restoreGoalList() {
    const table = $('group-table-view');
    if (!table || !goalOpener) return;
    table.querySelector(`tr[data-key="${CSS.escape(goalOpener.team + '#' + goalOpener.id)}"] .dt-primary`)?.focus({ preventScroll: true });
    table.scrollTop = goalScroll;
}

/** A link to a goal that looks done (#12172): the goals are read again, and the goal opens on its own page when it is still one item of Needs you; false when it is not (done since, hidden, no such goal). */
export async function openGoalDoneNeed(team, id) {
    await refreshGoals();
    const g = doneGoals(goals, goalTeamHere).find(x => goalTeamHere(x) === team && String(x.id) === String(id));
    if (!g) return false;
    openGoalDone(g);
    return true;
}

/** The Inbox owns its goal address and Back; the shared component owns the goal. */
export async function openInboxGoal(team, id) {
    closePage(false);
    await showInbox({ folder: 'goals', quiet: true });
    if (currentRoute()?.view !== 'inbox-goals' || currentRoute()?.id !== team || currentRoute()?.item !== id) return;
    page = { kind: 'goal', project: team, id };
    setGroup('goals');
    const host = $('inbox-page');
    host.hidden = false; host.classList.add('inbox-goal-page'); host.replaceChildren();
    showView('inbox-view');
    $('inbox-view')?.setAttribute('data-phone-item', '');
    host.append(VL.build({ id: 'inbox-goal-folders', label: 'Inbox views', sections: folderSections(), current: 'goals', onPick: pickFolder, drawer: true }));
    const view = el('div', 'goals-page goals-table-page goals-open');
    const body = el('div', 'goals-body'); view.append(body); host.append(view);
    const before = String(history.state?.prev || '');
    goalMount = mountGoal(body, { team, id, status: sayLive,
        teamLink: build(keyRoute('team', team, 'goals', id)), focusOnOpen: false, backLabel: backLabelFor('goal', before, openedFrom()),
        onTask: (task, g) => go({ view: 'inbox-tasks', sub: 'tasks', id: team, item: task.id }, { from: g && g.title }), // a task of the goal opens in the Inbox, never on the team page (#8861); its Back says the goal
        back: () => { if (backIs(folderRoute) || cameFromInbox()) history.back(); else go(folderRoute); }, // to the Inbox screen it was opened from (a task's Goal line), else the folder
    });
    renderInboxNav(true);
    const want = closeAfterOpen; closeAfterOpen = null; // Close goal on a "looks done" item: the Close dialog, set to Done, on the goal's own page (#11825)
    const g = want && String(want.team) === String(team) && String(want.id) === String(id) ? goals.find(x => x.board_id === want.team && String(x.id) === String(want.id)) : null;
    if (g) goalMount.openClose(g, 'done');
}


/** The screen before this one in the history is an Inbox address (the goal a task was opened from): Back goes there. */
const cameFromInbox = () => /^\/inbox(\/|$)/.test(String(history.state?.prev || ''));

/** Task and Board details share their team renderers, with an Inbox-owned address and way back. */
export async function openInboxItem(kind, team, id) {
    closePage(false);
    const key = kind === 'tasks' ? 'tasks' : BOARDS_FOLDER, route = routeForFolder(key);
    await showInbox({ folder: key, quiet: true });
    if (currentRoute()?.view !== route.view || currentRoute()?.id !== team || (kind === 'tasks' && currentRoute()?.item !== id)) return;
    page = { kind, project: team, id };
    setGroup(key);
    const host = $('inbox-page'); host.hidden = false; host.classList.add('inbox-item-page'); host.replaceChildren();
    showView('inbox-view'); $('inbox-view')?.setAttribute('data-phone-item', '');
    host.append(VL.build({ id: 'inbox-item-folders', label: 'Inbox views', sections: folderSections(), current: navCurrent(), onPick: pickFolder, drawer: true }));
    const body = el('div', 'inbox-item-body'); host.append(body);
    const before = String(history.state?.prev || '');
    itemMount = mountInboxItem(body, { kind, team, id, onChanged: refreshTasks, backLabel: kind === 'tasks' ? backLabelFor('task', before, openedFrom()) : '', back: () => { if (backIs(route) || cameFromInbox()) history.back(); else go(route); } }); // Back returns to the Inbox screen it was opened from (a goal, another task), else to the folder
    renderInboxNav(true);
}


registerActions({
    'inbox-saved-chip': el => { const t = textOf(el.dataset.tab); if (t) { saved.setSavedTab(t); sayLive(t === 'done' ? 'Showing the messages marked done' : 'Showing the open messages'); } },
    'inbox-phone-back': () => closePage(true, true),
    'inbox-back': () => { const was = page, g = was ? 'saved' : group; closePage(false); openGroupTable('hub-inbox', g); focusCameFrom(was); }, // the link back to the group's table (on a phone too, as the shared back link did), with the focus on the row it came from
});
document.addEventListener('coral:asked-dismissed', () => renderInboxNav(true)); // a question asked before Coral restarted leaves the Needs you list (#10368)
