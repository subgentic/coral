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
import { menuMove } from './menu_keys.js';

const DT = await importOnce('./data_table.js');
const docTableStates = new Map();

/** The line the "Copy docs line for agents" button copies: what a user pastes to an agent so it can read
 *  these docs. The agent prompt says the same (internal/agent DocsPromptLine; a Go test keeps them equal). */
export const DOCS_FOR_AGENTS = "Coral's docs for agents: run `coral-agent docs` to list the topics, `coral-agent docs <topic>` to read one (`coral-agent docs all` prints everything).";

let docsList = [], docsLoaded = false; // docsLoaded: the list was read (an empty one is an answer, not a wait)
let selectedDoc = null;
let wantedDoc = null; // a /docs/<name> page opened before the list loaded (#3532)
let docsQuery = '';   // the sidebar search's text, lower case

// ── Groups (#7443, #10093): Getting started and For developers ────────────────
// The list the server sends has no groups; these topics are the ones a new reader starts with, in this order ("How do I...?" first, then Quickstart); every other topic, the API reference included, is for developers.
const GETTING_STARTED_ORDER = ['how-do-i', 'quickstart', 'using-the-dashboard', 'worked-demos', 'workflow-quickstart', 'troubleshooting'];
const GETTING_STARTED = new Set(GETTING_STARTED_ORDER);
const DOC_GROUPS = [
    { key: 'getting-started', label: 'Getting started', has: d => GETTING_STARTED.has(d.name), order: d => GETTING_STARTED_ORDER.indexOf(d.name) },
    { key: 'api', label: 'For developers', has: d => !GETTING_STARTED.has(d.name) },
];
const titleOf = d => d.title || d.name;
// The search reads the topics' text too (#9965: "add a member" found nothing because only titles were searched): each topic's text is read once, on the first search, and kept lower case.
const docText = new Map(), docRaw = new Map(); let docTextLoad = null, docTextReady = false; // docRaw: the text as written, for the snippet under a hit (#10093)
function loadDocText() {
    if (!docTextLoad) docTextLoad = Promise.all(docsList.map(async d => { const c = await fetchDocContent(d.name); if (c && c.content) { docRaw.set(d.name, String(c.content)); docText.set(d.name, String(c.content).toLowerCase()); } })).then(() => { docTextReady = true; });
    return docTextLoad;
}
// The search (#10093): the words may come in any order (every word must be in the topic's title or text), and the topics are ranked by where the words sit (#10303): the title first, then a heading, then a step or a
// paragraph, and a code line last (a search for "sleep" put a /bin/sleep line ahead of the page about putting agents to sleep). The snippet shows the best place a word is, not the first one.
const queryWords = () => docsQuery.split(/\s+/).filter(Boolean);
const docLines = new Map(); // topic name -> its lines with their kind: 2 a heading, 3 a step or paragraph, 4 code (a fenced block or an indented line)
function linesOf(d) {
    if (docLines.has(d.name)) return docLines.get(d.name);
    const out = []; let fence = false;
    for (const text of String(docRaw.get(d.name) || '').split('\n')) {
        if (/^\s*(```|~~~)/.test(text)) { fence = !fence; continue; }
        out.push({ text, low: text.toLowerCase(), noCode: text.toLowerCase().replace(/`[^`]*`/g, ' '), kind: fence || /^( {4}|\t)/.test(text) ? 4 : /^\s{0,3}#{1,6}\s/.test(text) ? 2 : 3 });
    }
    docLines.set(d.name, out);
    return out;
}
/** The best place a word is in a topic's text: { kind, line } (the first line of the best kind), or null. A word only inside an inline code span counts as code. */
function placeOf(d, word) {
    let best = null;
    for (const line of linesOf(d)) {
        if (!line.low.includes(word)) continue;
        const kind = line.kind === 3 && !line.noCode.includes(word) ? 4 : line.kind;
        if (!best || kind < best.kind) { best = { kind, line }; if (kind === 2) break; }
    }
    return best;
}
function hitOf(d) {
    const words = queryWords(); if (!words.length) return { rank: 0 };
    const title = `${titleOf(d)} ${d.name}`.toLowerCase(), body = docText.get(d.name) || '';
    if (!words.every(w => title.includes(w) || body.includes(w))) return null;
    if (words.every(w => title.includes(w))) return { rank: 0 };
    // the weakest word decides: every word must be somewhere good for the topic to rank high (1 title, 2 heading, 3 step or paragraph, 4 code)
    return { rank: Math.max(...words.map(w => (title.includes(w) ? 1 : (placeOf(d, w)?.kind ?? 4)))) };
}
/** What matched, for a hit that is in the topic's text and not all in its title: the line of the best place a word is (a heading, else a step, else code), about a line of it around the word, without the Markdown marks. '' for a title hit (its summary shows). */
function snippetOf(d) {
    const words = queryWords();
    if (!words.length || !docRaw.get(d.name) || hitOf(d)?.rank === 0) return '';
    let best = null;
    for (const w of words) { const p = placeOf(d, w); if (p && (!best || p.kind < best.kind)) best = { ...p, word: w }; }
    if (!best) return '';
    const raw = best.line.text, at = Math.max(0, best.line.low.indexOf(best.word));
    const from = Math.max(0, at - 50), to = Math.min(raw.length, at + 110);
    const text = raw.slice(from, to).replace(/^\s*#{1,6}\s+/, '').replace(/[#>*`|_\[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
    return `${from > 0 ? '\u2026' : ''}${text}${to < raw.length ? '\u2026' : ''}`;
}
const matches = d => hitOf(d) !== null;
const ranked = ds => (docsQuery ? [...ds].sort((a, b) => hitOf(a).rank - hitOf(b).rank) : ds);
const inGroupOrder = (g, ds) => (g.order ? [...ds].sort((a, b) => g.order(a) - g.order(b)) : ds); // a group with an order keeps it (the search puts title hits first within it)
const docGroups = () => DOC_GROUPS.map(g => ({ ...g, docs: ranked(inGroupOrder(g, docsList.filter(matches).filter(g.has))) })).filter(g => g.docs.length);
const groupOfDoc = name => { const d = docsList.find(x => x.name === name); const g = d && DOC_GROUPS.find(x => x.has(d)); return g ? { key: g.key, label: g.label } : null; };

export function filterDocs(value) {
    docsQuery = String(value || '').trim().toLowerCase(); renderDocNav();
    if (docsQuery && !docTextReady) { const q = docsQuery; loadDocText().then(() => { if (docsQuery === q) renderDocNav(); }); } // the topics' text arrives: the list is drawn again with what it matches
}

registerGroupSource('docs', {
    keys: () => docGroups().map(g => g.key),
    redraw: () => renderDocNav(),
    table: key => {
        const g = docGroups().find(x => x.key === key);
        if (!g) return null;
        if (!docTableStates.has(key)) docTableStates.set(key, DT.tableState());
        return { title: g.label, rows: g.docs, signature: JSON.stringify([docsQuery, g.docs.map(x => x.name)]),
            node: () => DT.dataTable({
                label: `${g.label} topics, ${g.docs.length}`, rows: g.docs,
                rowKey: d => d.name, rowName: titleOf, state: docTableStates.get(key),
                open: d => selectDoc(d.name, { focusHeading: true }),
                columns: [{ key: 'doc-name', label: 'Topic', primary: true, width: 'grow', line: 1, sort: true, sortValue: titleOf, cell: d => DT.primaryButton(titleOf(d)), subtitle: d => snippetOf(d) || String(d.summary || '').trim() }],
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
        docsLoaded = Array.isArray(list);
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
    const row = d => `<li class="session-list-item${escapeAttr(selectedDoc === d.name ? ' active' : '')}"><button type="button" class="row-btn" tabindex="${Number(d.name === stop ? 0 : -1)}"${selectedDoc === d.name ? ' aria-current="true"' : ''} data-on-click="doc-open" data-doc="${escapeAttr(d.name)}" data-on-keydown="doc-open-key"><span class="doc-nav-title">${esc(titleOf(d))}</span>${docsQuery && snippetOf(d) ? `<span class="doc-snippet">${esc(snippetOf(d))}</span>` : ''}</button></li>`; // under a hit that is in the topic's text: what matched (#10093)
    list.innerHTML = groups.map(g => groupHeaderHtml('docs', g.key, g.label, g.docs.length) + (isGroupFolded('docs', g.key) ? '' : g.docs.map(row).join(''))).join('')
        || (docsList.length || docsLoaded ? `<li class="empty-state empty-state-tight">${docsList.length ? (docsQuery && !docTextReady ? 'Searching the topics\u2026' : 'No topic matches. Try other words, or clear the search.') : 'No documentation found.'}</li>` : ''); // a build with none says so in the list too: a phone shows the list, not the content pane (#10266)
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
            const to = menuMove(event.key, all.length, at);
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
