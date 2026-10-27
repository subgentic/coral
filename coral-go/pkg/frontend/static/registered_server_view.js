const { liveServer: liveOf, buildServersTable } = await importOnce('./server_table.js');
/* Servers settings view (multi-server hub).
 *
 * A self-contained dialog, built on demand, to list / add / edit / test /
 * remove the remote Coral servers the hub talks to. Everything here is
 * hub-local (/api/servers*, never proxied) and gated on isHub(). The remote
 * API key is write-only: it is sent on add/edit and never rendered, echoed,
 * logged or kept after the request completes. */

import { rememberFocus } from './dom_morph.js';
import { importOnce } from './import_once.js';
import { state } from './state.js';
import { sessionServer } from './server_base.js';
import { needsInputAttention } from './display_activity_hint.js';
import { showToast } from './utils.js';
import { mountSettingsView } from './settings_view.js'; // the add and edit form (a startup module)
import {
    statusMeta, escHtml, describeServerError, formatLastSeen, isValidServerId,
    serverVersion, serverAgentCount, updateBadgeHtml, belowMinimumText,
} from './server_status.js';
import { syncServersBar, serverVisible, serversFiltered } from './server_search.js'; // this module is in the startup graph (app.js imports it), so its search box is imported directly

let DT = null;            // the shared table (data_table.js): loaded when the tab opens, this module is in the startup graph
let _dt = null;           // its sort, kept across redraws
let _servers = [];
let _editing = null;      // id being edited, '' for "add", null when the form is closed
let _confirmDelete = null;
let _open = null;         // the id whose page is open (a server's page: facts, and Test, Edit and Remove in its pinned bar), null for the table
let _focusNext = null;    // 'back' | 'row': where the focus goes after the next draw (opening a page, coming back)
let _busy = new Set();    // ids (or '*') with a request in flight
let _loadError = '';
let _formError = '';
let _draft = null;        // non-secret field values kept across a failed submit
let _host = null;         // the Servers tab body (#3070); there is no separate dialog

let load;
export const serverView = {
    async mount(el, refresh) {
        load = refresh;
        if (_host !== el) el.addEventListener('click', onClick);
        _host = el;
        DT ||= await importOnce('./data_table.js'); _dt ||= DT.tableState();
        _editing = null; _draft = null; _confirmDelete = null; _formError = ''; _loadError = ''; _open = null;
    },
    leave() {
        _editing = null; _open = null;
        const title = document.getElementById('servers-tab-title'); if (title) title.hidden = false;
        const v = document.getElementById('servers-view'); if (v) v.classList.remove('servers-view-page');
    },
    canRefresh: () => _editing === null && !_busy.size,
    accept: rows => { _servers = rows; _loadError = ''; },
    fail: error => { _loadError = error; },
    render,
};

// A refused URL (the server's 400 for an http URL at an address that is not private) is shown next to the URL field.
let _urlError = '';

async function readBody(resp) {
    try { return await resp.json(); } catch { return {}; }
}

function statusPill(status) {
    const m = statusMeta(status);
    return `<span class="server-status server-${m.cls}" title="${escHtml(m.hint)}"><span class="server-dot" aria-hidden="true"></span>${escHtml(m.label)}</span>`;
}

/** The server's warning for a registered server (a plain-http URL at an address that is not this computer: the API key crosses the network
 *  unencrypted), as an icon and words, not only a colour: "Warning: The key crosses the network unencrypted; use https or a tunnel." */
function warningHtml(text, cls = '') {
    const t = String(text || '').trim();
    if (!t) return '';
    return `<div class="servers-row-warn ${cls}"><span class="material-icons" aria-hidden="true">warning</span><span><b>Warning:</b> ${escHtml(t.charAt(0).toUpperCase() + t.slice(1))}${/[.!?]$/.test(t) ? '' : '.'}</span></div>`;
}

/** What the registry and the live list know about a remote server, as one object. */

function agentsText(n) { return `${n} agent${n === 1 ? '' : 's'}`; }

