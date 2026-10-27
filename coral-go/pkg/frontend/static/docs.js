/* Documentation: browsable agent_docs viewer */

import { escapeHtml as esc, showView, showToast, renderDocsMarkdown, escapeAttr, copyText } from './utils.js';
import { registerActions, textOf } from './actions.js';
import { apiFetch } from './api.js';
import { loadHighlight } from './vendor_loader.js';
import { note, currentRoute } from './nav.js';
import { registerGroupSource, groupHeaderHtml, isGroupFolded, syncPaneGroupToggle, refreshGroupTable, openFirstGroupTable, setBackLink } from './sidebar_groups.js';
import { onViewShown } from './view_switch.js';
import { isPhoneLayout } from './phone_layout.js';
import { foldWayBack } from './way_back.js';
import { importOnce } from './import_once.js';

const DT = await importOnce('./data_table.js');
const docTableStates = new Map();

/** The line the "Copy docs line for agents" button copies: what a user pastes to an agent so it can read
 *  these docs. The agent prompt says the same (internal/agent DocsPromptLine; a Go test keeps them equal). */
export const DOCS_FOR_AGENTS = "Coral's docs for agents: run `coral-agent docs` to list the topics, `coral-agent docs <topic>` to read one (`coral-agent docs all` prints everything).";

let docsList = [];
let selectedDoc = null;
let wantedDoc = null; // a /docs/<name> page opened before the list loaded (#3532)
let docsQuery = '';   // the sidebar search's text, lower case

// ── Groups (#7443): Getting started and API ───────────────────────────
// The list the server sends has no groups; these topics are the ones a new reader starts with, every other topic is the API.
const GETTING_STARTED = new Set(['README', 'quickstart', 'using-the-dashboard', 'views', 'worked-demos', 'workflow-quickstart', 'troubleshooting']);
const DOC_GROUPS = [
    { key: 'getting-started', label: 'Getting started', has: d => GETTING_STARTED.has(d.name) },
    { key: 'api', label: 'API', has: d => !GETTING_STARTED.has(d.name) },
];
const titleOf = d => d.title || d.name;
const matches = d => !docsQuery || titleOf(d).toLowerCase().includes(docsQuery) || d.name.toLowerCase().includes(docsQuery);
const docGroups = () => DOC_GROUPS.map(g => ({ ...g, docs: docsList.filter(matches).filter(g.has) })).filter(g => g.docs.length);
const groupOfDoc = name => { const d = docsList.find(x => x.name === name); const g = d && DOC_GROUPS.find(x => x.has(d)); return g ? { key: g.key, label: g.label } : null; };

export function filterDocs(value) { docsQuery = String(value || '').trim().toLowerCase(); renderDocNav(); }

registerGroupSource('docs', {
    keys: () => docGroups().map(g => g.key),
    redraw: () => renderDocNav(),
    table: key => {
        const g = docGroups().find(x => x.key === key);
        if (!g) return null;
        if (!docTableStates.has(key)) docTableStates.set(key, DT.tableState());
        return { title: g.label, rows: g.docs, signature: JSON.stringify(g.docs),
            node: () => DT.dataTable({
                label: `${g.label} topics, ${g.docs.length}`, rows: g.docs,
                rowKey: d => d.name, rowName: titleOf, state: docTableStates.get(key),
                open: d => selectDoc(d.name, { focusHeading: true }),
                columns: [{ key: 'doc-name', label: 'Topic', primary: true, width: 'grow', line: 1, sort: true, sortValue: titleOf, cell: d => DT.primaryButton(titleOf(d)), subtitle: d => String(d.summary || '').trim() }],
            }).el,
            extra: { action: 'docs-copy-agent-line', label: 'Copy docs line for agents', icon: 'content_copy', title: 'Copies one line you can paste to an agent so it can read these docs' },
        };
    },
    isEmpty: () => false, // the tab opens its first table itself (showDocsTab)
    showList: () => { selectedDoc = null; window.switchNavTab?.('docs'); },
    empty: () => { selectedDoc = null; window.switchNavTab?.('docs'); },
});

