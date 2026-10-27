const { liveServer: liveOf, buildServersTable } = await importOnce('./server_table.js');
/* Servers dialog for the Cloud Hub: the servers enrolled to this account.
 * List (name, online/offline, last contact), rename, "allow launching from the
 * web" switch, revoke (confirmed in the dialog, never window.confirm), and the
 * enrollment instructions. All text from the server goes through textContent.
 *
 * API (docs/enrollment-tunnel.md in coral-hub):
 *   GET    /api/servers                -> {servers: [{id, label, created_at, last_seen, access_mode, local_mode, effective_mode, limited_by, online}]}
 *   PATCH  /api/servers/{id} {label?, access_mode?: follow|interact|view}
 *   DELETE /api/servers/{id}           (revoke; closes the live tunnel)
 *
 * Access modes (see docs/access-modes): the connector reports the most it will allow
 * locally as `local_mode` (chosen on that computer when it connected: "What may Coral Hub do
 * on this computer?"). The owner's access to a server FOLLOWS it (`access_mode` "follow", the
 * default; the old "launch" means follow) or is limited to "interact" or "view": a control that
 * only lowers, never raises. The effective mode is the machine's announced max when following,
 * else the LOWER of the owner's cap and the announced max; a machine that has not announced yet
 * counts as View. The hub's own effective_mode / limited_by win when the row carries them. */

import { rememberFocus } from './dom_morph.js';
import { importOnce } from './import_once.js';
import { h } from './cloud.js';
import { formatLastSeen, updateNotice, RELEASES_URL, DOWNLOAD_URL, serverVersion, serverAgentCount, belowMinimumText } from './server_status.js';
import { accessChanged } from './hub_access.js';
const { MODES, MODE_INFO, accessChoice, effectiveMode, launchNote, effectiveNote, invalidateServerAccess, serverAccess } = await importOnce('./server_access.js');
const rank = m => MODES.indexOf(m);
import { announceNotice } from './notifications.js';
import { OWNER_LABEL_STEP } from './owner_label.js';
import { healthDot, healthCard } from './machine_health.js';
// This module is loaded lazily, so its search box is loaded the same way (a static import of a module not loaded at startup could not be retried: import_hygiene).
const { syncRelaunchReads, resetRelaunchReads, relaunchBadge } = await importOnce('./relaunch_badge.js'); // the "Updating" badge of a hub relaunch (#5355, behind the update flag)
const { syncServersBar, serverVisible, serversFiltered } = await importOnce('./server_search.js');
const DT = await importOnce('./data_table.js'); // the one table (#7903)

// The Servers tab (#3070) hosts this list; there is no separate dialog.
let host = null;
let servers = [];
let loadError = '';
let confirming = null;   // id awaiting revoke confirmation
let renaming = null;     // id being renamed
let busy = new Set();
let loaded = false;
let enrollOpen = null; // null follows the account: first machine open, existing machines closed
let enrollCode = '';
const accessDetails = new Set();
const relinkOpen = new Set(); // ids whose "Owner not confirmed" explanation is open (#6110)
/** The words for a machine the hub says cannot confirm its owner yet (GET /api/servers needs_relink, #6110). The step is owner_label.js's, the same one the message on that computer says (#6108); the Servers row names the machine,
 *  because it is not the computer in the person's hand. */
const RELINK_BUTTON = 'Owner not confirmed';
const relinkHelp = label => `${label || 'This machine'} can't confirm its owner yet. On that computer, ${OWNER_LABEL_STEP}.`;
const relinkId = s => `${rowId(s.id)}-relink`;

let load;
export const serverView = {
    mount(el, refresh) {
        load = refresh; wireMoreClose();
        if (host !== el) enrollOpen = null;
        host = el; confirming = null; renaming = null; loadError = ''; loaded = false;
        resetRelaunchReads();
    },
    leave() { host = null; },
    canRefresh: () => !renaming && !busy.size,
    accept(rows) {
        const before = loaded ? new Map(servers.map(s => [s.id, s.online === true])) : null;
        servers = rows;
        if (before) for (const s of servers) { const was = before.get(s.id); if (was !== undefined && was !== (s.online === true)) announceNotice(`${s.label || 'A computer'} is ${s.online === true ? 'online' : 'offline'}`); }
        loaded = true; loadError = ''; syncRelaunchReads(servers, render);
    },
    fail: error => { loadError = error; },
    expand: id => { expanded.add(id); render(); },
    render,
};