/** The status in the table: a dot and one word, no pill (UI/UX #9679): the dot is the only colour, Offline and the rest are secondary text; the hint is its tooltip. */
function statusDotWord(status) {
    const m = statusMeta(status);
    const wrap = DT.el('span', `servers-status servers-status-${m.cls || 'offline'}`);
    const dot = DT.el('i', 'servers-status-dot'); dot.setAttribute('aria-hidden', 'true');
    wrap.append(dot, DT.el('span', 'servers-status-word', m.label));
    if (m.hint) wrap.title = m.hint;
    return wrap;
}

const isLocal = s => !!(s.local || s.id === 'local');
/** A server's name cell: this hub is plain text (it has no page), a remote server is the row's one button (it opens the server's page). One line (Goal #79): its id, the private-network mark and the warning are the Tags column's, its version the Version column's. */
function serverCell(s) {
    if (isLocal(s)) return DT.el('span', 'dt-name-text', s.label || 'This computer');
    const b = DT.primaryButton(s.label || s.id, `Open ${s.label || s.id}`);
    const wrap = DT.el('span', 'servers-name'); wrap.append(DT.el('span', 'dt-name-text servers-name-text', s.label || s.id)); b.replaceChildren(wrap);
    if (!isLocal(s) && s.warning) { const t = DT.tag('warning'); t.classList.add('servers-warn'); t.title = String(s.warning); const g = DT.el('span', 'material-icons servers-warn-icon', 'warning'); g.setAttribute('aria-hidden', 'true'); t.textContent = ''; t.append(g, DT.el('span', 'servers-warn-word', 'warning')); wrap.append(t); b.setAttribute('aria-label', `Open ${s.label || s.id}, warning: ${s.warning}`); } // the unencrypted-key warning stays on the row at every width (#9679), by the name, not in a column a narrow list drops; a narrow list keeps its glyph and drops the word (the name wins the width), the sentence is the tag's tooltip and the button's name
    b.title = s.label || s.id;
    b.dataset.action = 'open'; b.dataset.id = s.id; // the tab's click handler opens the server's page
    return b;
}
/** The tags of a server in one cell: this hub's "local" or a remote server's id and the private-network mark (the warning flag is in the name's cell: it never drops). */
function tagsCell(s) {
    const cell = DT.el('span', 'dt-title-cell');
    cell.append(DT.tag(isLocal(s) ? 'local' : s.id));
    if (!isLocal(s) && s.allow_private) { const t = DT.tag('private network'); t.title = 'Private network addresses are allowed for this server'; cell.append(t); }
    return cell;
}
/** The version a server runs: this hub's own, or what the registered server reported (its version row on the page says more). */
const versionWords = (s, live) => (isLocal(s) ? (state.localVersion ? `Coral ${state.localVersion}` : '') : (serverVersion(live) ? `Coral ${serverVersion(live)}` : ''));

/** Agents of a server waiting for their person (the Inbox's Needs you, counted from the live list per server: no new route). */
const needsCount = s => (state.liveSessions || []).filter(x => x && needsInputAttention(x) && sessionServer(x) === (isLocal(s) ? 'local' : s.id)).length; // the Inbox's own test (inbox_sidebar.js waitingSessions): a session the screen says is working is not waiting for the person
const isOnline = (s, live) => (live.status || s.status) === 'online';
/** Last seen: "now" while the server is online, else when it last answered (the words the server's page uses). */
const seenWords = (s, live) => (isLocal(s) || isOnline(s, live) ? 'now' : formatLastSeen(s.last_seen));
const seenValue = (s, live) => (isLocal(s) || isOnline(s, live) ? Number.MAX_SAFE_INTEGER : (Date.parse(s.last_seen) || 0));

