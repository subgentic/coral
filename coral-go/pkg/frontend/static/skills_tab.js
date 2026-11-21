/* The Skills tab (#12078, goal #191): the Operator's list of skills (the shared data table, sortable, set column widths), the approval view with every file and its text, the scanner's warnings and the two-step
 * approval of a skill with scripts, and Import. Instructions use the strict Markdown renderer, including escaped HTML comments; raw files remain available as text. Local Coral only; an agent has none of these routes. */
import { importOnce } from './import_once.js';
import { loadStyles } from './lazy_styles.js';
import { renderMarkdownStrict, showView, showToast } from './utils.js';
import { requestJson } from './api.js';
import { note, currentRoute } from './nav.js';
import { isPhoneLayout } from './phone_layout.js';
import { state } from './state.js';
import { keyLabel, sessionServer, serverFetch, isCloud } from './server_base.js';
import { resolveSessionIdentity } from './session_state.js';
import { SKILL_FOLDERS } from './routes.js';
const { latestSkillRows, skillVersions } = await importOnce('./skill_versions.js');
const { machineChoices, machineLabel, machineOnline, machineInventoryPending } = await importOnce('./analytics_machine.js'); // the Computer picker, as the Queue has it (#19627)
const DT = await importOnce('./data_table.js');
const PH = await importOnce('./page_header.js'); // the shared page header: title and count, the Primary at the far right (#15838, guidelines 4.2)
const VL = await importOnce('./view_list.js'); // the folders in the sidebar (and a phone's strip), as Automations and the Inbox have them (#12997)
await loadStyles('skills.css');

const { el } = DT;
const STATUS = { pending: ['Pending approval', 'goal-state-task-active'], approved: ['Approved', ''], rejected: ['Rejected', 'team-state-bad'] }; // the tones the other lists pass to chip()
const FILTERS = [['', 'All'], ['pending', 'Pending approval'], ['approved', 'Approved'], ['rejected', 'Rejected']];
const tableState = DT.tableState();
let rows = [], everyRow = [], folder = '', query = '', showStatus = '', loadError = '', open = null /* { id, data, error, busy, acked, fileShown, opened: Set of the files shown } */;

const host = () => document.getElementById('skills-view');
const publisher = r => (cloud() ? '' : r.publisher_kind === 'operator' ? 'Operator' : r.publisher_kind === 'coral' ? 'Coral (example)' : `${r.publisher_agent}${r.publisher_team ? ' · ' + r.publisher_team : ''}`);
const kb = n => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const short = h => String(h || '').slice(0, 12);
// ── through a Coral Hub (#19627): the page READS one linked computer's skills, owner only, through the Hub. The Hub sends a list of rows without who published them or which teams use them, and a skill's page with its
// SKILL.md text alone (scripts, other files and scanner lines stay on the computer). Import, approve, reject, remove and Use in a team are the person's act on the computer, so they are not drawn here. ──
const cloud = () => isCloud();
let chosenComputer = '', pendingInventory = null;
document.addEventListener('coral:servers-updated', () => { if (pendingInventory && !machineInventoryPending()) { const opts = pendingInventory; pendingInventory = null; if (host()?.getClientRects().length) showSkillsTab(opts); } });
const computers = () => machineChoices();
const computer = () => (computers().includes(chosenComputer) ? chosenComputer : (computers()[0] || ''));
/** One GET: on a computer's own page the dashboard's request; on a Hub's page the chosen computer's, with the status and message an error carries. */
async function readJson(path) {
    if (!cloud()) return requestJson('GET', path);
    const id = computer();
    if (!id) { const e = new Error('No computer is linked to read skills from.'); e.status = 0; throw e; }
    const r = await serverFetch(id, path);
    const data = await r.json().catch(() => null);
    if (!r.ok) { const e = new Error((data && (data.error || data.message)) || (r.status === 403 ? 'Only the account this computer is linked to can read its skills through the Hub.' : 'The skills could not be read')); e.status = r.status; e.data = data; throw e; }
    return data;
}
const button = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', onClick); return b; };