async function call(id, method, body) {
    busy.add(id); render();
    const accessChange = method === 'PATCH' && !!body && 'access_mode' in body;
    let changed = false;
    try {
        const r = await fetch(`/api/servers/${encodeURIComponent(id)}`, {
            method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
        });
        if (!r.ok) loadError = r.status === 404 ? 'That server no longer exists.' : 'The change was not saved.';
        else { loadError = ''; invalidateServerAccess(); changed = accessChange; }
    } catch { loadError = 'Could not reach the hub.'; }
    busy.delete(id);
    await load();
    // An agent already open on this server re-decides its read-only state from a
    // fresh lookup: the effective mode, not the hub setting alone (#3138).
    if (changed) accessChanged(id, await serverAccess(id));
}

/** The row's update badge (a link to the releases page), or null. */
function updateBadge(e) {
    const n = updateNotice(e);
    return n ? h('a', { className: `chip server-update-badge server-update-${n.level}`, href: RELEASES_URL, target: '_blank', rel: 'noopener noreferrer',
        title: n.text, 'aria-label': n.text, text: n.label }) : null;
}

/** Change a server's hub access (view | interact | launch; launch is "up to what the computer allows"). Immediate, no dialog. Focus stays on the select. */
async function setAccess(s, value) {
    await call(s.id, 'PATCH', { access_mode: value });
    const sel = document.getElementById(rowId(s.id))?.querySelector('.cs-launch select');
    if (sel && document.activeElement === document.body) sel.focus();
}

// The list is the shared table (Name, Status, Coral, Agents, Hub access, and the row actions Rename and Revoke) with sortable heads; a row expands for the rest (health, what applies, the update notice) in the table's detail row.
const dtState = DT.tableState();
dtState.sort = { key: 'name', dir: 'asc' };
const expanded = new Set(); // ids of the rows that are open

/** Compare two dotted versions numerically ("1.4.10" after "1.4.9"); anything unreadable sorts as 0. */
function versionParts(v) { return String(v || '').replace(/^v/, '').split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0); }
function cmpVersion(a, b) {
    const x = versionParts(a), y = versionParts(b);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    return 0;
}

function effectiveOf(s) { return rank(s.effective_mode) >= 0 ? s.effective_mode : effectiveMode(s); }

/** The value a column sorts by. */
function sortValue(s, key) {
    const live = liveOf(s);
    if (key === 'status') return s.online === true ? 1 : 0;
    if (key === 'version') return serverVersion(live);
    if (key === 'agents') return serverAgentCount(live);
    if (key === 'access') return rank(effectiveOf(s));
    return String(s.label || 'Unnamed server').toLowerCase();
}


function toggle(id) {
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    render();
}

function nameCell(s, live, online, isOpen, detailId) {
    if (renaming === s.id) {
        return h('form', { className: 'cs-actions cs-rename', onsubmit: e => { e.preventDefault(); const v = e.target.elements.label.value.trim(); renaming = null; if (v && v !== s.label) call(s.id, 'PATCH', { label: v }); else render(); } },
            h('input', { name: 'label', type: 'text', value: s.label || '', maxLength: 100, 'aria-label': 'Server name', autocomplete: 'off' }),
            h('button', { type: 'submit', className: 'btn btn-small btn-primary', text: 'Save' }),
            h('button', { type: 'button', className: 'btn btn-small', text: 'Cancel', onclick: () => { renaming = null; render(); } }));
    }
    return h('div', { className: 'cs-title' },
        h('button', { type: 'button', className: 'cs-toggle', 'aria-expanded': isOpen ? 'true' : 'false', 'aria-controls': detailId, onclick: () => toggle(s.id) },
            h('span', { className: 'cs-chevron', 'aria-hidden': 'true', text: isOpen ? '▾' : '▸' }),
            h('span', { className: 'cs-dot ' + (online ? 'online' : 'offline'), 'aria-hidden': 'true' }),
            h('span', { className: 'cs-name', text: s.label || 'Unnamed server' })),
        // The machine's health (#3446): the hub relays it while the machine is connected; without it (offline, held, reconnecting) the dot says unknown, never a stale ok.
        healthDot(online ? live.machine_health : null, s.label || 'Server'),
        relaunchBadge(h, s.id));
}