/** This hub and the registered servers as one data_table (Server, Status, Agents): the sort is kept across redraws and every row has the id the tab's focus handling looks for. */
function serversTable(local, remotes) {
    const rows = [local, ...remotes];
    const live = s => (isLocal(s) ? { id: 'local', status: 'online' } : liveOf(s));
    return buildServersTable(DT, {
        label: 'Registered servers', state: _dt, rows, oneLine: true, rowKey: s => (isLocal(s) ? 'local' : s.id), rowName: s => s.label || s.id,
        columns: [ // one line a row (Goal #79, UI/UX's order #9679): Server, Tags, Status, Agents, Needs you, Last seen, Version; a narrow list drops Version, then Tags and Last seen, then Agents (dropAt, #8931); the name's warning never goes and Needs you only under 16 rem (a phone at 200% text: three columns do not fit 12 rem)
            { key: 'server', label: 'Server', primary: true, width: 'grow', sort: true, sortValue: s => (s.label || s.id || '').toLowerCase(), cell: serverCell, title: s => s.label || s.id },
            { key: 'tags', label: 'Tags', width: '11rem', dropAt: 36, cell: tagsCell },
            { key: 'status', label: 'Status', width: '8rem', sort: true, sortValue: s => statusMeta(live(s).status || s.status).label, cell: s => statusDotWord(live(s).status || s.status) },
            { key: 'agents', label: 'Agents', width: '5rem', dropAt: 28, tone: 'tertiary', align: 'end', sort: 'number', sortValue: s => serverAgentCount(live(s)), cell: s => { const n = serverAgentCount(live(s)); return n ? String(n) : ''; } }, // the count alone under its header, nothing at zero (UI/UX #9679)
            { key: 'needs', label: 'Needs you', width: '6rem', dropAt: 16, align: 'end', sort: 'number', firstDir: 'desc', sortValue: needsCount, cell: s => { const n = needsCount(s); if (!n) return ''; const e = DT.el('span', 'servers-needs', String(n)); e.title = `${n} agent${n === 1 ? '' : 's'} waiting for you`; return e; } },
            { key: 'seen', label: 'Last seen', width: '6rem', dropAt: 36, tone: 'tertiary', sort: 'date', firstDir: 'desc', sortValue: s => seenValue(s, live(s)), cell: s => seenWords(s, live(s)) },
            { key: 'version', label: 'Version', width: '7.5rem', dropAt: 52, tone: 'tertiary', sort: true, sortValue: s => versionWords(s, live(s)), cell: s => versionWords(s, live(s)) || '\u2014' },
        ],
        open: s => { if (!isLocal(s)) { _open = s.id; _confirmDelete = null; _focusNext = 'back'; render(); } },
    }, { rowId: s => `server-row-${isLocal(s) ? 'local' : s.id}` });
}

/** A fact of the server's page: a label (13/500) and its value (13/400). */
function factHtml(label, value) {
    return value ? `<div class="servers-fact"><dt>${escHtml(label)}</dt><dd>${value}</dd></div>` : '';
}

/** A server's page: its facts, what to do about a problem, and Test, Edit and Remove in a bar pinned at its foot (Remove the danger button, the primary last). */
function pageHtml(s) {
    const live = liveOf(s);
    const busy = _busy.has(s.id);
    const confirming = _confirmDelete === s.id;
    const status = live.status || s.status;
    const version = serverVersion(live);
    const agents = serverAgentCount(live);
    const badge = updateBadgeHtml(live);
    const below = belowMinimumText(live); // the Hub's "Update Coral to <min>" hint (#3915), plain text
    // One line says what to do; the raw error is behind Details, for support (#3981).
    const act = (s.status === 'key_unreadable' || s.status === 'unauthorized')
        ? statusMeta(s.status).hint
        : s.status === 'unreachable' ? 'Is Coral running on that machine? Check the URL.' : '';
    const raw = s.last_error && s.last_error !== act ? s.last_error : '';
    const attention = act
        ? `<div class="servers-row-error" role="status"><span class="servers-row-hint">${escHtml(act)}</span>${raw ? ` <details class="servers-row-detail"><summary>Details</summary>${escHtml(raw)}</details>` : ''}</div>`
        : raw ? `<div class="servers-row-error" role="status">${escHtml(raw)}</div>` : '';
    // An online server's status is live from the feed; 'last contact' (refreshed about once a minute) is shown only once it is not online (#3152).
    const contact = status !== 'online' ? formatLastSeen(s.last_seen) : '';
    const bar = confirming
        ? `<button type="button" class="btn" data-action="delete-cancel">Cancel</button>
           <button type="button" class="btn btn-danger" data-action="delete-confirm" data-id="${escHtml(s.id)}">Confirm remove</button>`
        : `<button type="button" class="btn" data-action="test" data-id="${escHtml(s.id)}"${busy ? ' disabled aria-busy="true"' : ''}>${busy ? 'Testing...' : 'Test'}</button>
           <button type="button" class="btn" data-action="edit" data-id="${escHtml(s.id)}"${busy ? ' disabled' : ''}>Edit</button>
           <button type="button" class="btn btn-danger servers-remove" data-action="delete" data-id="${escHtml(s.id)}"${busy ? ' disabled' : ''}>Remove</button>`;
    return `<section class="servers-page" id="server-row-${escHtml(s.id)}" tabindex="-1" data-id="${escHtml(s.id)}" aria-labelledby="servers-page-name">
        <button type="button" class="back-link" id="servers-back" data-action="back">&larr; Servers</button>
        <h3 class="servers-page-name" id="servers-page-name">${escHtml(s.label || s.id)} <span class="servers-id">${escHtml(s.id)}</span>${s.allow_private ? ' <span class="chip chip-tag servers-tag" title="Private network addresses are allowed for this server">private network</span>' : ''}</h3>
        <p class="item-meta">${statusPill(status)}</p>
        <dl class="facts servers-facts">
            ${factHtml('URL', escHtml(s.url || ''))}
            ${factHtml('Coral', `${escHtml(version ? `Coral ${version}` : 'Not known yet')}${badge ? ' ' + badge : ''}`)}
            ${factHtml('Agents', escHtml(agentsText(agents)))}
            ${factHtml('Last contact', escHtml(contact))}
        </dl>
        ${warningHtml(s.warning)}
        ${below ? `<div class="servers-row-hint server-below-minimum">${escHtml(below)}</div>` : ''}
        ${attention}
        <div class="item-bar servers-page-bar">${bar}</div>
    </section>`;
}

