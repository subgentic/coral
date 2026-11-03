/* The Skills tab (#12078, goal #191): the Operator's list of skills (the shared data table, sortable, set column widths), the approval view with every file and its text, the scanner's warnings and the two-step
 * approval of a skill with scripts, and Import. Everything a skill says is drawn with textContent: a file's text is shown as text, never rendered. Local Coral only; an agent has none of these routes. */
import { importOnce } from './import_once.js';
import { loadStyles } from './lazy_styles.js';
import { showView, showToast } from './utils.js';
import { requestJson } from './api.js';
import { note, currentRoute } from './nav.js';
import { registerActions } from './actions.js';
import { isPhoneLayout } from './phone_layout.js';
import { SKILL_FOLDERS } from './routes.js';
const DT = await importOnce('./data_table.js');
const VL = await importOnce('./view_list.js'); // the folders in the sidebar (and a phone's strip), as Automations and the Inbox have them (#12997)
await loadStyles('skills.css');

const { el } = DT;
const STATUS = { pending: ['Pending approval', 'goal-state-task-active'], approved: ['Approved', ''], rejected: ['Rejected', 'team-state-bad'] }; // the tones the other lists pass to chip()
const FILTERS = [['', 'All'], ['pending', 'Pending approval'], ['approved', 'Approved'], ['rejected', 'Rejected']];
const tableState = DT.tableState();
let rows = [], everyRow = [], folder = '', query = '', showStatus = '', loadError = '', open = null /* { id, data, error, busy, acked, fileShown, opened: Set of the files shown } */;

const host = () => document.getElementById('skills-view');
const publisher = r => (r.publisher_kind === 'operator' ? 'Operator' : r.publisher_kind === 'coral' ? 'Coral (example)' : `${r.publisher_agent}${r.publisher_team ? ' · ' + r.publisher_team : ''}`);
const kb = n => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const short = h => String(h || '').slice(0, 12);
const button = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', onClick); return b; };

/** Pending skills wait on the Operator: the nav badge says how many (the tab loads it at start too). */
export async function loadSkillsBadge() {
    const badge = document.getElementById('nav-tab-skills-badge');
    if (!badge) return;
    try {
        const d = await requestJson('GET', '/api/skills?status=pending');
        const n = (d.skills || []).length;
        badge.textContent = String(n); badge.hidden = n === 0;
        badge.setAttribute('aria-label', `${n} skill${n === 1 ? '' : 's'} waiting for approval`);
    } catch { badge.hidden = true; }
}

async function loadList() {
    try {
        everyRow = (await requestJson('GET', '/api/skills')).skills || []; // the whole store: the folders' counts do not move with the status filter
        rows = showStatus ? everyRow.filter(r => r.status === showStatus) : everyRow;
        loadError = '';
    } catch (e) { rows = []; everyRow = []; loadError = e.message || 'The skills could not be read'; }
}

// ── the folders (#12997, the Operator: 'Skills can be Imported, Agent Created, Coral Skills') ──
// A skill's source is on its record (publisher_kind: operator = imported, agent = agent created, coral = Coral's own).
const KIND_OF = { imported: 'operator', 'agent-created': 'agent', 'coral-skills': 'coral' };
const FOLDER_LABEL = { '': 'All skills', imported: 'Imported', 'agent-created': 'Agent created', 'coral-skills': 'Coral skills' };
const inFolder = (r, f) => !f || r.publisher_kind === KIND_OF[f];
const sections = () => [{ title: 'Skills', items: ['', ...SKILL_FOLDERS].map(key => {
    const mine = everyRow.filter(r => inFolder(r, key)), waiting = key === 'agent-created' ? mine.filter(r => r.status === 'pending').length : 0;
    return { key: key || 'all', label: FOLDER_LABEL[key], count: waiting ? `${waiting} of ${mine.length}` : mine.length, alert: waiting > 0 }; // what waits on the Operator is said on Agent created, red, as Needs you says its unread
}) }];
let sideFolders = null;
function pickFolder(key) { folder = key === 'all' ? '' : key; open = null; note(folder ? { view: 'skills', folder } : { view: 'skills' }); draw(); }
function drawNav() {
    const list = document.getElementById('skills-nav-list');
    if (!list) return;
    const spec = { sections: sections(), current: folder || 'all' };
    if (sideFolders && list.contains(sideFolders)) VL.update(sideFolders, spec);
    else { sideFolders = VL.build({ id: 'skills-folders', label: 'Skills folders', ...spec, onPick: pickFolder }); list.replaceChildren(sideFolders); }
}
registerActions({ 'skills-search-filter': el => { query = String(el.value || '').trim().toLowerCase(); if (!open) draw(); } });
const matches = r => !query || `${r.name} ${r.description} ${publisher(r)}`.toLowerCase().includes(query);

async function loadOne(id) {
    open = { id, data: null, error: '', busy: false, acked: false, fileShown: null, opened: new Set() };
    draw();
    try { open.data = await requestJson('GET', `/api/skills/${encodeURIComponent(id)}`); }
    catch (e) { open.error = e.status === 404 ? 'This skill no longer exists.' : (e.message || 'The skill could not be read'); }
    draw();
}