// A group's table on screen is the page: no document is open (the sidebar's open row clears).
onViewShown(id => { if (id === 'group-table-view' && document.body.getAttribute('data-nav-tab') === 'docs' && selectedDoc) { selectedDoc = null; renderDocNav(); } });

/** One empty, loading or error line, the same size on every tab (14/400, with an optional hint). */
const emptyHtml = (line, hint = '') => `<div class="empty-state"><p class="empty-state-line">${esc(line)}</p>${hint ? `<p class="empty-state-hint">${esc(hint)}</p>` : ''}</div>`;

// ── Initialization ─────────────────────────────────────────────────────

export async function showDocsTab() {
    showView('docs-view');
    if (!docsList.length) { await loadDocsList(); return; }
    if (!selectedDoc && !isPhoneLayout()) openFirstGroupTable('docs'); // the tab opens on its first group's table; a phone shows the list
    syncPhonePage();
}

/** A phone's way back is on the title's line (#7751, the way every page has it, #7734): the button moves in front of the document's own heading, which is its title, and the pair share a row (way_back.js).
 *  The page redraws the document by replacing everything in it, which takes the button with it: it goes back to the toolbar then (a wide screen's, where css hides it). */
let phoneBack = null;
function keepPhoneBack(content) {
    if (phoneBack) return;
    phoneBack = document.getElementById('docs-phone-back');
    new MutationObserver(() => { if (phoneBack && !phoneBack.isConnected) document.getElementById('docs-back')?.after(phoneBack); }).observe(content, { childList: true });
}
function titleRow(content) {
    keepPhoneBack(content);
    const title = content.querySelector('h1');
    if (!phoneBack || !isPhoneLayout() || !title || title.parentElement !== content) return;
    title.before(phoneBack); foldWayBack(content, '#docs-phone-back', 'h1');
}

/** On a phone the list is the page and an open document is the screen after it (data-phone-item, docs.css). */
function syncPhonePage() {
    const view = document.getElementById('docs-view');
    if (!view) return;
    if (isPhoneLayout() && selectedDoc) view.setAttribute('data-phone-item', ''); else view.removeAttribute('data-phone-item');
}

/** Load the list; the document the page names opens, else a desktop opens the first group's table. A failed load shows an error with Retry instead of a blank page (#3152). */
async function loadDocsList() {
    const content = document.getElementById('docs-content');
    if (content) content.innerHTML = emptyHtml('Loading\u2026');
    const ok = await fetchDocsList();
    renderDocNav();
    if (!ok) {
        showDocsError('Could not load the documentation. Check the connection to Coral, then try again.', loadDocsList);
        return;
    }
    if (content) content.replaceChildren();
    const wanted = wantedDoc && docsList.find(d => d.name === wantedDoc);
    if (wantedDoc && !wanted) docNotFound();
    wantedDoc = null;
    if (wanted) selectDoc(wanted.name, { noteRoute: false });
    else if (!docsList.length) { if (content) content.innerHTML = emptyHtml('No documentation found.'); }
    else if (!isPhoneLayout()) openFirstGroupTable('docs');
    syncPhonePage();
}

/** An error in the content pane with a Retry button that calls retry. */
function showDocsError(message, retry) {
    const content = document.getElementById('docs-content');
    if (!content) return;
    const box = document.createElement('div');
    box.className = 'empty-state docs-error';
    box.setAttribute('role', 'alert');
    const p = document.createElement('p');
    p.className = 'empty-state-line';
    p.textContent = message;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-small';
    btn.textContent = 'Retry';
    btn.addEventListener('click', () => retry());
    box.append(p, btn);
    content.replaceChildren(box);
}

// ── API ────────────────────────────────────────────────────────────────

/** Fetch the docs list; false when it could not be loaded. */
async function fetchDocsList() {
    try {
        const list = await apiFetch('/api/agent-docs');
        docsList = Array.isArray(list) ? list : [];
        return Array.isArray(list);
    } catch (e) {
        console.error('Failed to fetch docs list:', e);
        docsList = [];
        return false;
    }
}

async function fetchDocContent(name) {
    try {
        return await apiFetch(`/api/agent-docs/${encodeURIComponent(name)}`);
    } catch (e) {
        console.error('Failed to fetch doc:', e);
        return null;
    }
}