function formHtml() {
    const adding = _editing === '';
    const cur = { ...(adding ? {} : (_servers.find(s => s.id === _editing) || {})), ...(_draft || {}) };
    const title = adding ? 'Add server' : `Edit ${escHtml(cur.label || cur.id || '')}`;
    return `<div class="servers-form" id="servers-form">
        <h4>${title}</h4>
        ${adding ? '' : warningHtml((_servers.find(x => x.id === _editing) || {}).warning)}
        <div id="servers-form-host"></div>
    </div>`;
}

let _formView = null;     // the add and edit form (settings_view in form mode), drawn into the page after each render of it

/** The form of the page being drawn (settings_view in form mode): the id, the name, the URL, the write-only key and the private-address switch. */
function mountServerForm(host) {
    const adding = _editing === '';
    const cur = { ...(adding ? {} : (_servers.find(s => s.id === _editing) || {})), ...(_draft || {}) };
    const fields = [
        { key: 'id', type: 'text', id: 'servers-id', label: 'Server id', required: adding, requiredMessage: 'Enter the server id.', readOnly: !adding, placeholder: 'workstation', help: 'Lowercase letters, digits and dashes. Cannot be changed later.',
            validate: v => (adding && !isValidServerId(String(v || '').trim()) ? 'Server id must be 1 to 32 lowercase letters, digits or dashes, and cannot be "local".' : ''), messageAsIs: true, attrs: { maxlength: '32' } },
        { key: 'label', type: 'text', id: 'servers-label', label: 'Display name', placeholder: 'Workstation' },
        { key: 'url', type: 'text', id: 'servers-url', label: 'URL', required: adding, requiredMessage: 'Enter the server URL.', placeholder: 'https://coral.example.com:8420', help: 'Scheme, host and port only.', setup: e => e.setAttribute('type', 'url') },
        { key: 'api_key', type: 'secret', id: 'servers-key', label: 'API key', required: adding, requiredMessage: "Enter the remote server's API key.", messageAsIs: true,
            placeholder: adding ? "Paste the remote server's API key" : 'Leave blank to keep the current key', help: 'Write-only. The key is stored encrypted and is never shown again.', setup: e => e.setAttribute('autocomplete', 'new-password') },
        { key: 'allow_private', type: 'toggle', id: 'servers-private', label: 'Allow private network address', default: false,
            help: { text: 'Only for a server on your LAN, tailnet or localhost that you trust.', more: 'It lets this hub connect to private and reserved addresses, which is normally refused. Leave it off for a server on the public internet.' } },
    ];
    _formView = mountSettingsView(host, { mode: 'form', fields, words: { busy: 'Checking connection...', failed: '' },
        form: { submit: adding ? 'Add server' : 'Save', cancel: 'Cancel', onSubmit: submitServerForm, onCancel: () => { _editing = null; _formError = ''; _urlError = ''; _draft = null; render(); } } });
    for (const k of ['id', 'label', 'url']) if (cur[k] !== undefined) _formView.set(k, cur[k]);
    _formView.set('allow_private', !!cur.allow_private);
    if (_urlError) _formView.error('url', _urlError);
    if (_formError) _formView.say(_formError, true);
    _formView.focus(_urlError ? 'url' : adding ? 'id' : 'label');
}