export async function showSkillsTab(opts = {}) {
    showView('skills-view');
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
    const head = el('div', 'skills-head');
    const sel = el('select'); sel.setAttribute('aria-label', 'Show');
    for (const [v, label] of FILTERS) { const o = el('option', '', label); o.value = v; sel.append(o); }
    sel.value = showStatus;
    sel.addEventListener('change', async () => { showStatus = sel.value; await loadList(); draw(); });
    const input = el('input'); input.type = 'file'; input.accept = '.zip,.md,.markdown,application/zip,text/markdown'; input.hidden = true;
    input.addEventListener('change', () => { const f = input.files && input.files[0]; input.value = ''; if (f) importFile(f, false, false); });
    head.append(el('h2', '', 'Skills'), sel, button('btn', 'Import a skill', () => input.click()), el('span', 'skills-hint', '.zip or a SKILL.md'), input);
    page.append(head, el('p', 'skills-note', 'Agent Skills: a folder with SKILL.md that agents read when it fits their task. A skill an agent publishes waits here until you approve it; one you import is approved at once.'));
    if (loadError) { const p = el('p', 'skills-error', loadError); p.setAttribute('role', 'alert'); page.append(p); }
    const columns = [
        { key: 'name', label: 'Name', primary: true, width: 'grow', sort: true, sortValue: r => r.name.toLowerCase(), line: 1, cell: r => r.name },
        { key: 'description', label: 'Description', width: '16rem', line: 2, cell: r => r.description, narrowHide: true },
        { key: 'by', label: 'Published by', width: '10rem', sort: true, sortValue: publisher, cell: publisher },
        { key: 'version', label: 'Version', width: '5rem', align: 'end', sort: 'number', sortValue: r => r.version, cell: r => `v${r.version}` },
        { key: 'status', label: 'Status', width: '9rem', sort: true, sortValue: r => r.status, cell: r => { const [word, cls] = STATUS[r.status] || [r.status, '']; return DT.chip(word, cls); } },
        { key: 'scripts', label: 'Scripts', width: '5rem', align: 'end', sort: true, sortValue: r => (r.has_scripts || r.not_reviewable ? 1 : 0), cell: r => (r.has_scripts ? 'yes' : r.not_reviewable ? 'files' : '-'), narrowHide: true },
        { key: 'updated', label: 'Updated', width: '7rem', fixed: true, sort: 'date', sortValue: r => r.decided_at || r.created_at, cell: r => DT.timeCell(r.decided_at || r.created_at) },
    ];
    const shown = rows.filter(r => inFolder(r, folder) && matches(r));
    page.append(DT.dataTable({ label: `${FOLDER_LABEL[folder]}, ${shown.length}`, rows: shown, rowKey: r => r.id, rowName: r => r.name, state: tableState, columns, open: r => loadOne(r.id),
        ...(isPhoneLayout() ? { bare: true, sortBar: false, mail: r => ({ lead: { icon: 'auto_awesome', square: true, name: r.name }, title: r.name, snippet: r.description, state: (STATUS[r.status] || [r.status])[0], time: DT.timeCell(r.decided_at || r.created_at).textContent, mark: r.status === 'pending' ? 'attention' : undefined }) } : {}), // a phone's rows run edge to edge like the Inbox lists (#12957, the Operator's note on #12997): the shared mail row, no bordered box
        empty: { line: showStatus || folder || query ? 'No skill in this list.' : 'No skills yet.', hint: 'Import a skill, or an agent can publish one with coral-agent skills publish.' } }).el);
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
    const back = button('btn btn-small', 'All skills', async () => { open = null; await loadList(); draw(); loadSkillsBadge(); });
    const top = el('div', 'skills-head'); top.append(back); page.append(top);
    if (open.error) { const p = el('p', 'skills-error', open.error); p.setAttribute('role', 'alert'); page.append(p); return page; }
    if (!open.data) { page.append(el('p', 'skills-note', 'Loading…')); return page; }
    const d = open.data, s = d.skill, files = d.files || [], contents = d.contents || {};
    const [statusWord] = STATUS[s.status] || [s.status];
    const title = el('div', 'skills-head'); title.append(el('h2', '', `${s.name} · version ${s.version}`), DT.chip(statusWord, (STATUS[s.status] || [])[1]));
    page.append(title);
    const meta = el('div', 'skills-meta');
    meta.append(el('span', '', `Published by ${publisher(s)}`), el('span', '', `Digest ${short(s.digest)}`), el('span', '', `${files.length} file${files.length === 1 ? '' : 's'}`));
    page.append(meta, el('p', 'skills-note', s.description));
    if (s.status === 'removed') { page.append(el('p', 'skills-note', 'This skill was removed.')); return page; }
    let unopenedEl = null;
    if (s.status === 'pending') {
        const b = el('div', 'notice notice-warn skills-banner'); b.append(el('strong', '', 'Read it before you approve it.'));
        b.append(el('span', '', `This skill was published by ${publisher(s)}. Its text is instructions an agent will follow, and approving it puts its description into the instructions of every agent that has it attached. Nothing here is searchable or attachable until you approve.`));
        unopenedEl = el('p', 'skills-unopened'); b.append(unopenedEl);
        page.append(b);
    }
    // the files: every one, with its size, kind and SHA-256
    const risky = files.filter(f => f.kind === 'script' || f.kind === 'not_reviewable');
    const fileSec = el('div', 'skills-section'); fileSec.append(el('h3', '', 'Files'));
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
    page.append(fileSec);
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