/** Pending skills wait on the Operator: the nav badge says how many (the tab loads it at start too). */
export async function loadSkillsBadge() {
    const badge = document.getElementById('nav-tab-skills-badge');
    if (!badge) return;
    if (cloud()) { badge.hidden = true; return; } // a Hub's page has no badge: what waits for approval is approved at the computer
    try {
        const d = await requestJson('GET', '/api/skills?status=pending');
        const n = (d.skills || []).length;
        badge.textContent = String(n); badge.hidden = n === 0;
        badge.setAttribute('aria-label', `${n} skill${n === 1 ? '' : 's'} waiting for approval`);
    } catch { badge.hidden = true; }
}

async function loadList() {
    try {
        everyRow = (await readJson('/api/skills')).skills || []; // the whole store: the folders' counts do not move with the status filter
        rows = latestSkillRows(everyRow, showStatus);
        loadError = '';
    } catch (e) { rows = []; everyRow = []; loadError = e.message || 'The skills could not be read'; }
}

// ── the folders (#12997, the Operator: 'Skills can be Imported, Agent Created, Coral Skills') ──
// A skill's source is on its record (publisher_kind: operator = imported, agent = agent created, coral = Coral's own).
/** The teams that use a skill, as one line ("alpha, beta"); '' when none (an older Coral sends no list). */
function usedBy(r) { return Array.isArray(r.used_by) ? r.used_by.map(team => { const names = (state.liveSessions || []).filter(a => sessionServer(a) === 'local' && a.board_project === team).map(resolveSessionIdentity); return names.length ? `${keyLabel(team)} (${names.join(', ')})` : keyLabel(team); }).join(', ') : ''; }
const KIND_OF = { imported: 'operator', 'agent-created': 'agent', 'coral-skills': 'coral' };
const FOLDER_LABEL = { '': 'All skills', imported: 'Imported', 'agent-created': 'Agent created', 'coral-skills': 'Coral skills' };
const FOLDER_ICON = { '': 'dataset', imported: 'download', 'agent-created': 'smart_toy', 'coral-skills': 'auto_awesome' }; // a skill folder's glyph, as the Inbox's folders have theirs (#15820)
const inFolder = (r, f) => !f || cloud() || r.publisher_kind === KIND_OF[f];
const sections = () => [{ title: 'Skills', items: (cloud() ? [''] : ['', ...SKILL_FOLDERS]).map(key => {
    const mine = latestSkillRows(everyRow).filter(r => inFolder(r, key)), waiting = key === 'agent-created' ? mine.filter(r => r.pendingVersion).length : 0;
    return { key: key || 'all', label: FOLDER_LABEL[key], icon: FOLDER_ICON[key], count: waiting ? `${waiting} of ${mine.length}` : mine.length, alert: waiting > 0 }; // what waits on the Operator is said on Agent created, red, as Needs you says its unread
}) }];
let sideFolders = null;
function pickFolder(key) { folder = key === 'all' ? '' : key; open = null; note(folder ? { view: 'skills', folder } : { view: 'skills' }); draw(); }
function drawNav() {
    const list = document.getElementById('skills-nav-list');
    if (!list) return;
    const spec = { sections: sections(), current: folder || 'all' };
    if (sideFolders && list.contains(sideFolders)) VL.update(sideFolders, spec);
    else { sideFolders = VL.build({ id: 'skills-folders', label: 'Skills folders', ...spec, onPick: pickFolder }); list.replaceChildren(sideFolders); }
    importOnce('./sidebar_folder_rail.js').then(m => m.drawFolderRail('skills', 'Skills', spec.sections.flatMap(s => s.items), spec.current, pickFolder)).catch(() => {}); // the collapsed rail's icons (#15820)
}
export function filterSkills(v) { query = String(v || '').trim().toLowerCase(); if (!open) draw(); } // the sidebar's search box (its action is in app_actions.js, the page is loaded with the tab)
const matches = r => !query || `${r.name} ${r.description} ${publisher(r)}`.toLowerCase().includes(query);

async function loadOne(id) {
    open = { id, data: null, error: '', busy: false, acked: false, fileShown: null, opened: new Set() };
    const view = open;
    draw();
    try { const data = await readJson(`/api/skills/${encodeURIComponent(id)}`); if (open !== view) return; view.data = data; }
    catch (e) { if (open !== view) return; view.error = e.status === 404 ? 'This skill no longer exists.' : (e.message || 'The skill could not be read'); }
    draw();
}