function render() {
    const m = _host;
    if (!m) return;
    const allRemotes = _servers.filter(s => !(s.local || s.id === 'local'));
    syncServersBar(allRemotes, 'server', render); // the search box, from six servers up
    const remotes = allRemotes.filter(serverVisible);
    const local = _servers.find(s => s.local || s.id === 'local') || { local: true, id: 'local', label: 'This computer' };
    // The periodic refresh must not pull focus out of a row the user is on.
    const activeRow = document.activeElement && m.contains(document.activeElement) ? document.activeElement.closest('.dt-row, .servers-page') : null;
    const keep = activeRow && _editing === null ? { row: activeRow.id, action: document.activeElement.dataset.action } : null;
    const page = _open ? _servers.find(x => x.id === _open && !(x.local || x.id === 'local')) : null;
    if (_open && !page && _servers.length) _open = null; // the server is gone (removed here or elsewhere): back to the table
    // A long list pushes "Add server" screens below the fold: with many machines it sits above the list, beside how many answer.
    const many = allRemotes.length > 5;
    const online = allRemotes.filter(s => s.status === 'online').length;
    const topBar = `<div class="servers-top"><span class="servers-summary">${allRemotes.length} servers, ${online} online${online < allRemotes.length ? `, ${allRemotes.length - online} not` : ''}</span><button type="button" class="btn btn-primary" data-action="add">Add server</button></div>`;
    const restoreFocus = rememberFocus(m); // a control the redraw replaced (Add server, Test, Edit) gets focus back (#4882)
    const table = '<div id="servers-table-slot"></div>'; // the data_table goes in once the markup is set
    const back = '<button type="button" class="back-link" id="servers-back" data-action="back">&larr; Servers</button>';
    const body = _open && page
        ? (_editing === _open ? `<section class="servers-page" id="server-row-${escHtml(_open)}" tabindex="-1" data-id="${escHtml(_open)}">${back}${formHtml()}</section>` : pageHtml(page))
        : `${many && _editing === null ? topBar : ''}
            ${table}
            ${!remotes.length && !_loadError ? `<p class="empty-state empty-state-tight">${serversFiltered() ? 'No servers match this search.' : 'No remote servers yet.'}</p>` : ''}
            ${_editing !== null ? formHtml() : many ? '' : '<div class="servers-form-actions"><button type="button" class="btn btn-primary" data-action="add">Add server</button></div>'}`;
    m.innerHTML = `${_open && page ? '' : '<div class="servers-intro"><p class="servers-intro-line">Servers whose agents and teams appear in this hub.</p><details class="servers-intro-more"><summary>About API keys</summary><p>The hub stores each server\'s API key (encrypted); a key grants full control of that server.</p></details></div>'}
            ${_loadError ? `<div class="servers-form-error" role="alert">${escHtml(_loadError)}</div>` : ''}
            ${body}`;
    const slot = m.querySelector('#servers-table-slot');
    if (slot) slot.replaceWith(serversTable(local, remotes));
    const title = document.getElementById('servers-tab-title');
    if (title) title.hidden = !!(_open && page); // a server's page has its back link, "← Servers", for the title
    const view = document.getElementById('servers-view'); if (view) view.classList.toggle('servers-view-page', !!(_open && page)); // a class, not a :has() rule: the view fills its height when a page is open
    restoreFocus();
    if (keep) {
        const r = document.getElementById(keep.row);
        const again = r && (keep.action ? r.querySelector(`[data-action="${keep.action}"]`) : null);
        if (again) again.focus(); else if (r) r.focus();
    }
    if (_focusNext) {
        const where = _focusNext; _focusNext = null;
        const el = where === 'back' ? document.getElementById('servers-back') : (m.querySelector(`.dt-row[data-key="${CSS.escape(where)}"] [data-action="open"]`) || m.querySelector('.dt-table'));
        if (el) el.focus();
    }
    if (_editing !== null) { const host = m.querySelector('#servers-form-host'); if (host) mountServerForm(host); }
}