function accessPicker(s, isBusy, helpId) {
    // The owner's choice, View / Interact / Launch; an option above what the computer announced is disabled (Launch means "up to what the computer allows"). The text under it says why (in the open row).
    const choice = accessChoice(s);
    const local = rank(s.local_mode) >= 0 ? s.local_mode : 'view'; // not announced yet: View
    return h('label', { className: 'cs-launch' }, h('span', { className: 'sr-only', text: `Hub access for ${s.label || 'this server'} ` }),
        h('select', { disabled: isBusy, value: choice, 'aria-describedby': helpId, onchange: e => setAccess(s, e.target.value) },
            ['view', 'interact', 'launch'].map(v => h('option', { value: v, selected: v === choice, disabled: rank(v) > rank(local) && v !== choice, text: MODE_INFO[v].label }))));
}

// A click anywhere else closes an open More.
let moreClickWired = false;
function wireMoreClose() { if (moreClickWired) return; moreClickWired = true; document.addEventListener('click', e => { if (moreOpen !== null && !e.target.closest?.('.cs-more')) { moreOpen = null; render(); } }); }

/** Put the keyboard back on a control of a machine's row after the redraw. */
function focusRow(id, selector) { const el = document.getElementById(rowId(id))?.querySelector(selector); if (el) el.focus(); }

/** Revoke asks first, in the row: the keyboard goes to Cancel (the safe answer), and Cancel or Escape leave the machine connected and put the keyboard back on that row's Revoke. */
let moreOpen = null; // the row whose More menu is open: a redraw (the list refreshes on its own) keeps it open
function askRevoke(s) { moreOpen = null; confirming = s.id; render(); focusRow(s.id, '.cs-actions .cs-revoke-cancel'); }
function cancelRevoke(s) { confirming = null; render(); focusRow(s.id, '.cs-more-btn'); }
const revokeNoteId = s => `${rowId(s.id)}-revoke-note`;

/** Rename and Revoke, in the row's last column; Revoke asks in place (Confirm revoke / Cancel). */
function rowActions(s, isBusy) {
    return confirming === s.id
        ? [h('button', { type: 'button', className: 'btn btn-small btn-danger', text: 'Confirm revoke', 'aria-describedby': revokeNoteId(s), onclick: () => { confirming = null; call(s.id, 'DELETE'); } }),
           h('button', { type: 'button', className: 'btn btn-small cs-revoke-cancel', text: 'Cancel', 'aria-describedby': revokeNoteId(s), onclick: () => cancelRevoke(s) })]
        : [s.needs_relink === true ? h('button', { type: 'button', className: 'btn btn-small btn-primary cs-relink', text: RELINK_BUTTON, 'aria-label': `${RELINK_BUTTON} for ${s.label || 'this server'}: how to confirm it`, 'aria-expanded': String(relinkOpen.has(s.id)), 'aria-controls': relinkId(s),
               onclick: () => { if (relinkOpen.has(s.id)) relinkOpen.delete(s.id); else relinkOpen.add(s.id); render(); focusRow(s.id, '.cs-relink'); } }) : null,
           h('button', { type: 'button', className: 'btn btn-small cs-rename-btn', text: 'Rename', 'aria-label': `Rename ${s.label || 'this server'}`, disabled: isBusy, onclick: () => { renaming = s.id; render(); } }),
           // Revoke is a More away: the row shows Rename, and the rare, destructive step is in a small menu of its own (Escape and a click elsewhere close it).
           h('div', { className: 'cs-more', onkeydown: e => { if (e.key === 'Escape' && moreOpen === s.id) { e.preventDefault(); e.stopPropagation(); moreOpen = null; render(); focusRow(s.id, '.cs-more-btn'); } } },
               h('button', { type: 'button', className: 'btn btn-small cs-more-btn', text: 'More', 'aria-label': `More for ${s.label || 'this server'}`, 'aria-expanded': String(moreOpen === s.id), 'aria-controls': `${rowId(s.id)}-more`,
                   onclick: () => { moreOpen = moreOpen === s.id ? null : s.id; render(); focusRow(s.id, '.cs-more-btn'); } }),
               h('div', { className: 'cs-more-menu', id: `${rowId(s.id)}-more`, hidden: moreOpen !== s.id },
                   h('button', { type: 'button', className: 'btn btn-small btn-quiet btn-danger cs-revoke', text: 'Revoke', 'aria-label': `Revoke ${s.label || 'this server'}`, disabled: isBusy, onclick: () => askRevoke(s) })))];
}