export async function showSkillsTab(opts = {}) {
    showView('skills-view');
    if (machineInventoryPending()) { pendingInventory = opts; const line = el('p', 'empty-state-line', 'Loading computers…'); line.setAttribute('role', 'status'); const head = el('div', 'skills-head'), title = el('h2', '', 'Skills'); title.hidden = isPhoneLayout(); head.append(title); host().replaceChildren(head, line); host().setAttribute('aria-busy', 'true'); return; }
    host().removeAttribute('aria-busy');
    folder = SKILL_FOLDERS.includes(opts.folder) ? opts.folder : '';
    if (opts.id) { await loadList(); await loadOne(opts.id); return; }
    open = null;
    await loadList();
    draw();
    loadSkillsBadge();
}

function writeRoute(id) { const cur = currentRoute(); if (!cur || cur.view !== 'skills' || cur.id !== (id || undefined) || (!id && (cur.folder || '') !== folder)) note(id ? { view: 'skills', id } : folder ? { view: 'skills', folder } : { view: 'skills' }); }

function draw() {
    const h = host(); if (!h) return;
    h.replaceChildren(open ? drawDetail() : drawList());
    drawNav();
    writeRoute(open ? open.id : null);
}

// ── the list ────────────────────────────────────────────────────────────
function drawList() {
    const page = el('div', 'skills-page');
    if (isPhoneLayout()) page.append(VL.build({ id: 'skills-folders-page', label: 'Skills folders', sections: sections(), current: folder || 'all', onPick: pickFolder, tabs: true })); // a phone has no sidebar: the folders are a strip at the top of the page, as Automations has them
    const shown = rows.filter(r => inFolder(r, folder) && matches(r));
    const head = el('div', 'list-bar-search-row gt-toolbar toolbar');
    const title = el('h2', '', 'Skills'); title.id = 'skills-title'; title.tabIndex = -1;
    const count = el('span', 'session-group-count', String(shown.length)); count.setAttribute('aria-label', `${shown.length} ${shown.length === 1 ? 'skill' : 'skills'}`);
    const sel = el('select', 'field field-dense team-tb-select'); sel.setAttribute('aria-label', 'Show'); // the shared field look: padding, radius, the page font (#12990); 44 px on a phone or touch
    for (const [v, label] of FILTERS) { const o = el('option', '', label); o.value = v; sel.append(o); }
    sel.value = showStatus;
    sel.addEventListener('change', async () => { showStatus = sel.value; await loadList(); draw(); });
    const picker = cloud() && computers().length > 1 ? el('select', 'field field-dense team-tb-select') : null; // which linked computer's skills
    if (picker) {
        picker.setAttribute('aria-label', 'Computer');
        for (const id of computers()) { const o = el('option', '', machineLabel(id) + (machineOnline(id) ? '' : ' (offline)')); o.value = id; picker.append(o); }
        picker.value = computer();
        picker.addEventListener('change', async () => { chosenComputer = picker.value; open = null; await loadList(); draw(); });
    }
    const input = el('input'); input.type = 'file'; input.accept = '.zip,.md,.markdown,application/zip,text/markdown'; input.hidden = true;
    input.addEventListener('change', () => { const f = input.files && input.files[0]; input.value = ''; if (f) importFile(f, false, false); });
    const importBtn = button('btn btn-primary team-tb-action', 'Import', () => input.click());
    importBtn.title = 'Import a skill: a .zip or a SKILL.md file'; importBtn.setAttribute('aria-label', 'Import a skill (a .zip or a SKILL.md file)');
    const folderHead = el('div', 'inbox-folder-head'); folderHead.append(title, count);
    head.append(folderHead, ...(picker ? [picker] : []), sel, ...(cloud() ? [] : [importBtn, input]));
    PH.pageHeader(head, { idp: 'skills' });
    page.append(head);
    const approval = 'Skills are reusable instructions that help an agent do a particular job, such as reviewing code or writing release notes. A skill an agent publishes waits here until you approve it; one you import is approved at once.';
    if (cloud()) page.append(el('p', 'skills-note', `This is ${machineLabel(computer())}'s list, read only. Import, approve and remove a skill in that computer's own Coral.`));
    else if (!loadError) page.append(el('p', 'skills-note', approval)); // the description is for an empty list; the approval rule stays under the header with skills listed (#16211)
    if (!cloud()) page.append(el('p', 'skills-note skills-get-started', 'Ask an agent to write a skill for a task you repeat, or download one from a source you trust. Import its .zip or SKILL.md file here, read it, then choose Use in a team.'));
    if (loadError) { const p = el('p', 'skills-error', loadError); p.setAttribute('role', 'alert'); page.append(p); }
    const columns = [
        { key: 'name', label: 'Name', primary: true, width: 'grow', min: 32, sort: true, sortValue: r => r.name.toLowerCase(), line: 1, cell: r => r.name },
        { key: 'description', label: 'Description', share: 3, min: 24, line: 2, cell: r => r.description, narrowHide: true },
        ...(cloud() ? [] : [{ key: 'by', label: 'Published by', width: '10rem', sort: true, sortValue: publisher, cell: publisher },
        { key: 'usedBy', label: 'Used by', width: '9rem', sort: true, sortValue: usedBy, cell: r => usedBy(r) || '-', narrowHide: true }]), // the teams whose agents have it attached or loaded (#15383)
        { key: 'version', label: 'Version', width: '6rem', align: 'end', sort: 'number', sortValue: r => r.version, cell: r => {
            const cell = el('span', '', `v${r.version}`), pending = r.pendingVersion;
            if (pending && pending.id !== r.id) {
                const review = button('btn btn-small', `v${pending.version} waiting`, e => { e.stopPropagation(); loadOne(pending.id); });
                review.setAttribute('aria-label', `v${pending.version} waiting: review version ${pending.version} of ${r.name}`);
                cell.append(' ', review);
            }
            return cell;
        } },
        { key: 'status', label: 'Status', width: '9rem', sort: true, sortValue: r => r.status, cell: r => { const [word, cls] = STATUS[r.status] || [r.status, '']; return DT.chip(word, cls); } },
        { key: 'scripts', label: 'Scripts', width: '5rem', align: 'end', sort: true, sortValue: r => (r.has_scripts || r.not_reviewable ? 1 : 0), cell: r => (r.has_scripts ? 'yes' : r.not_reviewable ? 'files' : '-'), narrowHide: true },
        { key: 'updated', label: 'Updated', width: '7rem', fixed: true, sort: 'date', sortValue: r => r.decided_at || r.created_at, cell: r => DT.timeCell(r.decided_at || r.created_at) },
    ];
    page.append(DT.dataTable({ label: `${FOLDER_LABEL[folder]}, ${shown.length}`, rows: shown, rowKey: r => r.id, rowName: r => r.name, state: tableState, columns, open: r => loadOne(r.id),
        ...(isPhoneLayout() ? { bare: true, sortBar: false, mail: r => ({ lead: { node: el('span', 'material-icons skill-list-icon', 'auto_awesome'), name: r.name }, title: r.name, snippet: r.description, state: (STATUS[r.status] || [r.status])[0] + (r.pendingVersion && r.pendingVersion.id !== r.id ? ` · v${r.pendingVersion.version} waiting` : ''), time: DT.timeCell(r.decided_at || r.created_at).textContent, mark: r.pendingVersion ? 'attention' : undefined }) } : {}), // a phone's rows run edge to edge like the Inbox lists (#12957, the Operator's note on #12997): the shared mail row, no bordered box
        empty: { line: showStatus || folder || query ? 'No skill in this list.' : 'No skills yet.', hint: 'Ask an agent to write a skill, or import one from a source you trust.' } }).el);
    return page;
}