function setBusy(id, on) { if (on) _busy.add(id); else _busy.delete(id); }

async function onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (action === 'open') { _open = id; _confirmDelete = null; _focusNext = 'back'; return render(); }
    if (action === 'back') { const was = _open; _open = null; _editing = null; _confirmDelete = null; _formError = ''; _urlError = ''; _draft = null; _focusNext = was || 'row'; return render(); }
    if (action === 'add') { _editing = ''; _formError = ''; _urlError = ''; _draft = null; return render(); }
    if (action === 'edit') { _editing = id; _formError = ''; _urlError = ''; _draft = null; _confirmDelete = null; return render(); }
    if (action === 'cancel-form') { _editing = null; _formError = ''; _urlError = ''; _draft = null; return render(); }
    if (action === 'delete') { _confirmDelete = id; return render(); }
    if (action === 'delete-cancel') { _confirmDelete = null; return render(); }
    if (action === 'delete-confirm') return doDelete(id);
    if (action === 'test') return doTest(id);
}

async function doTest(id) {
    setBusy(id, true); render();
    try {
        const resp = await fetch(`/api/servers/${encodeURIComponent(id)}/test`, { method: 'POST' });
        const body = await readBody(resp);
        if (!resp.ok) {
            _loadError = describeServerError(resp.status, body);
        } else {
            _loadError = '';
            const m = statusMeta(body.status);
            showToast(`${body.label || id}: ${m.label}`, body.status !== 'online');
        }
    } catch {
        _loadError = 'Test failed: could not reach the hub.';
    }
    setBusy(id, false);
    await load();
}

async function doDelete(id) {
    setBusy(id, true); _confirmDelete = null; render();
    try {
        const resp = await fetch(`/api/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!resp.ok) _loadError = describeServerError(resp.status, await readBody(resp));
        else { _loadError = ''; _open = null; _focusNext = 'row'; showToast('Server removed'); }
    } catch {
        _loadError = 'Remove failed: could not reach the hub.';
    }
    setBusy(id, false);
    await load();
}

async function submitServerForm(values) {
    const adding = _editing === '';
    const body = {};
    const id = String(values.id || '').trim();
    const url = String(values.url || '').trim();
    const label = String(values.label || '').trim();
    const key = String(values.api_key || '');
    const allowPrivate = !!values.allow_private;
    if (adding) {
        body.id = id; body.url = url; body.api_key = key;
        if (label) body.label = label;
        body.allow_private = allowPrivate;
    } else {
        const cur = _servers.find(s => s.id === _editing) || {};
        if (label && label !== cur.label) body.label = label;
        if (url && url !== cur.url) body.url = url;
        if (key.trim()) body.api_key = key;       // blank = keep the stored key
        if (allowPrivate !== !!cur.allow_private) body.allow_private = allowPrivate;
        if (!Object.keys(body).length) { _editing = null; render(); return; }
    }
    _draft = { id, label, url, allow_private: allowPrivate };
    _formView.set('api_key', ''); // drop the key from the DOM at once; it only lives in `body` for this request
    setBusy('*', true); _formError = ''; _urlError = '';
    let failure = '';
    try {
        const resp = await fetch(adding ? '/api/servers' : `/api/servers/${encodeURIComponent(_editing)}`, {
            method: adding ? 'POST' : 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await readBody(resp);
        if (!resp.ok) {
            const message = describeServerError(resp.status, data);
            if (resp.status === 400 && /\burl\b/i.test(data && data.error || '')) { _urlError = message; _formView.error('url', message); _formView.focus('url'); }
            failure = message;
        } else {
            _editing = null; _draft = null;
            showToast(adding ? 'Server added' : 'Server updated');
        }
    } catch {
        failure = 'Could not reach the hub. Try again.';
    }
    body.api_key = undefined;
    setBusy('*', false);
    if (failure) { _formError = failure; throw new Error(failure); } // said on the line beside the buttons
    await load();
}