function detailCell(s, live, online, isBusy, helpId) {
    const local = rank(s.local_mode) >= 0 ? s.local_mode : null;
    const effective = effectiveOf(s);
    // What the computer allows, and (only when lower than the choice) what applies; the select is described by this line.
    const help = local ? launchNote(s) : 'View until this computer connects.';
    // Keep the consequence and the local limit beside the control. The full capability matrix is optional.
    const consequence = effective === 'view' ? (help ? '' : 'Read-only access.') : (local ? 'Can run commands on this computer.' : '');
    const helpEl = h('div', { className: 'cs-meta cs-access-help', id: helpId, text: [help, consequence].filter(Boolean).join(' ') });
    const infoId = `${rowId(s.id)}-access-details`;
    const infoOpen = accessDetails.has(s.id);
    const info = h('div', { className: 'cs-access-details' },
        h('button', { type: 'button', className: 'btn btn-small cs-access-info', 'aria-label': `Access details for ${s.label || 'this server'}`, 'aria-expanded': String(infoOpen), 'aria-controls': infoId,
            onclick: () => { if (accessDetails.has(s.id)) accessDetails.delete(s.id); else accessDetails.add(s.id); render(); } },
            h('span', { className: 'material-icons', 'aria-hidden': 'true', text: 'info' }), 'Access details'),
        h('div', { id: infoId, className: 'cs-access-matrix', hidden: !infoOpen },
            h('p', { text: 'What Coral Hub may do on a machine is what you allowed when you connected it; you can limit it further here.' }),
            ...MODES.map(mode => h('p', {}, h('strong', { text: `${MODE_INFO[mode].label}: ` }), MODE_INFO[mode].text))));
    const eff = effectiveNote(s);
    const effEl = eff ? h('div', { className: 'cs-meta cs-access-effective', text: eff }) : null;
    const update = updateNotice(live);
    const updateNote = update
        ? h('div', { className: `cs-note cs-update cs-update-${update.level}` },
            h('span', { text: update.text + ' ' }),
            h('a', { href: RELEASES_URL, target: '_blank', rel: 'noopener noreferrer', text: 'Download the latest Coral' }))
        : null;
    // The row shows the status and the version; the details add only what it does not: when an offline machine was last heard from.
    const meta = online ? null : h('div', { className: 'cs-meta cs-lastseen', text: `Last contact ${formatLastSeen(s.last_seen)}` });
    return h('div', { className: 'cs-detail-cell' },
        s.needs_relink === true ? h('div', { className: 'cs-note cs-relink-note', id: relinkId(s), hidden: !relinkOpen.has(s.id), text: relinkHelp(s.label) }) : null,
        h('div', { className: 'cs-main' }, meta, belowMinimumText(live) ? h('div', { className: 'cs-meta server-below-minimum', text: belowMinimumText(live) }) : null,
            online ? healthCard(live.machine_health, { title: 'Health', online: true, waitingText: 'No health reading yet.' }) : null, effEl, helpEl, info),
        confirming === s.id ? h('div', { className: 'cs-note', id: revokeNoteId(s), text: `Revoke ${s.label || 'this server'}? It disconnects this computer from Coral Hub. Its token stops working; to connect it again you must enroll it again.` }) : null,
        updateNote);
}

/** Whether a machine's row is open: the person opened it, or something in it needs to be seen (a rename, the revoke question, the relink help). */
const isOpenRow = s => expanded.has(s.id) || renaming === s.id || confirming === s.id || (s.needs_relink === true && relinkOpen.has(s.id));