// ── Nav rendering ──────────────────────────────────────────────────────

function renderDocNav() {
    const list = document.getElementById('docs-nav-list');
    if (!list) return;

    // The topics are one Tab stop (the open one, or the first shown), and the arrow keys move between them (#6586): 37 stops stood between the top bar and the page's text.
    const groups = docGroups();
    const shown = groups.filter(g => !isGroupFolded('docs', g.key)).flatMap(g => g.docs);
    const stop = shown.some(d => d.name === selectedDoc) ? selectedDoc : (shown[0] || {}).name;
    const row = d => `<li class="session-list-item${escapeAttr(selectedDoc === d.name ? ' active' : '')}"><button type="button" class="row-btn" tabindex="${Number(d.name === stop ? 0 : -1)}"${selectedDoc === d.name ? ' aria-current="true"' : ''} data-on-click="doc-open" data-doc="${escapeAttr(d.name)}" data-on-keydown="doc-open-key">${esc(titleOf(d))}</button></li>`;
    list.innerHTML = groups.map(g => groupHeaderHtml('docs', g.key, g.label, g.docs.length) + (isGroupFolded('docs', g.key) ? '' : g.docs.map(row).join(''))).join('')
        || (docsList.length ? '<li class="empty-state empty-state-tight">No topic matches the search.</li>' : '');
    syncPaneGroupToggle('docs');
    refreshGroupTable('docs');
}

/** Say which topic is showing, politely (the text changes under a reader without a word otherwise, #6586). */
function sayDocs(text) { const s = document.getElementById('docs-status'); if (s && s.textContent !== text) s.textContent = text; }

// ── Content rendering ──────────────────────────────────────────────────

/** A /docs/<name> page for a doc there isn't: say so, and the page is /docs (#3532, design 4.1). */
function docNotFound() {
    showToast('That document was not found', true);
    if (currentRoute()?.view === 'docs') note({ view: 'docs' }, { replace: true });
}

/** Show the doc a /docs[/<name>] page names (the router already wrote the page); /docs alone is the tab's own page. */
export function openDoc(name) {
    if (!docsList.length) { wantedDoc = name; return; } // loading (showDocsTab): it opens this one
    const doc = name && docsList.find(d => d.name === name);
    if (name && !doc) docNotFound();
    if (doc) { if (doc.name !== selectedDoc) selectDoc(doc.name, { noteRoute: false }); return; }
    if (!selectedDoc && !isPhoneLayout()) openFirstGroupTable('docs');
}

export async function selectDoc(name, { noteRoute = true, focusHeading = false } = {}) {
    const acted = focusHeading || isPhoneLayout() || !!document.activeElement?.closest?.('#docs-content'); // a person chose this page from a link, or on a phone from the list that is gone once it opens: they are told where they landed (#7162); a wide screen's sidebar keeps its focus
    selectedDoc = name;
    const hadFocus = !!document.activeElement?.closest?.('#docs-nav-list'); // the list is drawn again: focus goes back to the topic that was opened
    showView('docs-view'); // a group's table may be on screen: the document is the page now
    renderDocNav();
    if (hadFocus) [...document.querySelectorAll('#docs-nav-list [data-doc]')].find(e => e.dataset.doc === name)?.focus({ preventScroll: true });
    setBackLink('docs-back', 'docs', groupOfDoc(name)); // "← Getting started": the way back to its group's table
    syncPhonePage();
    if (noteRoute && currentRoute()?.view === 'docs') note({ view: 'docs', id: name });

    const content = document.getElementById('docs-content');
    if (!content) return;

    content.innerHTML = emptyHtml('Loading\u2026');

    const doc = await fetchDocContent(name);
    if (!doc || !doc.content) {
        showDocsError('Could not load this document. Check the connection to Coral, then try again.', () => selectDoc(name));
        return;
    }

    // Markdown through the dashboard's shared sanitizer and link policy (#3622 F4): a doc link is a
    // router link, a web link opens a new tab, anything else is text.
    const shown = docsList.find(d => d.name === name);
    sayDocs(`Showing ${shown ? titleOf(shown) : name}`);
    const html = renderDocsMarkdown(doc.content);
    if (html !== null) {
        content.innerHTML = html;
        wrapTables(content);
        focusableCode(content);
        titleRow(content);
    } else {
        // Fallback: pre-formatted text
        content.innerHTML = '<pre style="white-space:pre-wrap">' + esc(doc.content) + '</pre>';
    }

    const h1 = content.querySelector('h1');
    if (acted && h1) { h1.tabIndex = -1; h1.focus(); } // the new page's heading takes the focus (the link they pressed is gone with the old page)

    // Highlight code blocks once highlight.js has loaded (they show plain until
    // then, and stay plain if it cannot load).
    const blocks = content.querySelectorAll('pre code');
    if (blocks.length) loadHighlight().then(h => blocks.forEach(b => { if (b.isConnected) h.highlightElement(b); }), () => {});

}