/** A skill arrives as a .zip, or as one SKILL.md (any single .md): the server wraps the file as a one-file skill and checks it exactly as it checks a zip. Anything else is refused here, in words. */
export const skillFileKind = name => { const n = String(name || '').toLowerCase(); return n.endsWith('.zip') ? 'zip' : (n.endsWith('.md') || n.endsWith('.markdown')) ? 'md' : ''; };

async function importFile(file, scriptsAcked, acknowledgeSecret) {
    const kind = skillFileKind(file.name);
    if (!kind) { showToast(`A skill is a .zip or a SKILL.md file. "${String(file.name).slice(0, 60)}" is neither.`, true); return; }
    if (file.size > 5 * 1024 * 1024) { showToast('A skill is at most 5 MiB.', true); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    try {
        const d = await requestJson('POST', '/api/skills', { [kind === 'zip' ? 'zip_base64' : 'skill_md_base64']: btoa(bin), scripts_acked: scriptsAcked, acknowledge_secret: acknowledgeSecret });
        showToast(`Imported ${d.name} (version ${d.version}).`);
        await loadList(); draw(); loadSkillsBadge();
    } catch (e) {
        const code = e.data && e.data.code;
        if (e.status === 409 && code === 'scripts_not_acknowledged') {
            confirmOrSay('This skill has scripts', 'It includes scripts or files that cannot be shown as text, which an agent that has this skill can run with its own permissions. Import it only if you have read them. Import anyway?', () => importFile(file, true, acknowledgeSecret), { label: 'Import', danger: true });
        } else if (e.status === 409 && code === 'holds_secret') {
            confirmOrSay('A file holds a secret', `${e.message} Import anyway?`, () => importFile(file, scriptsAcked, true), { label: 'Import anyway', danger: true });
        } else showToast(`Couldn't import it: ${e.message}`, true);
    }
}

// ── the approval view ──────────────────────────────────────────────────
function drawDetail() {
    const page = el('div', 'skills-page');
    const back = button('btn btn-small', 'Back to ' + (folder ? FOLDER_LABEL[folder] : 'all skills'), async () => { open = null; await loadList(); draw(); loadSkillsBadge(); });
    const top = el('div', 'skills-head'); top.append(back); page.append(top);
    if (open.error) { const p = el('p', 'skills-error', open.error); p.setAttribute('role', 'alert'); page.append(p); return page; }
    if (!open.data) { page.append(el('p', 'skills-note', 'Loading…')); return page; }
    const d = open.data, s = d.skill, files = d.files || [], contents = cloud() ? (d.skill_md != null ? { 'SKILL.md': d.skill_md } : {}) : (d.contents || {}); // through a Hub the one text is SKILL.md's
    const [statusWord] = STATUS[s.status] || [s.status];
    const title = el('div', 'skills-head'); title.append(el('h2', '', `${s.name} · version ${s.version}`), DT.chip(statusWord, (STATUS[s.status] || [])[1]));
    page.append(title);
    const meta = el('div', 'skills-meta');
    meta.append(...(cloud() ? [] : [el('span', '', `Published by ${publisher(s)}`), el('span', 'skills-used-by', usedBy(s) ? `Used by ${usedBy(s)}` : 'Not used by a team yet')]), el('span', '', `${files.length} file${files.length === 1 ? '' : 's'}`));
    page.append(meta, el('p', 'skills-note', s.description));
    if (s.status === 'approved' && !cloud()) {
        const use = el('div', 'skills-section');
        use.append(button('btn btn-primary', 'Use in a team', async () => {
            try { const { showSkillUse } = await importOnce('./skill_use.js'); showSkillUse(use, s, teams => { s.used_by = [...new Set([...(s.used_by || []), ...teams])]; meta.querySelector('.skills-used-by').textContent = usedBy(s) ? `Used by ${usedBy(s)}` : 'Not used by a team yet'; }); }
            catch { showToast('The team picker could not be opened. Try again.', true); }
        })); page.append(use);
    }
    const versions = skillVersions(everyRow, s);
    if (versions.length > 1) {
        const history = el('details', 'skills-section skills-history'), summary = el('summary', '', `Versions (${versions.length})`), list = el('ul');
        for (const v of versions) { const item = el('li'); item.append(button('btn btn-small', `v${v.version} · ${(STATUS[v.status] || [v.status])[0]}${v.id === s.id ? ' · current view' : ''}`, () => loadOne(v.id))); list.append(item); }
        history.append(summary, list); page.append(history);
    }
    if (s.status === 'removed') { page.append(el('p', 'skills-note', 'This skill was removed.')); return page; }
    let unopenedEl = null;
    if (s.status === 'pending' && !cloud()) {
        const b = el('div', 'notice notice-warn skills-banner'); b.append(el('strong', '', 'Read it before you approve it.'));
        b.append(el('span', '', `This skill was published by ${publisher(s)}. Its text is instructions an agent will follow, and approving it puts its description into the instructions of every agent that has it attached. Nothing here is searchable or attachable until you approve.`));
        unopenedEl = el('p', 'skills-unopened'); b.append(unopenedEl);
        page.append(b);
    }
    // the files: every one, with its size, kind and SHA-256
    const risky = files.filter(f => f.kind === 'script' || f.kind === 'not_reviewable');
    const fileSec = el('details', 'skills-section skills-developer'); fileSec.open = s.status === 'pending'; fileSec.append(el('summary', '', 'Files and developer details'), el('p', 'skills-note', `Digest ${s.digest}`));
    fileSec.append(DT.dataTable({ label: `Files, ${files.length}`, rows: files, rowKey: f => f.path, rowName: f => f.path, columns: [
        { key: 'path', label: 'File', primary: true, width: 'grow', sort: true, cell: f => f.path },
        { key: 'size', label: 'Size', width: '5rem', align: 'end', sort: 'number', sortValue: f => f.size, cell: f => kb(f.size) },
        { key: 'kind', label: 'Kind', width: '9rem', sort: true, cell: f => ({ instructions: 'Instructions', script: 'Script', text: 'Text', not_reviewable: 'Not reviewable' })[f.kind] || f.kind },
        { key: 'sha', label: 'SHA-256', width: '8rem', cell: f => short(f.sha256) },
    ], open: f => { open.fileShown = f.path; draw(); } }).el);
    const shown = open.fileShown && contents[open.fileShown] != null ? open.fileShown : (contents['SKILL.md'] != null ? 'SKILL.md' : null);
    if (shown) open.opened.add(shown);
    if (unopenedEl) { const n = unopenedFiles(d).length; unopenedEl.textContent = n ? `${n} file${n === 1 ? '' : 's'} not opened yet.` : 'You have opened every file that can be shown.'; }
    if (shown) { const pre = el('pre', 'skills-file-text'); pre.textContent = contents[shown]; pre.setAttribute('aria-label', `Text of ${shown}`); fileSec.append(el('p', 'skills-note', `Showing ${shown}`), pre); }
    if (contents['SKILL.md']) { const instructions = el('div', 'skills-instructions prose prose-doc'); instructions.innerHTML = renderMarkdownStrict(contents['SKILL.md']); page.append(instructions); }
    page.append(fileSec);
    if (cloud()) {
        const why = d.skill_md_withheld ? 'The instructions could not be checked for secrets, so they are not shown here.' : d.skill_md_truncated ? 'The instructions are cut at 64 KB here.' : '';
        page.append(el('p', 'skills-note', `${why ? why + ' ' : ''}Scripts and other files stay on ${machineLabel(computer())}: open them in that computer's own Coral.`));
        return page; // no scanner lines, no approve, no remove: those are that computer's
    }
    // what the scanner found in the scripts
    const warnings = d.warnings || [], hosts = d.hosts || [];
    if (warnings.length || hosts.length) {
        const sec = el('div', 'skills-section'); sec.append(el('h3', '', 'What the scripts do'));
        if (warnings.length) { const ul = el('ul', 'skills-warn'); for (const w of warnings) ul.append(el('li', '', `${w.file}: ${w.rule}`)); sec.append(ul); }
        if (hosts.length) sec.append(el('p', 'skills-note', `Hosts the scripts name: ${hosts.join(', ')}`));
        sec.append(el('p', 'skills-note', 'A warning, never a guarantee: your reading is the check.'));
        page.append(sec);
    }
    if (s.status === 'pending') page.append(drawApproval(s, risky));
    else if (s.publisher_kind === 'coral') page.append(el('p', 'skills-note', 'An example from Coral. It stays here, and Coral refreshes it when its text changes.')); // never removed (#12463)
    else page.append(drawRemove(s));
    return page;
}

/** The files whose text this view can show and the Operator has not had on screen yet (SKILL.md is on screen at first). The ones that cannot be shown are the second step's. */
const unopenedFiles = d => (d.files || []).filter(f => (d.contents || {})[f.path] != null && !open.opened.has(f.path));
const confirmOrSay = (title, text, fn, opts) => { if (typeof window.showConfirmModal === 'function') window.showConfirmModal(title, text, fn, undefined, { label: opts.label, danger: opts.danger === true }); else showToast('The confirm box is not available, so nothing was done. Reload the page and try again.', true); };

function drawApproval(s, risky) {
    const wrap = el('div', 'skills-section');
    const digest = s.digest; // the one this view held, not one read again
    let ackBox = null;
    if (risky.length) {
        const ack = el('div', 'notice notice-warn skills-ack'); ack.append(el('strong', '', `Second step: ${risky.length} file${risky.length === 1 ? '' : 's'} to review`));
        ack.append(el('p', '', 'These run with an agent\'s permissions, or cannot be shown as text here. They are exactly:'));
        const ul = el('ul');
        for (const f of risky) { const li = el('li'); li.append(el('code', '', f.path), ` (${f.kind === 'script' ? 'script' : 'not shown as text'}, ${kb(f.size)}, SHA-256 ${f.sha256})`); ul.append(li); }
        ack.append(ul);
        const label = el('label'); ackBox = el('input'); ackBox.type = 'checkbox'; label.append(ackBox, ' I have read these files'); ackBox.checked = open.acked && open.ackedDigest === digest; // kept across a file switch while the digest is the same
        ack.append(label); wrap.append(ack);
    }
    const doApprove = async () => {
        if (open.busy) return; open.busy = true; syncButtons();
        try {
            await requestJson('POST', `/api/skills/${encodeURIComponent(s.id)}/approve`, { digest, scripts_acked: !!(ackBox && ackBox.checked) });
            showToast(`Approved ${s.name}.`); open = null; await loadList(); draw(); loadSkillsBadge();
        } catch (e) {
            open.busy = false;
            if (e.data && e.data.code === 'skill_changed') { showToast('This is not the skill you reviewed: here is the new view.', true); await loadOne(s.id); return; }
            showToast(`Couldn't approve it: ${e.message}`, true); syncButtons();
        }
    };
    const approve = button('btn', open.busy ? 'Approving…' : 'Approve', () => {
        const n = unopenedFiles(open.data).length;
        if (!n) { doApprove(); return; }
        confirmOrSay('Approve with files not opened', `${n} file${n === 1 ? ' has' : 's have'} not been opened yet. Approve ${s.name} anyway?`, doApprove, { label: 'Approve' });
    });
    const reject = button('btn btn-danger', 'Reject', () => confirmOrSay('Reject this skill', `Reject ${s.name}? Nobody can attach it, and an agent cannot publish these exact bytes again.`, async () => {
        try { await requestJson('POST', `/api/skills/${encodeURIComponent(s.id)}/reject`); showToast(`Rejected ${s.name}.`); open = null; await loadList(); draw(); loadSkillsBadge(); }
        catch (e) { showToast(`Couldn't reject it: ${e.message}`, true); }
    }, { label: 'Reject', danger: true }));
    const syncButtons = () => { approve.disabled = open.busy || (!!ackBox && !ackBox.checked); approve.textContent = open.busy ? 'Approving…' : 'Approve'; };
    if (ackBox) ackBox.addEventListener('change', () => { open.acked = ackBox.checked; open.ackedDigest = digest; syncButtons(); });
    syncButtons();
    const actions = el('div', 'skills-actions'); actions.append(approve, reject);
    wrap.append(actions);
    return wrap;
}

function drawRemove(s) {
    const actions = el('div', 'skills-actions');
    actions.append(button('btn btn-danger', 'Remove', () => confirmOrSay('Remove this skill', `Remove ${s.name} version ${s.version}? Agents that have it attached are told it was removed. Nothing is deleted from your computer but the skill's own copy.`, async () => {
        try { await requestJson('DELETE', `/api/skills/${encodeURIComponent(s.id)}`); showToast(`Removed ${s.name}.`); open = null; await loadList(); draw(); loadSkillsBadge(); }
        catch (e) { showToast(`Couldn't remove it: ${e.message}`, true); }
    }, { label: 'Remove', danger: true })));
    return actions;
}