/** The machines as one dataTable: the columns and the detail row are the table's; a cell holds the controls it always did (the toggle, the access select, Rename and More). Every row has the id deep links and the redraw's focus keep use. */
function serversTable(shown) {
    const live = s => liveOf(s);
    const cellOf = {
        name: s => { const id = rowId(s.id); return nameCell(s, live(s), s.online === true, isOpenRow(s), `${id}-detail`); },
        status: s => (s.online === true ? 'Online' : 'Offline'),
        version: s => { const v = serverVersion(live(s)), upd = updateBadge(live(s)), f = document.createDocumentFragment(); f.append(h('span', { text: v ? v : '—' })); if (upd) f.append(' ', upd); return f; },
        agents: s => String(serverAgentCount(live(s))),
        access: s => accessPicker(s, busy.has(s.id), `${rowId(s.id)}-access-help`),
        actions: s => h('div', { className: 'cs-actions' }, rowActions(s, busy.has(s.id))),
    };
    return buildServersTable(DT, {
        label: 'Your computers', state: dtState, rows: shown, rowKey: s => s.id, rowName: s => s.label || 'Unnamed server',
        columns: [
            { key: 'name', label: 'Name', primary: true, width: 'grow', line: 1, sort: true, sortValue: s => sortValue(s, 'name'), cell: cellOf.name },
            { key: 'status', label: 'Status', line: 2, sort: true, sortValue: s => sortValue(s, 'status'), cell: cellOf.status },
            { key: 'version', label: 'Coral', line: 2, sort: (a, b) => cmpVersion(sortValue(a, 'version'), sortValue(b, 'version')), cell: cellOf.version },
            { key: 'agents', label: 'Agents', line: 2, align: 'end', sort: 'number', firstDir: 'desc', sortValue: s => sortValue(s, 'agents'), cell: cellOf.agents },
            { key: 'access', label: 'Hub access', line: 2, sort: 'number', firstDir: 'desc', sortValue: s => sortValue(s, 'access'), cell: cellOf.access },
            { key: 'actions', label: 'Actions', line: 1, cell: cellOf.actions },
        ],
        detail: { id: s => `${rowId(s.id)}-detail`, open: isOpenRow, render: s => detailCell(s, live(s), s.online === true, busy.has(s.id), `${rowId(s.id)}-access-help`) },
        // The names the deep links, the focus keep and the suites read: the table keeps its own classes, these are hooks only (no rule in any stylesheet); they are put back whenever a sort draws the rows again.
        decorateHead: (th, c) => { th.classList.add('cs-th', `cs-col-${c.key}`); th.querySelector('.dt-sort')?.classList.add('cs-sort'); },
        decorate: (s, tr, detail) => {
            tr.dataset.id = s.id; tr.classList.add('cs-row'); tr.classList.toggle('cs-open', isOpenRow(s));
            for (const td of tr.querySelectorAll('td.dt-td')) td.classList.add(`cs-col-${td.dataset.key}`);
            if (detail) detail.classList.add('cs-detail');
            const escape = e => { if (e.key === 'Escape' && confirming === s.id) { e.preventDefault(); e.stopPropagation(); cancelRevoke(s); } };
            tr.addEventListener('keydown', escape); if (detail) detail.addEventListener('keydown', escape);
        },
    }, { rowId: s => rowId(s.id), tableClass: 'cs-table' });
}