/** The Docs page's "Copy docs line for agents" button (its action is registered in app.js: the button is in the page, this file loads with the Docs tab). */
export async function copyDocsLine() {
    if (await copyText(DOCS_FOR_AGENTS)) showToast('Copied');
    else showToast('Could not copy: select the text in the hint and copy it', true);
}

// ── Code blocks that scroll (#7751) ─────────────────────────────────────
/** A code block wider than the page scrolls inside its own box: a keyboard has to reach it to read the rest, so it is a labelled, focusable region while it scrolls (and plain while it does not: no tab stop for a short line). */
let codeWatched = false;
function focusableCode(content) {
    const sync = () => (document.getElementById('docs-content') || content).querySelectorAll('pre').forEach(pre => {
        const scrolls = pre.scrollWidth > pre.clientWidth + 1;
        if (scrolls) { pre.tabIndex = 0; pre.setAttribute('role', 'region'); pre.setAttribute('aria-label', 'Code, scrolls sideways'); }
        else { pre.removeAttribute('tabindex'); pre.removeAttribute('role'); pre.removeAttribute('aria-label'); }
    });
    sync(); requestAnimationFrame(sync);
    if (!codeWatched) { codeWatched = true; window.addEventListener('resize', sync); }
}
// ── Tables on a phone (#7162) ──────────────────────────────────────────

/** Each table sits in a labelled, focusable scroll region (a keyboard reaches what overflows) with a visible line that says it scrolls sideways, drawn only while it does. */
function wrapTables(content) {
    content.querySelectorAll('table').forEach((table, i) => {
        const wrap = document.createElement('div'); wrap.className = 'docs-table-wrap';
        wrap.tabIndex = 0; wrap.setAttribute('role', 'region');
        const first = (table.querySelector('th') || {}).textContent;
        wrap.setAttribute('aria-label', `Table ${i + 1}${first ? `: ${first.trim()}` : ''}, scrolls sideways`);
        const hint = document.createElement('p'); hint.className = 'docs-table-hint'; hint.hidden = true; hint.textContent = 'Scroll sideways to see every column';
        table.replaceWith(wrap); wrap.append(table);
        wrap.before(hint);
        const sync = () => { hint.hidden = !(wrap.scrollWidth > wrap.clientWidth + 1); };
        sync(); requestAnimationFrame(sync); window.addEventListener('resize', () => { if (wrap.isConnected) sync(); });
    });
}

// ── Helpers ────────────────────────────────────────────────────────────

// A doc in the Docs list (#3645).
registerActions({
    'doc-open': el => { const d = textOf(el.dataset.doc, 200); if (d) window.selectDoc(d); },
    'doc-open-key': (el, event) => {
        if (event.target === el && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { // between the topics: the one Tab stop goes with the focus (Enter and Space press the button itself)
            const all = [...document.querySelectorAll('#docs-nav-list [data-doc]')], at = all.indexOf(el);
            const to = event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : event.key === 'ArrowDown' ? (at + 1) % all.length : (at + all.length - 1) % all.length;
            event.preventDefault();
            all.forEach((e, i) => { e.tabIndex = i === to ? 0 : -1; });
            all[to].focus();
        }
    },
});

/** A phone's way from the open document back to the list of topics. */
export function docsPhoneBack() {
    selectedDoc = null;
    syncPhonePage();
    renderDocNav();
    document.querySelector('#docs-nav-list .row-btn')?.focus({ preventScroll: true });
}