/** The steps to add a machine, with the download link and what the person will see on that computer. */
function enrollBlock() {
    const open = enrollOpen ?? (loaded && servers.length === 0);
    const input = h('input', { type: 'text', className: 'cloud-code', placeholder: 'XXXX-XXXX', value: enrollCode, maxLength: 9, autocomplete: 'off', spellcheck: false, 'aria-label': 'Enrollment code', id: 'cs-enroll-code', oninput: e => { enrollCode = e.target.value; } });
    const go = () => {
        const v = input.value.trim().toUpperCase();
        location.href = '/enroll' + (v ? '?code=' + encodeURIComponent(v) : '');
    };
    const shot = theme => h('img', { className: `cs-shot cs-shot-${theme}`, src: new URL(theme === 'dark' ? './hub-img/connect-question-dark.png' : './hub-img/connect-question-light.png', import.meta.url).pathname, width: 520, height: 636, loading: 'lazy',
        alt: theme === 'dark' ? 'Coral\'s Connect to Coral Hub screen asking "What may Coral Hub do on this computer?" with View, Interact and Launch, Launch selected, and a Connect button.' : '' });
    // The light picture carries the alt text through its sibling: one description, one picture shown per theme (css).
    const lightShot = shot('light'); lightShot.alt = shot('dark').alt;
    return h('section', { className: 'cs-enroll' + (open ? '' : ' cs-enroll-closed'), id: 'cs-add-machine', 'aria-labelledby': 'cs-enroll-title' },
        h('h3', { className: 'cs-enroll-title', id: 'cs-enroll-title' },
            h('button', { type: 'button', id: 'cs-enroll-toggle', className: open ? 'btn btn-small' : 'btn btn-primary btn-small', 'aria-expanded': String(open), 'aria-controls': 'cs-enroll-body', onclick: () => { enrollOpen = !open; render(); } }, 'Add a computer')),
        h('div', { className: 'cs-enroll-body', id: 'cs-enroll-body', hidden: !open },
            h('div', { className: 'cs-enroll-steps' },
                h('p', { className: 'cs-meta', text: 'Each machine connects out to this hub; no inbound port is needed.' }),
                h('ol', {},
                    h('li', {}, h('strong', { text: 'Install Coral' }), ' on the computer you want to add: ', h('a', { href: DOWNLOAD_URL, target: '_blank', rel: 'noopener noreferrer', text: 'coralhub.dev/coral.html#download' })),
                    h('li', {}, 'Open Coral on that computer and press ', h('strong', { text: 'Connect to Coral Hub' }), ' (Settings › Network and Hub, or the Coral Hub card on the home screen).'),
                    h('li', {}, 'Choose what Coral Hub may do on that computer, then press ', h('strong', { text: 'Connect' }), '. Coral shows a short code.'),
                    h('li', {}, 'Enter the code here, check the computer\'s details on the next page and approve.')),
                h('form', { className: 'cs-enroll-form', onsubmit: e => { e.preventDefault(); go(); } }, input,
                    h('button', { type: 'submit', className: 'btn btn-primary', text: 'Continue' }))),
            h('div', { className: 'cs-shots' }, shot('dark'), lightShot)));
}

/** The DOM id of a server's row, for deep links. */
 function rowId(id) { return 'server-row-' + String(id).replace(/[^A-Za-z0-9_-]/g, '_'); }

function render() {
    if (!host) return;
    // Re-rendering replaces every row: keep focus on the same control where we can.
    const active = document.activeElement && host.contains(document.activeElement) ? document.activeElement : null;
    const keepRow = active && active.closest('.dt-row, .dt-detail');
    const keep = keepRow ? { row: keepRow.id, text: active.textContent, cls: active.className, tag: active.tagName } : null;
    syncServersBar(servers, 'machine', render); // the search box, from six machines up
    // the order the table's sort keeps for equal values: the name, then the id
    const shown = servers.filter(serverVisible).sort((a, b) => String(a.label || '').toLowerCase().localeCompare(String(b.label || '').toLowerCase()) || String(a.id).localeCompare(String(b.id)));
    const table = shown.length
        ? serversTable(shown)
        : h('p', { className: 'empty-state empty-state-tight', text: loadError ? '' : serversFiltered() ? 'No computers match this search.' : 'No computers connected yet.' });
    // replaceChildren() would render a null as the text "null": leave it out.
    const restoreFocus = rememberFocus(host); // a control the redraw replaced gets focus back (#4882)
    host.replaceChildren(...[
        enrollBlock(),
        loadError ? h('div', { className: 'servers-form-error', role: 'alert', text: loadError }) : null,
        table].filter(Boolean));
    restoreFocus();
    if (keep) {
        const r = document.getElementById(keep.row);
        const again = r && [...r.querySelectorAll('button, select, input')].find(el => el.textContent === keep.text && el.className === keep.cls);
        if (again) again.focus(); else if (r) (r.querySelector('.cs-toggle') || r).focus();
    }
}
